package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// This file is the RPC surface: the method tables below are the complete list of
// what the sidecar answers, and everything else in the package is a dependency
// of it.
//
// Handlers come in two shapes, because not every method needs a registry
// session — identity, settings and the connection lifecycle must work before
// (or without) a usable connection:
//
//	plainHandler   — no session; the method manages connections or settings
//	sessionHandler — the connection's session is resolved from the params first
//
// Resolving the session used to be four copied lines at the top of each of the
// 42 session cases; the table does it once, so a handler can assume the session
// exists and only worry about its own arguments.
type (
	plainHandler   func(ctx context.Context, params map[string]any) (any, error)
	sessionHandler func(ctx context.Context, s *Session, params map[string]any) (any, error)
)

// harborOnly marks a handler that needs Harbor's REST API rather than plain OCI
// Distribution. Wrapping the entry (instead of calling requireHarbor inside the
// handler) keeps the requirement visible in the method table, which is where
// someone looks to find out whether a method works against a bare registry.
func harborOnly(h sessionHandler) sessionHandler {
	return func(ctx context.Context, s *Session, params map[string]any) (any, error) {
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		return h(ctx, s, params)
	}
}

// errProjectRequired is shared so every method that needs a project reports the
// same thing (this message was previously written out at eleven call sites).
var errProjectRequired = errors.New("project is required")

// requiredProject reads the project a Harbor call is scoped to.
func requiredProject(params map[string]any) (string, error) {
	project := strings.TrimSpace(strParam(params, "project"))
	if project == "" {
		return "", errProjectRequired
	}
	return project, nil
}

// required returns a non-empty string parameter, or an error naming the key.
func required(params map[string]any, key string) (string, error) {
	value := strings.TrimSpace(strParam(params, key))
	if value == "" {
		return "", errors.New(key + " is required")
	}
	return value, nil
}

// plainMethods are answered without touching a registry session.
var plainMethods = map[string]plainHandler{
	// identity & settings
	"app/info":            appInfo,
	"settings/get":        settingsGet,
	"settings/set":        settingsSet,
	"settings/reset":      settingsReset,
	"settings/getProject": settingsGetProject,
	"settings/setProject": settingsSetProject,

	// MCP tools for DBX's assistant. Deliberately plain handlers rather than
	// session handlers: the connection travels in `lifecycle` inside the request
	// body, the same payload connection/connect gets, so there is no session to
	// resolve from an id — mcpSession builds it from that payload.
	"mcp/tools": handleMCPTools,
	"mcp/call":  handleMCPCall,

	// connection lifecycle (normally driven by the host)
	"connection/test":       func(ctx context.Context, p map[string]any) (any, error) { return handleConnect(ctx, p, true) },
	"connection/connect":    func(ctx context.Context, p map[string]any) (any, error) { return handleConnect(ctx, p, false) },
	"connection/disconnect": connectionDisconnect,
	"connection/action":     handleAction,
}

// sessionMethods need the connection's session. `harborOnly` marks the ones that
// additionally require Harbor's API.
var sessionMethods = map[string]sessionHandler{
	// ---- OCI Registry v2 (Harbor serves /v2/ too) ---------------------------
	"registry/info":         registryInfo,
	"registry/catalog":      registryCatalog,
	"registry/namespaces":   registryNamespaces,
	"registry/repositories": registryRepositories,
	"registry/images":       registryImages,
	"registry/arches":       registryArches,
	"registry/overview":     func(ctx context.Context, s *Session, _ map[string]any) (any, error) { return v2Overview(ctx, s) },
	"registry/tags":         registryTags,
	"registry/manifest":     registryManifest,
	"registry/layers":       registryLayers,
	"registry/retag":        func(ctx context.Context, s *Session, p map[string]any) (any, error) { return retag(ctx, s, p) },
	"registry/delete":       registryDelete,

	// ---- Harbor REST API v2.0 ----------------------------------------------
	"harbor/projects":        func(ctx context.Context, s *Session, _ map[string]any) (any, error) { return s.Harbor.Projects(ctx) },
	"harbor/repositories":    harborRepositories,
	"harbor/artifacts":       harborArtifacts,
	"harbor/images":          harborOnly(harborImages),
	"harbor/deleteTag":       harborDeleteTag,
	"harbor/untagged":        harborOnly(harborUntagged),
	"harbor/cleanupUntagged": harborOnly(cleanupUntagged),
	"harbor/deleteArtifact":  harborDeleteArtifact,
	"harbor/vulnerabilities": vulnerabilities,
	"harbor/scannerInfo":     scannerInfo,
	"harbor/applyScanner":    applyScanner,
	"harbor/scan":            triggerScan,

	// project administration
	"harbor/projectAdmin":     harborOnly(harborProjectAdmin),
	"harbor/projectCreate":    createProject,
	"harbor/projectSetPublic": harborOnly(harborProjectSetPublic),
	"harbor/quotaGet":         quotaGet,
	"harbor/quotaSet":         quotaSet,
	"harbor/retentionSave":    harborOnly(saveRetention),
	"harbor/logs":             harborLogs,
	// Harbor's own registry GC — what reclaims the blobs that artifact
	// deletions orphan.
	"harbor/gcGet":        harborOnly(func(ctx context.Context, s *Session, _ map[string]any) (any, error) { return gcGet(ctx, s) }),
	"harbor/gcSet":        harborOnly(gcSet),
	"harbor/gcTrigger":    harborOnly(gcTrigger),
	"harbor/overview":     registryOverview,
	"harbor/memberAdd":    harborOnly(addMember),
	"harbor/memberRole":   harborOnly(harborMemberRole),
	"harbor/memberRemove": harborOnly(harborMemberRemove),

	// user management
	"harbor/users":        harborOnly(func(ctx context.Context, s *Session, _ map[string]any) (any, error) { return s.Harbor.Users(ctx) }),
	"harbor/currentUser":  harborOnly(harborCurrentUser),
	"harbor/userCreate":   harborOnly(harborUserCreate),
	"harbor/userPassword": harborOnly(harborUserPassword),
	"harbor/userDelete":   harborOnly(harborUserDelete),
	"harbor/userAdmin":    harborOnly(harborUserAdmin),
}

// handle routes one RPC to its handler. Unknown methods are reported as
// -32601 by the caller, which is what makes a typo in a method name visible
// instead of silently returning an empty result.
func handle(ctx context.Context, method string, params map[string]any) (any, error) {
	if h, ok := plainMethods[method]; ok {
		return h(ctx, params)
	}
	if h, ok := sessionMethods[method]; ok {
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return h(ctx, s, params)
	}
	return nil, &methodNotFoundError{method: method}
}

// ---------------------------------------------------------------------------
// identity & settings
// ---------------------------------------------------------------------------

func appInfo(_ context.Context, _ map[string]any) (any, error) {
	id, version := pluginIdentity()
	path, _ := settingsPath()
	return map[string]any{
		"pluginId":        id,
		"version":         version,
		"protocolVersion": 1,
		"transport":       "stdio-jsonl",
		"settingsPath":    path,
		"github":          githubURL,
	}, nil
}

func settingsGet(_ context.Context, params map[string]any) (any, error) {
	connID := settingsConnID(params)
	set, stored := settingsFor(connID)
	path, _ := settingsPath()
	return map[string]any{
		"settings":     set,
		"connectionId": connID,
		"isDefault":    !stored,
		"path":         path,
	}, nil
}

func settingsSet(_ context.Context, params map[string]any) (any, error) {
	connID := settingsConnID(params)
	set, err := decodeObject[Settings](params, "settings")
	if err != nil {
		return nil, err
	}
	if err := saveSettingsFor(connID, set); err != nil {
		return nil, err
	}
	saved, _ := settingsFor(connID)
	path, _ := settingsPath()
	return map[string]any{
		"settings":     saved,
		"connectionId": connID,
		"path":         path,
		"message":      "Settings saved",
	}, nil
}

func settingsReset(_ context.Context, params map[string]any) (any, error) {
	connID := settingsConnID(params)
	if err := resetSettingsFor(connID); err != nil {
		return nil, err
	}
	return map[string]any{
		"settings":     defaultSettings(),
		"connectionId": connID,
		"message":      "Settings reset to defaults",
	}, nil
}

func settingsGetProject(_ context.Context, params map[string]any) (any, error) {
	connID := settingsConnID(params)
	project, err := requiredProject(params)
	if err != nil {
		return nil, err
	}
	scanner, explicit := projectScannerSettings(connID, project)
	return map[string]any{
		"project":      project,
		"connectionId": connID,
		"scanner":      scanner,
		"isDefault":    !explicit,
	}, nil
}

func settingsSetProject(_ context.Context, params map[string]any) (any, error) {
	connID := settingsConnID(params)
	project, err := requiredProject(params)
	if err != nil {
		return nil, err
	}
	scanner, err := decodeObject[ScannerSettings](params, "scanner")
	if err != nil {
		return nil, err
	}
	if err := saveProjectScanner(connID, project, scanner); err != nil {
		return nil, err
	}
	saved, _ := projectScannerSettings(connID, project)
	return map[string]any{
		"project":      project,
		"connectionId": connID,
		"scanner":      saved,
		"message":      "Project settings saved",
	}, nil
}

// decodeObject turns a nested JSON object parameter into a typed struct. The
// round-trip through JSON keeps the wire field names authoritative (the structs
// are the same ones the settings file uses), instead of hand-mapping every key.
func decodeObject[T any](params map[string]any, key string) (T, error) {
	var out T
	raw, ok := params[key].(map[string]any)
	if !ok {
		return out, errors.New(key + " object is required")
	}
	blob, err := json.Marshal(raw)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(blob, &out); err != nil {
		return out, fmt.Errorf("invalid %s payload: %w", key, err)
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// connection lifecycle
// ---------------------------------------------------------------------------

func connectionDisconnect(_ context.Context, params map[string]any) (any, error) {
	if id := strParam(params, "connectionId"); id != "" {
		dropSession(id)
	} else if conn, err := parseConnection(params); err == nil {
		dropSession(conn.ID)
	}
	return map[string]any{"success": true, "message": "Disconnected"}, nil
}

// ---------------------------------------------------------------------------
// registry (OCI Distribution v2)
// ---------------------------------------------------------------------------

func registryInfo(_ context.Context, s *Session, _ map[string]any) (any, error) {
	return map[string]any{"registryType": s.RegistryType, "endpoint": s.BaseURL, "name": s.Conn.Name}, nil
}

func registryCatalog(ctx context.Context, s *Session, params map[string]any) (any, error) {
	return s.Oci.Catalog(ctx, strParam(params, "search"))
}

func registryNamespaces(ctx context.Context, s *Session, _ map[string]any) (any, error) {
	return s.Oci.Namespaces(ctx)
}

func registryRepositories(ctx context.Context, s *Session, params map[string]any) (any, error) {
	return s.Oci.ReposInNamespace(ctx, strParam(params, "namespace"))
}

func registryImages(ctx context.Context, s *Session, params map[string]any) (any, error) {
	return v2ProjectOverview(ctx, s, strParam(params, "namespace"))
}

func registryTags(ctx context.Context, s *Session, params map[string]any) (any, error) {
	return s.Oci.Tags(ctx, strParam(params, "repository"))
}

func registryManifest(ctx context.Context, s *Session, params map[string]any) (any, error) {
	return s.Oci.Manifest(ctx, strParam(params, "repository"), strParam(params, "reference"))
}

func registryLayers(ctx context.Context, s *Session, params map[string]any) (any, error) {
	return analyzeManifest(ctx, s, strParam(params, "repository"), strParam(params, "reference"))
}

func registryArches(ctx context.Context, s *Session, params map[string]any) (any, error) {
	repo := strParam(params, "repository")
	ref := strParam(params, "reference")
	if repo == "" || ref == "" {
		return nil, errors.New("repository and reference are required")
	}
	arches, digest, err := archesFor(ctx, s, repo, ref)
	if err != nil {
		return nil, err
	}
	return map[string]any{"repository": repo, "reference": ref, "arches": arches, "digest": digest}, nil
}

// registryDelete removes an OCI manifest. A plain OCI delete is digest-scoped,
// so the tag the user acted on is the only tag name we can hold the retention
// policy against.
func registryDelete(ctx context.Context, s *Session, params map[string]any) (any, error) {
	if err := guardTagNotProtected(s, strParam(params, "tag")); err != nil {
		return nil, err
	}
	// The retention window applies here too. This path is the one the UI falls
	// back to when a delete carries no artifact reference, and it deletes through
	// the OCI API — so skipping the guard here would make the policy depend on
	// which button produced the request rather than on what was asked for.
	if repo := strParam(params, "repository"); repo != "" {
		if project, short, ok := splitProjectRepo(repo); ok {
			if err := s.guardRetentionWindow(ctx, project, short, strParam(params, "tag"), strParam(params, "digest")); err != nil {
				return nil, err
			}
		}
	}
	return map[string]any{"ok": true}, s.Oci.Delete(ctx, strParam(params, "repository"), strParam(params, "digest"))
}

// splitProjectRepo splits "project/repository" into its parts. A name without a
// slash has no project to resolve, and the checks that need one are skipped — the
// same shape the retag path already relies on.
func splitProjectRepo(full string) (string, string, bool) {
	parts := strings.SplitN(strings.Trim(full, "/"), "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// ---------------------------------------------------------------------------
// Harbor REST API v2.0
// ---------------------------------------------------------------------------

func harborRepositories(ctx context.Context, s *Session, params map[string]any) (any, error) {
	return s.Harbor.Repositories(ctx, strParam(params, "project"))
}

func harborArtifacts(ctx context.Context, s *Session, params map[string]any) (any, error) {
	return s.Harbor.Artifacts(ctx, strParam(params, "project"), strParam(params, "repository"))
}

func harborImages(ctx context.Context, s *Session, params map[string]any) (any, error) {
	project, err := requiredProject(params)
	if err != nil {
		return nil, err
	}
	return s.Harbor.ProjectImages(ctx, project, maxUntaggedScanRepos)
}

func harborDeleteTag(ctx context.Context, s *Session, params map[string]any) (any, error) {
	if err := deleteTagGuarded(ctx, s, strParam(params, "project"), strParam(params, "repository"),
		strParam(params, "reference"), strParam(params, "tag")); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

// deleteTagGuarded is the one way a tag is deleted on Harbor, guards included.
//
// It exists because the guards were on the RPC handler while the MCP tool called
// the client method directly — so the AI path had the glob protection (which the
// tool asked for itself) but not the retention window, which had just been added
// to the handler. A guard that lives beside one caller is a guard the next caller
// does not get; keeping the check and the delete in the same function is what
// makes "the tools cannot get around the rules" true rather than intended.
func deleteTagGuarded(ctx context.Context, s *Session, project, repo, reference, tag string) error {
	if err := guardTagNotProtected(s, tag); err != nil {
		return err
	}
	if err := s.guardRetentionWindow(ctx, project, repo, tag, reference); err != nil {
		return err
	}
	return s.Harbor.DeleteTag(ctx, project, repo, reference, tag)
}

func harborDeleteArtifact(ctx context.Context, s *Session, params map[string]any) (any, error) {
	if err := s.guardRetentionWindow(ctx, strParam(params, "project"), strParam(params, "repository"),
		"", strParam(params, "reference")); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, s.Harbor.DeleteArtifact(ctx,
		strParam(params, "project"), strParam(params, "repository"), strParam(params, "reference"))
}

// harborUntagged scans a project for artifacts with no tag, with the connection's
// cleanup rules applied so the UI can offer exactly what policy allows.
func harborUntagged(ctx context.Context, s *Session, params map[string]any) (any, error) {
	project, err := requiredProject(params)
	if err != nil {
		return nil, err
	}
	set, _ := settingsFor(s.Conn.ID)
	return s.Harbor.Untagged(ctx, project, set.Cleanup)
}

// ---------------------------------------------------------------------------
// project administration & user management
// ---------------------------------------------------------------------------

func harborProjectAdmin(ctx context.Context, s *Session, params map[string]any) (any, error) {
	project, err := requiredProject(params)
	if err != nil {
		return nil, err
	}
	return projectAdmin(ctx, s, project)
}

func harborProjectSetPublic(ctx context.Context, s *Session, params map[string]any) (any, error) {
	project, err := requiredProject(params)
	if err != nil {
		return nil, err
	}
	public := boolParam(params, "public")
	return map[string]any{"ok": true, "public": public}, s.Harbor.SetProjectPublic(ctx, project, public)
}

func harborMemberRole(ctx context.Context, s *Session, params map[string]any) (any, error) {
	project, err := requiredProject(params)
	if err != nil {
		return nil, err
	}
	memberID, roleID := intParam(params, "memberId"), intParam(params, "roleId")
	if memberID == 0 || roleID == 0 {
		return nil, errors.New("project, memberId and roleId are required")
	}
	return map[string]any{"ok": true}, s.Harbor.UpdateMemberRole(ctx, project, memberID, roleID)
}

func harborMemberRemove(ctx context.Context, s *Session, params map[string]any) (any, error) {
	project, err := requiredProject(params)
	if err != nil {
		return nil, err
	}
	memberID := intParam(params, "memberId")
	if memberID == 0 {
		return nil, errors.New("project and memberId are required")
	}
	return map[string]any{"ok": true}, s.Harbor.RemoveMember(ctx, project, memberID)
}

func harborCurrentUser(ctx context.Context, s *Session, _ map[string]any) (any, error) {
	user, err := s.Harbor.CurrentUser(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"admin": user.SysAdmin, "user": user}, nil
}

func harborUserCreate(ctx context.Context, s *Session, params map[string]any) (any, error) {
	username, err := required(params, "username")
	if err != nil {
		return nil, err
	}
	password := strParam(params, "password")
	if password == "" {
		return nil, errors.New("username and password are required")
	}
	return map[string]any{"ok": true}, s.Harbor.CreateUser(ctx, username,
		strParam(params, "email"), strParam(params, "realname"), password, strParam(params, "comment"))
}

func harborUserPassword(ctx context.Context, s *Session, params map[string]any) (any, error) {
	userID := intParam(params, "userId")
	password := strParam(params, "newPassword")
	if userID == 0 || password == "" {
		return nil, errors.New("userId and newPassword are required")
	}
	return map[string]any{"ok": true}, s.Harbor.SetUserPassword(ctx, userID, password)
}

func harborUserDelete(ctx context.Context, s *Session, params map[string]any) (any, error) {
	userID := intParam(params, "userId")
	if userID == 0 {
		return nil, errors.New("userId is required")
	}
	return map[string]any{"ok": true}, s.Harbor.DeleteUser(ctx, userID)
}

func harborUserAdmin(ctx context.Context, s *Session, params map[string]any) (any, error) {
	userID := intParam(params, "userId")
	if userID == 0 {
		return nil, errors.New("userId is required")
	}
	return map[string]any{"ok": true}, s.Harbor.SetUserAdmin(ctx, userID, boolParam(params, "admin"))
}

// guardTagNotProtected refuses an operation on a tag the retention rules protect.
// Both delete paths (plain OCI and Harbor's native one) share it so a policy
// cannot be bypassed by picking the other button.
func guardTagNotProtected(s *Session, tag string) error {
	tag = strings.TrimSpace(tag)
	if tag == "" {
		return nil
	}
	if pattern, blocked := s.tagProtected(tag); blocked {
		return protectedTagError(tag, pattern)
	}
	return nil
}
