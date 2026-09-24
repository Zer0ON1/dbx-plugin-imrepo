package main

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Tag rename: OCI has no rename primitive, so a rename is "write the manifest
// under the new tag, then drop the old one" — and only Harbor can drop one tag.

var tagPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)

// retag renames a tag, or copies it when the caller does not ask for removal.
//
// "Rename" on a container registry is really publish-under-the-new-tag then drop
// the old reference: OCI Distribution has no rename primitive, and deleting by
// digest would take down every tag pointing at that manifest — including the one
// we just created. Dropping a *single* tag is only possible through the Harbor
// REST API, so on any other registry we add the new tag, keep the old one and
// report that honestly instead of pretending the rename succeeded.

func retag(ctx context.Context, s *Session, params map[string]any) (any, error) {
	repo := strings.Trim(strings.TrimSpace(strParam(params, "repository")), "/")
	source := strings.TrimSpace(strParam(params, "sourceTag"))
	target := strings.TrimSpace(strParam(params, "targetTag"))

	switch {
	case repo == "":
		return nil, errors.New("repository is required")
	case source == "":
		return nil, errors.New("sourceTag is required")
	case target == "":
		return nil, errors.New("targetTag is required")
	case !tagPattern.MatchString(target):
		return nil, fmt.Errorf("invalid tag %q: a tag must match [A-Za-z0-9_][A-Za-z0-9._-]{0,127}", target)
	case source == target:
		return nil, fmt.Errorf("target tag %q is identical to the source tag", target)
	}

	if boolParam(params, "deleteSource") {
		// Checked before anything is written: refusing after the new tag exists
		// would leave a half-finished rename behind.
		if pat, blocked := s.tagProtected(source); blocked {
			return nil, fmt.Errorf("cannot complete the rename: %w", protectedTagError(source, pat))
		}
	}

	if err := s.Oci.Retag(ctx, repo, source, target); err != nil {
		return nil, err
	}

	res := map[string]any{"ok": true, "sourceTag": source, "targetTag": target, "sourceRemoved": false}
	if !boolParam(params, "deleteSource") {
		return res, nil
	}

	if s.RegistryType != registryTypeHarbor {
		res["warning"] = fmt.Sprintf(
			"new tag %q created, but the old tag %q was kept: OCI Distribution has no tag-scoped delete, remove it manually",
			target, source)
		return res, nil
	}

	project, short, ok := splitHarborRepo(repo)
	if !ok {
		res["warning"] = fmt.Sprintf(
			"new tag %q created, but the old tag %q could not be removed: %q is not a project/repository path",
			target, source, repo)
		return res, nil
	}
	if err := s.Harbor.DeleteTag(ctx, project, short, target, source); err != nil {
		res["warning"] = fmt.Sprintf("new tag %q created, but removing the old tag %q failed: %v", target, source, err)
		return res, nil
	}
	res["sourceRemoved"] = true
	return res, nil
}

// splitHarborRepo splits "project/repository". Harbor repository names contain
// exactly one slash, so the first one is the boundary.

func splitHarborRepo(full string) (project, repo string, ok bool) {
	i := strings.Index(full, "/")
	if i <= 0 || i == len(full)-1 {
		return "", "", false
	}
	return full[:i], full[i+1:], true
}

// verify checks reachability of the registry (OCI /v2/ and/or Harbor ping).
//
// On failure the message carries the concrete cause (dial error, TLS failure,
// HTTP status) instead of a generic string — when a plugin connection test
// fails the operator only ever sees this text, so it has to be diagnosable.
