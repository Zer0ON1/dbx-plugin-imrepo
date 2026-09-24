package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// projectAdmin aggregates a project's administration state in one read so the
// settings dialog opens without a flurry of round-trips. Any part that fails
// (e.g. listing users without admin rights) is reported as a named error field,
// never as a failure of the whole panel.
func projectAdmin(ctx context.Context, s *Session, project string) (map[string]any, error) {
	out := map[string]any{"projectName": project}
	var retentionID int64

	if detail, err := s.Harbor.ProjectDetail(ctx, project); err != nil {
		out["projectError"] = err.Error()
	} else {
		retentionID = detail.RetentionID
		out["project"] = map[string]any{
			"projectId":   detail.ProjectID,
			"name":        detail.Name,
			"public":      detail.Public,
			"retentionId": detail.RetentionID,
			"metadata":    detail.Metadata,
		}
	}

	if members, err := s.Harbor.Members(ctx, project); err != nil {
		out["membersError"] = err.Error()
	} else {
		out["members"] = members
	}

	if retentionID != 0 {
		if pol, err := s.Harbor.Retention(ctx, retentionID); err != nil {
			out["retentionError"] = err.Error()
		} else {
			out["retention"] = pol
		}
	} else {
		out["retention"] = nil
	}

	if users, err := s.Harbor.Users(ctx); err != nil {
		out["usersError"] = err.Error()
	} else {
		out["users"] = users
	}

	return out, nil
}

// addMember grants a user a role on a project.
func addMember(ctx context.Context, s *Session, params map[string]any) (any, error) {
	project := strings.TrimSpace(strParam(params, "project"))
	roleID := intParam(params, "roleId")
	username := strings.TrimSpace(strParam(params, "username"))
	if project == "" || username == "" || roleID == 0 {
		return nil, errors.New("project, roleId and username are required")
	}
	return map[string]any{"ok": true}, s.Harbor.AddMember(ctx, project, roleID, username)
}

// saveRetention writes a project's retention policy. The whole policy is
// submitted (Harbor has no partial patch); the "先读已有，后写改动" contract is
// that the UI fetched the current policy first and only mutates what the
// operator changed.
func saveRetention(ctx context.Context, s *Session, params map[string]any) (any, error) {
	project := strings.TrimSpace(strParam(params, "project"))
	if project == "" {
		return nil, errors.New("project is required")
	}
	projectID := intParam(params, "projectId")

	var policy HarborRetention
	if raw, ok := params["policy"].(map[string]any); ok {
		b, _ := json.Marshal(raw)
		if err := json.Unmarshal(b, &policy); err != nil {
			return nil, fmt.Errorf("invalid retention policy: %w", err)
		}
	}
	if len(policy.Rules) == 0 {
		return nil, errors.New("a retention policy needs at least one rule")
	}
	if err := s.Harbor.SaveRetention(ctx, project, projectID, &policy); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "retentionId": policy.ID}, nil
}
