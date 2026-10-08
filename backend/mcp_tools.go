package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Tool implementations.
//
// Every one of these drives the same function the workbench calls — createProject,
// retag, vulnerabilities, analyzeManifest — with arguments translated from the
// tool vocabulary (snake_case, documented in the schema) to the internal one. The
// translation is the only thing this file adds; the behaviour, including every
// guard, is the shared code path's.
//
// Two naming conventions meet here and are worth stating once: OCI Distribution
// endpoints (/v2/...) address a repository by its full "<project>/<repo>" path,
// while Harbor's REST API takes the bare repository name and the project
// separately. The UI does the same split; getting it backwards produces a 404
// rather than a subtle bug, which is at least loud.

// fullRepo is the "<project>/<repo>" form the /v2/ endpoints need.
func fullRepo(project, repo string) string { return project + "/" + repo }

func mcpListProjects(ctx context.Context, s *Session) (map[string]any, error) {
	if s.RegistryType == registryTypeHarbor {
		projects, err := s.Harbor.Projects(ctx)
		if err != nil {
			return nil, err
		}
		out := make([]map[string]any, 0, len(projects))
		for _, p := range projects {
			out = append(out, map[string]any{
				"project":      p.Name,
				"repositories": p.RepoCount,
				"public":       p.Public,
				"createdAt":    p.CreationTime,
			})
		}
		return jsonResult(map[string]any{
			"registry": s.BaseURL,
			"type":     "harbor",
			"projects": out,
			"note":     "This registry has project objects. Other tools take `project` as one of these names.",
		})
	}

	namespaces, err := s.Oci.Namespaces(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(namespaces))
	for _, n := range namespaces {
		out = append(out, map[string]any{"project": n.Name, "repositories": n.RepoCount})
	}
	return jsonResult(map[string]any{
		"registry": s.BaseURL,
		"type":     "docker-v2",
		"projects": out,
		"note":     "A plain OCI v2 registry has no project objects; these are the first path segments of its repository names, grouped. Nothing here can be created or configured — the grouping is a view, not a record.",
	})
}

func mcpListRepositories(ctx context.Context, s *Session, args map[string]any) (map[string]any, error) {
	project, err := projectArg(args)
	if err != nil {
		return nil, err
	}
	if s.RegistryType == registryTypeHarbor {
		repos, err := s.Harbor.Repositories(ctx, project)
		if err != nil {
			return nil, err
		}
		out := make([]map[string]any, 0, len(repos))
		for _, r := range repos {
			out = append(out, map[string]any{
				"repository": r.Name,
				"artifacts":  r.ArtifactCount,
				"pulls":      r.PullCount,
				"updatedAt":  r.UpdateTime,
			})
		}
		return jsonResult(map[string]any{"project": project, "repositories": out})
	}

	repos, err := s.Oci.ReposInNamespace(ctx, project)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(repos))
	for _, r := range repos {
		out = append(out, map[string]any{"repository": r.FullName})
	}
	return jsonResult(map[string]any{"project": project, "repositories": out})
}

// tagRow is one tag as the assistant sees it.
type tagRow struct {
	Tag      string   `json:"tag"`
	Digest   string   `json:"digest,omitempty"`
	Size     int64    `json:"sizeBytes,omitempty"`
	PushedAt string   `json:"pushedAt,omitempty"`
	Arches   []string `json:"architectures,omitempty"`
	Untagged bool     `json:"untagged,omitempty"`
}

func mcpListTags(ctx context.Context, s *Session, args map[string]any) (map[string]any, error) {
	project, err := projectArg(args)
	if err != nil {
		return nil, err
	}
	repo, err := repoArg(args)
	if err != nil {
		return nil, err
	}
	limit := intParam(args, "limit")
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	rows, total, err := collectTagRows(ctx, s, project, repo, limit)
	if err != nil {
		return nil, err
	}
	result := map[string]any{
		"project":    project,
		"repository": repo,
		"tags":       rows,
		"returned":   len(rows),
		"total":      total,
	}
	if len(rows) < total {
		result["note"] = fmt.Sprintf("showing the %d most recent of %d tags; raise `limit` (max 200) to see more", len(rows), total)
	}
	return jsonResult(result)
}

// collectTagRows gathers tags newest first.
//
// The two registry types answer differently: Harbor lists artifacts and each
// artifact carries its tags and architectures, while a v2 registry lists tag
// names and needs one manifest read per tag to learn anything about them. That
// second cost is why the enrichment is bounded — a repository with hundreds of
// tags must not turn one tool call into hundreds of requests.
func collectTagRows(ctx context.Context, s *Session, project, repo string, limit int) ([]tagRow, int, error) {
	const enrichLimit = 40

	if s.RegistryType == registryTypeHarbor {
		arts, err := s.Harbor.Artifacts(ctx, project, repo)
		if err != nil {
			return nil, 0, err
		}
		rows := []tagRow{}
		for _, a := range arts {
			if len(a.Tags) == 0 {
				rows = append(rows, tagRow{Digest: a.Digest, Size: a.Size, PushedAt: a.PushTime, Arches: a.Arches, Untagged: true})
				continue
			}
			for _, t := range a.Tags {
				pushed := t.PushTime
				if pushed == "" {
					pushed = a.PushTime
				}
				rows = append(rows, tagRow{Tag: t.Name, Digest: a.Digest, Size: a.Size, PushedAt: pushed, Arches: a.Arches})
			}
		}
		// Newest first, which is what a person means by "the latest tag".
		sort.SliceStable(rows, func(i, j int) bool { return rows[i].PushedAt > rows[j].PushedAt })
		total := len(rows)
		if len(rows) > limit {
			rows = rows[:limit]
		}
		return rows, total, nil
	}

	tags, err := s.Oci.Tags(ctx, fullRepo(project, repo))
	if err != nil {
		return nil, 0, err
	}
	// A v2 tags/list carries no order worth trusting; the names here are
	// timestamps, so sorting them descending is the closest thing to "newest".
	sort.Sort(sort.Reverse(sort.StringSlice(tags)))
	total := len(tags)
	if len(tags) > limit {
		tags = tags[:limit]
	}

	rows := make([]tagRow, 0, len(tags))
	for i, name := range tags {
		row := tagRow{Tag: name}
		if i < enrichLimit {
			// One manifest read answers both the digest and the architectures.
			if arches, digest, err := archesFor(ctx, s, fullRepo(project, repo), name); err == nil {
				row.Arches = arches
				row.Digest = digest
			}
		}
		rows = append(rows, row)
	}
	return rows, total, nil
}

func mcpImageInfo(ctx context.Context, s *Session, args map[string]any) (map[string]any, error) {
	project, err := projectArg(args)
	if err != nil {
		return nil, err
	}
	repo, err := repoArg(args)
	if err != nil {
		return nil, err
	}
	ref := strings.TrimSpace(strParam(args, "reference"))
	if ref == "" {
		return nil, errors.New("`reference` is required — a tag or a manifest digest")
	}

	// Same call the layers dialog makes, so the numbers cannot disagree between
	// the two surfaces.
	info, err := analyzeManifest(ctx, s, fullRepo(project, repo), ref)
	if err != nil {
		return nil, err
	}
	m, _ := info.(map[string]any)
	layers, _ := m["layers"].([]layerOut)
	return jsonResult(map[string]any{
		"project":    project,
		"repository": repo,
		"reference":  ref,
		"digest":     m["digest"],
		"mediaType":  m["mediaType"],
		"platform":   m["platform"],
		"layers":     len(layers),
		"totalSize":  m["totalSize"],
	})
}

func mcpVulnerabilities(ctx context.Context, s *Session, args map[string]any) (map[string]any, error) {
	project, err := projectArg(args)
	if err != nil {
		return nil, err
	}
	repo, err := repoArg(args)
	if err != nil {
		return nil, err
	}
	ref := strings.TrimSpace(strParam(args, "reference"))
	if ref == "" {
		return nil, errors.New("`reference` is required — a tag or a manifest digest")
	}
	if s.RegistryType != registryTypeHarbor {
		return nil, errors.New("vulnerability reports need Harbor's scanner API; this connection is a plain OCI v2 registry, which has no equivalent endpoint")
	}
	report, err := vulnerabilities(ctx, s, map[string]any{
		"project": project, "repository": repo, "reference": ref,
	})
	if err != nil {
		return nil, err
	}
	return jsonResult(report)
}

func mcpCreateProject(ctx context.Context, s *Session, args map[string]any) (map[string]any, error) {
	name := strings.TrimSpace(strParam(args, "project"))
	if name == "" {
		return nil, errors.New("`project` is required")
	}
	// Delegates, so the name validation and the 409-means-exists handling are
	// the same ones the workbench gets.
	res, err := createProject(ctx, s, map[string]any{"name": name, "public": boolParam(args, "public")})
	if err != nil {
		return nil, err
	}
	return jsonResult(res)
}

func mcpSetProjectPublic(ctx context.Context, s *Session, args map[string]any) (map[string]any, error) {
	project, err := projectArg(args)
	if err != nil {
		return nil, err
	}
	if s.RegistryType != registryTypeHarbor {
		return nil, errors.New("project visibility is a Harbor concept; a plain OCI v2 registry has no project object")
	}
	if _, ok := args["public"]; !ok {
		return nil, errors.New("`public` is required (true or false)")
	}
	if err := s.Harbor.SetProjectPublic(ctx, project, boolParam(args, "public")); err != nil {
		return nil, err
	}
	return jsonResult(map[string]any{"project": project, "public": boolParam(args, "public"), "ok": true})
}

func mcpRetag(ctx context.Context, s *Session, args map[string]any) (map[string]any, error) {
	project, err := projectArg(args)
	if err != nil {
		return nil, err
	}
	repo, err := repoArg(args)
	if err != nil {
		return nil, err
	}
	source := strings.TrimSpace(strParam(args, "source_tag"))
	target := strings.TrimSpace(strParam(args, "target_tag"))
	if source == "" || target == "" {
		return nil, errors.New("`source_tag` and `target_tag` are required")
	}
	// The default differs from the UI's: an assistant renaming a tag almost
	// always means "rename", and leaving the old tag behind would make the
	// operation look like it failed. On a v2 registry retag() reports the
	// leftover as a warning either way.
	deleteSource := true
	if v, ok := args["delete_source"]; ok {
		deleteSource = v == true || v == "true"
	}
	res, err := retag(ctx, s, map[string]any{
		"repository":   fullRepo(project, repo),
		"sourceTag":    source,
		"targetTag":    target,
		"deleteSource": deleteSource,
	})
	if err != nil {
		return nil, err
	}
	return jsonResult(res)
}

func mcpDeleteTag(ctx context.Context, s *Session, args map[string]any) (map[string]any, error) {
	project, err := projectArg(args)
	if err != nil {
		return nil, err
	}
	repo, err := repoArg(args)
	if err != nil {
		return nil, err
	}
	tag := strings.TrimSpace(strParam(args, "tag"))
	if tag == "" {
		return nil, errors.New("`tag` is required")
	}

	// The retention policy is checked here for the same reason the RPC dispatch
	// checks it: the host's confirmation guards against the model acting by
	// mistake, and does not know what this plugin considers protected.
	if pattern, blocked := s.tagProtected(tag); blocked {
		return nil, fmt.Errorf("tag %q is protected by the retention policy (%s) and will not be deleted; change the policy in the plugin settings if that is intended", tag, pattern)
	}

	if s.RegistryType == registryTypeHarbor {
		if err := s.Harbor.DeleteTag(ctx, project, repo, tag, tag); err != nil {
			return nil, err
		}
		return jsonResult(map[string]any{
			"project": project, "repository": repo, "deleted": tag, "ok": true,
			"note": "the image is now unlinked; the registry reclaims the space at its next garbage collection",
		})
	}

	// OCI has no tag-level delete, so the digest has to be resolved first and
	// the whole manifest removed — which takes every other tag pointing at it.
	man, err := s.Oci.Manifest(ctx, fullRepo(project, repo), tag)
	if err != nil {
		return nil, err
	}
	if err := s.Oci.Delete(ctx, fullRepo(project, repo), man.Digest); err != nil {
		return nil, err
	}
	return jsonResult(map[string]any{
		"project": project, "repository": repo, "deleted": tag, "digest": man.Digest, "ok": true,
		"note": "OCI v2 deletes by digest, so any other tag pointing at this manifest was removed as well",
	})
}
