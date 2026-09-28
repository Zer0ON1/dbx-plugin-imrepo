package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// ---------------------------------------------------------------------------
// Docker Registry v2 "project" view
//
// The OCI v2 protocol has no project object — only a flat repository catalog.
// In practice repositories are namespaced ("team-a/app", "team-a/db", …) and the
// first path segment acts as the project. This file presents those namespaces as
// projects so a plain v2 registry gets the same folder-first browsing model the
// Harbor mode already has.
// ---------------------------------------------------------------------------

// V2Project is one namespace (first path segment of repository names).
type V2Project struct {
	Name      string `json:"name"`
	RepoCount int64  `json:"repo_count"`
}

// V2Repo is one repository under a namespace.
type V2Repo struct {
	Name     string `json:"name"`      // short name within the namespace
	FullName string `json:"full_name"` // namespace/name (OCI /v2/ path)
}

// V2RepoSummary aggregates one repository: distinct images (manifest digests),
// tags and summed image size.
type V2RepoSummary struct {
	Name       string `json:"name"`
	FullName   string `json:"full_name"`
	ImageCount int    `json:"imageCount"`
	TagCount   int    `json:"tagCount"`
	Size       int64  `json:"size"`
}

// V2ProjectOverview is the namespace-level image overview (analogous to
// Harbor's ProjectImages).
type V2ProjectOverview struct {
	Namespace  string          `json:"namespace"`
	RepoCount  int             `json:"repoCount"`
	ImageCount int             `json:"imageCount"`
	TagCount   int             `json:"tagCount"`
	TotalSize  int64           `json:"totalSize"`
	Repos      []V2RepoSummary `json:"repos"`
	Truncated  bool            `json:"truncated"`
	Errors     []string        `json:"errors,omitempty"`
}

// V2Overview is the registry-wide dashboard for a v2 registry (no audit log, so
// no pull counts — sizes and counts only).
type V2Overview struct {
	NamespaceCount  int              `json:"namespaceCount"`
	RepoCount       int              `json:"repoCount"`
	ImageCount      int              `json:"imageCount"`
	TagCount        int              `json:"tagCount"`
	TotalSize       int64            `json:"totalSize"`
	SizeByNamespace []map[string]any `json:"sizeByNamespace,omitempty"`
	Namespaces      []V2Project      `json:"namespaces,omitempty"`
	Truncated       bool             `json:"truncated"`
	Errors          []string         `json:"errors,omitempty"`
}

const (
	v2MaxReposPerWalk = 200
	v2MaxTagsPerRepo  = 50
	v2WalkWorkers     = 6
)

// namespaceOf returns the first path segment of a repository name, or the whole
// name for a flat (namespace-less) repository — a flat repo is its own project.
func namespaceOf(repo string) string {
	repo = strings.TrimSpace(repo)
	if i := strings.IndexByte(repo, '/'); i > 0 {
		return repo[:i]
	}
	return repo
}

// Namespaces groups the whole catalog into namespaces, sorted by name.
func (c *OciClient) Namespaces(ctx context.Context) ([]V2Project, error) {
	repos, err := c.Catalog(ctx, "")
	if err != nil {
		return nil, err
	}
	counts := map[string]int64{}
	for _, r := range repos {
		counts[namespaceOf(r)]++
	}
	out := make([]V2Project, 0, len(counts))
	for name, n := range counts {
		out = append(out, V2Project{Name: name, RepoCount: n})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// ReposInNamespace lists the repositories under one namespace, sorted by name.
func (c *OciClient) ReposInNamespace(ctx context.Context, namespace string) ([]V2Repo, error) {
	repos, err := c.Catalog(ctx, "")
	if err != nil {
		return nil, err
	}
	out := make([]V2Repo, 0, 8)
	for _, r := range repos {
		if namespaceOf(r) != namespace {
			continue
		}
		name := r
		if strings.HasPrefix(r, namespace+"/") {
			name = strings.TrimPrefix(r, namespace+"/")
		}
		out = append(out, V2Repo{Name: name, FullName: r})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

type v2RepoRef struct {
	namespace string
	full      string
	name      string
}

type v2RepoResult struct {
	ref        v2RepoRef
	imageCount int
	tagCount   int
	size       int64
	err        error
}

// walkV2Repos lists the tags of every repo and, per repo, dedupes images by
// manifest digest before summing sizes — so several tags pointing at one image
// are counted once. Per-repo failures are reported, not fatal.
func (c *OciClient) walkV2Repos(ctx context.Context, refs []v2RepoRef) []v2RepoResult {
	results := make([]v2RepoResult, len(refs))
	poolMap(v2WalkWorkers, len(refs), func(i int) {
		tags, err := c.Tags(ctx, refs[i].full)
		if err != nil {
			results[i].err = err
			return
		}
		if len(tags) > v2MaxTagsPerRepo {
			tags = tags[:v2MaxTagsPerRepo]
		}
		results[i].ref = refs[i]
		results[i].tagCount = len(tags)
		seen := map[string]bool{}
		for _, tg := range tags {
			dg, size, err := c.manifestInfo(ctx, refs[i].full, tg)
			if err != nil {
				continue // an unreadable tag is skipped, never fatal to the repo
			}
			if dg == "" {
				dg = "sha256:" + tg
			}
			if seen[dg] {
				continue
			}
			seen[dg] = true
			results[i].size += size
		}
		results[i].imageCount = len(seen)
	})
	return results
}

// archesFor reports the architectures of one image reference. A manifest list
// answers from its entries; a single-arch manifest from the architecture field
// of its config blob.
// archesFor reads one tag's manifest and answers both things the tag tables
// want from it: the architectures it contains, and its digest.
//
// The digest comes along for free — a v2 tags/list carries only names, so
// showing a sha256 per tag would otherwise cost a separate HEAD per row, and
// this call already fetches the manifest.
func archesFor(ctx context.Context, s *Session, repo, ref string) ([]string, string, error) {
	mr, err := s.Oci.Manifest(ctx, repo, ref)
	if err != nil {
		return nil, "", err
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(mr.Body), &doc); err != nil {
		return nil, "", err
	}
	seen := map[string]bool{}
	var out []string
	add := func(a string) {
		a = strings.TrimSpace(a)
		if a == "" || seen[a] {
			return
		}
		seen[a] = true
		out = append(out, a)
	}
	if entries, ok := doc["manifests"].([]any); ok {
		for _, e := range entries {
			em, _ := e.(map[string]any)
			pm, _ := em["platform"].(map[string]any)
			arch, _ := pm["architecture"].(string)
			add(arch)
		}
	}
	if len(out) == 0 {
		cfg, _ := doc["config"].(map[string]any)
		dg, _ := cfg["digest"].(string)
		if dg != "" {
			if blob, err := s.Oci.Blob(ctx, repo, dg); err == nil {
				var cd map[string]any
				if json.Unmarshal(blob, &cd) == nil {
					arch, _ := cd["architecture"].(string)
					add(arch)
				}
			}
		}
	}
	return out, mr.Digest, nil
}

func v2ProjectOverview(ctx context.Context, s *Session, namespace string) (*V2ProjectOverview, error) {
	repos, err := s.Oci.ReposInNamespace(ctx, namespace)
	if err != nil {
		return nil, err
	}
	out := &V2ProjectOverview{Namespace: namespace, Repos: []V2RepoSummary{}}
	if len(repos) > v2MaxReposPerWalk {
		repos = repos[:v2MaxReposPerWalk]
		out.Truncated = true
	}
	refs := make([]v2RepoRef, len(repos))
	for i, r := range repos {
		refs[i] = v2RepoRef{namespace: namespace, full: r.FullName, name: r.Name}
	}
	for _, res := range s.Oci.walkV2Repos(ctx, refs) {
		if res.err != nil {
			out.Errors = append(out.Errors, fmt.Sprintf("%s: %v", res.ref.name, res.err))
			continue
		}
		out.Repos = append(out.Repos, V2RepoSummary{
			Name: res.ref.name, FullName: res.ref.full,
			ImageCount: res.imageCount, TagCount: res.tagCount, Size: res.size,
		})
		out.ImageCount += res.imageCount
		out.TagCount += res.tagCount
		out.TotalSize += res.size
	}
	out.RepoCount = len(out.Repos)
	sort.SliceStable(out.Repos, func(i, j int) bool { return out.Repos[i].Size > out.Repos[j].Size })
	return out, nil
}

func v2Overview(ctx context.Context, s *Session) (*V2Overview, error) {
	namespaces, err := s.Oci.Namespaces(ctx)
	if err != nil {
		return nil, err
	}
	out := &V2Overview{NamespaceCount: len(namespaces), Namespaces: namespaces}

	refs := make([]v2RepoRef, 0, 64)
	for _, ns := range namespaces {
		repos, err := s.Oci.ReposInNamespace(ctx, ns.Name)
		if err != nil {
			out.Errors = append(out.Errors, fmt.Sprintf("%s: %v", ns.Name, err))
			continue
		}
		for _, r := range repos {
			refs = append(refs, v2RepoRef{namespace: ns.Name, full: r.FullName, name: r.Name})
		}
	}
	out.RepoCount = len(refs)
	if len(refs) > v2MaxReposPerWalk {
		refs = refs[:v2MaxReposPerWalk]
		out.Truncated = true
	}

	nsSize := map[string]int64{}
	for _, res := range s.Oci.walkV2Repos(ctx, refs) {
		if res.err != nil {
			out.Errors = append(out.Errors, fmt.Sprintf("%s: %v", res.ref.full, res.err))
			continue
		}
		out.ImageCount += res.imageCount
		out.TagCount += res.tagCount
		out.TotalSize += res.size
		nsSize[res.ref.namespace] += res.size
	}

	type ns struct {
		name string
		size int64
	}
	ranked := make([]ns, 0, len(nsSize))
	for n, sz := range nsSize {
		ranked = append(ranked, ns{n, sz})
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].size > ranked[j].size })
	if len(ranked) > 8 {
		ranked = ranked[:8]
	}
	for _, r := range ranked {
		out.SizeByNamespace = append(out.SizeByNamespace, map[string]any{"name": r.name, "size": r.size})
	}
	return out, nil
}
