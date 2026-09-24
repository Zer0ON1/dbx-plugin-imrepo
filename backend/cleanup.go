package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Removing artifacts that carry no tag. Destructive, so the scan and the delete
// both re-check the rules — see the safety notes in HarborClient.Untagged.

func cleanupUntagged(ctx context.Context, s *Session, params map[string]any) (any, error) {
	project := strings.TrimSpace(strParam(params, "project"))
	if project == "" {
		return nil, errors.New("project is required")
	}

	targets := []map[string]any{}
	if raw, ok := params["targets"].([]any); ok {
		for _, t := range raw {
			if m, ok := t.(map[string]any); ok {
				targets = append(targets, m)
			}
		}
	}
	switch {
	case len(targets) == 0:
		return nil, errors.New("no targets given")
	case len(targets) > maxCleanupBatch:
		return nil, fmt.Errorf("refusing to delete %d artifacts in one call (limit %d)", len(targets), maxCleanupBatch)
	}

	set, _ := settingsFor(s.Conn.ID)
	rules := set.Cleanup
	now := time.Now()

	deleted := []map[string]any{}
	skipped := []map[string]any{}
	failed := []map[string]any{}
	var reclaimed int64

	// Group by repository: the "keep the newest N" rule ranks within a
	// repository, so its listing is fetched once per repository rather than once
	// per target.
	order := []string{}
	byRepo := map[string][]map[string]any{}
	for _, t := range targets {
		repo := strings.Trim(strings.TrimSpace(strParam(t, "repository")), "/")
		if _, seen := byRepo[repo]; !seen {
			order = append(order, repo)
		}
		byRepo[repo] = append(byRepo[repo], t)
	}

	for _, repo := range order {
		var listing []HarborArtifact
		var listErr error
		if repo != "" {
			listing, listErr = s.Harbor.Artifacts(ctx, project, repo)
			if listErr != nil {
				// Without the listing the reservation rule cannot be checked, and
				// guessing is not an option for a delete.
				for _, t := range byRepo[repo] {
					skipped = append(skipped, map[string]any{
						"repository": repo,
						"reference":  strings.TrimSpace(strParam(t, "reference")),
						"reason":     "could not re-read the repository: " + listErr.Error(),
					})
				}
				continue
			}
		}
		for _, t := range byRepo[repo] {
			ref := strings.TrimSpace(strParam(t, "reference"))
			size := int64(0)
			if v, ok := t["size"].(float64); ok {
				size = int64(v)
			}
			entry := map[string]any{"repository": repo, "reference": ref}
			if repo == "" || ref == "" {
				entry["error"] = "repository and reference are required"
				failed = append(failed, entry)
				continue
			}

			art, err := s.Harbor.Artifact(ctx, project, repo, ref)
			if err != nil {
				entry["reason"] = err.Error()
				skipped = append(skipped, entry)
				continue
			}
			if art == nil {
				entry["reason"] = "the artifact no longer exists"
				skipped = append(skipped, entry)
				continue
			}
			if len(art.Tags) > 0 {
				entry["reason"] = "a tag now points at this artifact"
				skipped = append(skipped, entry)
				continue
			}
			probe := UntaggedArtifact{Repository: repo, Digest: ref, Size: size, PushTime: art.PushTime}
			if reason, blocked := protectedUnderRules(probe, listing, rules, project, repo, now); blocked {
				entry["reason"] = "blocked by the cleanup rules: " + reason
				skipped = append(skipped, entry)
				continue
			}
			if err := s.Harbor.DeleteArtifact(ctx, project, repo, ref); err != nil {
				entry["error"] = err.Error()
				failed = append(failed, entry)
				continue
			}
			deleted = append(deleted, entry)
			reclaimed += size
		}
	}

	return map[string]any{
		"ok":             len(failed) == 0,
		"deleted":        deleted,
		"deletedCount":   len(deleted),
		"reclaimedBytes": reclaimed,
		"skipped":        skipped,
		"failed":         failed,
	}, nil
}

// tagPattern is the OCI image tag grammar: [A-Za-z0-9_][A-Za-z0-9._-]{0,127}.
