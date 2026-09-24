package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	dbxpluginsdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

// methodNotFoundError marks requests the sidecar does not implement, so the
// RPC layer can answer with the JSON-RPC -32601 code instead of a generic error.
type methodNotFoundError struct{ method string }

func (e *methodNotFoundError) Error() string { return "method not found: " + e.method }

// Fallbacks, used only when the packaged manifest cannot be located (e.g. a
// sidecar launched straight out of a build directory).
const (
	pluginID      = "com.dbx.plugin.imrepo"
	pluginVersion = "1.4.1"
)

// githubURL is the project page shown in Settings → About. Left empty on
// purpose until the repository is public; the UI renders a "coming soon" hint
// instead of a dead link.
const githubURL = ""

// identity resolved at startup (manifest wins), so both the handshake and the
// About panel report the same thing.
var (
	resolvedPluginID      = pluginID
	resolvedPluginVersion = pluginVersion
)

func pluginIdentity() (string, string) { return resolvedPluginID, resolvedPluginVersion }

// manifestIdentity resolves the id/version the host will compare us against.
//
// The host rejects the plugin when the sidecar's advertised identity differs
// from manifest.json — "Plugin backend identity 'x/1.2.0' does not match
// manifest 'x/1.2.1'". Hard-coding the version here means every release must
// remember to bump two files, and forgetting once bricks the plugin at runtime.
// Reading it from the manifest the binary actually ships inside makes that
// class of drift impossible.
//
// The binary lives at <plugin>/bin/<target>/<name>[.exe], so we walk up a few
// levels looking for manifest.json; in `dbx-plugin dev` the same walk finds the
// project manifest.
func manifestIdentity() (id, version string) {
	exe, err := os.Executable()
	if err != nil {
		return "", ""
	}
	dir := filepath.Dir(exe)
	for depth := 0; depth < 5; depth++ {
		raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
		if err == nil {
			var m struct {
				ID      string `json:"id"`
				Version string `json:"version"`
			}
			if json.Unmarshal(raw, &m) == nil && m.ID != "" && m.Version != "" {
				return strings.TrimSpace(m.ID), strings.TrimSpace(m.Version)
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", ""
}

type plugin struct{}

func (p *plugin) Handle(_ dbxpluginsdk.RequestContext, method string, params json.RawMessage, _ *dbxpluginsdk.Emitter) (any, *dbxpluginsdk.PluginError) {
	values := map[string]any{}
	if len(params) > 0 && string(params) != "null" {
		if err := json.Unmarshal(params, &values); err != nil {
			return nil, dbxpluginsdk.NewError(-32602, "Invalid request parameters")
		}
	}
	result, err := handle(context.Background(), method, values)
	if err != nil {
		var mnf *methodNotFoundError
		if errors.As(err, &mnf) {
			return nil, dbxpluginsdk.MethodNotFound(mnf.method)
		}
		return nil, dbxpluginsdk.NewError(-32000, err.Error())
	}
	return result, nil
}

func main() {
	id, version := pluginID, pluginVersion
	if mid, mver := manifestIdentity(); mid != "" {
		id, version = mid, mver
	} else {
		log.Printf("imrepo: manifest.json not found next to binary, using built-in identity %s/%s", id, version)
	}
	resolvedPluginID, resolvedPluginVersion = id, version

	metadata := dbxpluginsdk.Metadata{
		ID:           id,
		Version:      version,
		Capabilities: []string{"connections"},
	}
	server := dbxpluginsdk.NewServer(metadata, &plugin{})
	if err := server.Serve(); err != nil {
		log.Fatal(err)
	}
}

func handle(ctx context.Context, method string, params map[string]any) (any, error) {
	switch method {
	// ---- settings & identity ------------------------------------------------
	case "app/info":
		id, version := pluginIdentity()
		p, _ := settingsPath()
		return map[string]any{
			"pluginId":        id,
			"version":         version,
			"protocolVersion": 1,
			"transport":       "stdio-jsonl",
			"settingsPath":    p,
			"github":          githubURL,
		}, nil
	case "settings/get":
		connID := settingsConnID(params)
		set, stored := settingsFor(connID)
		p, _ := settingsPath()
		return map[string]any{
			"settings":     set,
			"connectionId": connID,
			"isDefault":    !stored,
			"path":         p,
		}, nil
	case "settings/set":
		connID := settingsConnID(params)
		raw, ok := params["settings"].(map[string]any)
		if !ok {
			return nil, errors.New("settings object is required")
		}
		b, err := json.Marshal(raw)
		if err != nil {
			return nil, err
		}
		var set Settings
		if err := json.Unmarshal(b, &set); err != nil {
			return nil, fmt.Errorf("invalid settings payload: %w", err)
		}
		if err := saveSettingsFor(connID, set); err != nil {
			return nil, err
		}
		saved, _ := settingsFor(connID)
		p, _ := settingsPath()
		return map[string]any{
			"settings":     saved,
			"connectionId": connID,
			"path":         p,
			"message":      "Settings saved",
		}, nil
	case "settings/reset":
		connID := settingsConnID(params)
		if err := resetSettingsFor(connID); err != nil {
			return nil, err
		}
		return map[string]any{
			"settings":     defaultSettings(),
			"connectionId": connID,
			"message":      "Settings reset to defaults",
		}, nil
	case "settings/getProject":
		connID := settingsConnID(params)
		project := strings.TrimSpace(strParam(params, "project"))
		if project == "" {
			return nil, errors.New("project is required")
		}
		sc, explicit := projectScannerSettings(connID, project)
		return map[string]any{
			"project":      project,
			"connectionId": connID,
			"scanner":      sc,
			"isDefault":    !explicit,
		}, nil
	case "settings/setProject":
		connID := settingsConnID(params)
		project := strings.TrimSpace(strParam(params, "project"))
		if project == "" {
			return nil, errors.New("project is required")
		}
		raw, ok := params["scanner"].(map[string]any)
		if !ok {
			return nil, errors.New("scanner object is required")
		}
		b, err := json.Marshal(raw)
		if err != nil {
			return nil, err
		}
		var sc ScannerSettings
		if err := json.Unmarshal(b, &sc); err != nil {
			return nil, fmt.Errorf("invalid scanner payload: %w", err)
		}
		if err := saveProjectScanner(connID, project, sc); err != nil {
			return nil, err
		}
		saved, _ := projectScannerSettings(connID, project)
		return map[string]any{
			"project":      project,
			"connectionId": connID,
			"scanner":      saved,
			"message":      "Project settings saved",
		}, nil

	case "registry/info":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return map[string]any{"registryType": s.RegistryType, "endpoint": s.BaseURL, "name": s.Conn.Name}, nil

	// OCI Registry v2 (works for Harbor too — Harbor exposes /v2/)
	case "registry/catalog":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return s.Oci.Catalog(ctx, strParam(params, "search"))
	case "registry/namespaces":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return s.Oci.Namespaces(ctx)
	case "registry/repositories":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return s.Oci.ReposInNamespace(ctx, strParam(params, "namespace"))
	case "registry/images":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return v2ProjectOverview(ctx, s, strParam(params, "namespace"))
	case "registry/arches":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		repo := strParam(params, "repository")
		ref := strParam(params, "reference")
		if repo == "" || ref == "" {
			return nil, errors.New("repository and reference are required")
		}
		arches, err := archesFor(ctx, s, repo, ref)
		if err != nil {
			return nil, err
		}
		return map[string]any{"repository": repo, "reference": ref, "arches": arches}, nil
	case "registry/overview":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return v2Overview(ctx, s)
	case "registry/tags":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return s.Oci.Tags(ctx, strParam(params, "repository"))
	case "registry/manifest":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return s.Oci.Manifest(ctx, strParam(params, "repository"), strParam(params, "reference"))
	case "registry/layers":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return analyzeManifest(ctx, s, strParam(params, "repository"), strParam(params, "reference"))
	case "registry/retag":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return retag(ctx, s, params)
	case "registry/delete":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		// A plain OCI delete is digest-scoped, so the tag the user acted on is
		// the only tag name we can hold the retention policy against.
		if tag := strings.TrimSpace(strParam(params, "tag")); tag != "" {
			if pat, blocked := s.tagProtected(tag); blocked {
				return nil, protectedTagError(tag, pat)
			}
		}
		return map[string]any{"ok": true}, s.Oci.Delete(ctx, strParam(params, "repository"), strParam(params, "digest"))

	// Harbor REST API v2.0 (project tree, native delete, CVE report)
	case "harbor/projects":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return s.Harbor.Projects(ctx)
	case "harbor/repositories":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return s.Harbor.Repositories(ctx, strParam(params, "project"))
	case "harbor/artifacts":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return s.Harbor.Artifacts(ctx, strParam(params, "project"), strParam(params, "repository"))
	case "harbor/images":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		project := strings.TrimSpace(strParam(params, "project"))
		if project == "" {
			return nil, errors.New("project is required")
		}
		return s.Harbor.ProjectImages(ctx, project, maxUntaggedScanRepos)
	case "harbor/deleteTag":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if tag := strings.TrimSpace(strParam(params, "tag")); tag != "" {
			if pat, blocked := s.tagProtected(tag); blocked {
				return nil, protectedTagError(tag, pat)
			}
		}
		return map[string]any{"ok": true}, s.Harbor.DeleteTag(ctx, strParam(params, "project"), strParam(params, "repository"), strParam(params, "reference"), strParam(params, "tag"))
	case "harbor/untagged":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		project := strings.TrimSpace(strParam(params, "project"))
		if project == "" {
			return nil, errors.New("project is required")
		}
		set, _ := settingsFor(s.Conn.ID)
		return s.Harbor.Untagged(ctx, project, set.Cleanup)
	case "harbor/cleanupUntagged":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		return cleanupUntagged(ctx, s, params)
	case "harbor/deleteArtifact":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, s.Harbor.DeleteArtifact(ctx, strParam(params, "project"), strParam(params, "repository"), strParam(params, "reference"))
	case "harbor/vulnerabilities":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return vulnerabilities(ctx, s, params)
	case "harbor/scannerInfo":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return scannerInfo(ctx, s, params)
	case "harbor/applyScanner":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return applyScanner(ctx, s, params)
	case "harbor/scan":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return triggerScan(ctx, s, params)

	// ---- project administration (members + retention) and user management ----
	case "harbor/projectAdmin":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		project := strings.TrimSpace(strParam(params, "project"))
		if project == "" {
			return nil, errors.New("project is required")
		}
		return projectAdmin(ctx, s, project)
	case "harbor/memberAdd":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		return addMember(ctx, s, params)
	case "harbor/memberRole":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		project := strings.TrimSpace(strParam(params, "project"))
		if project == "" || intParam(params, "memberId") == 0 || intParam(params, "roleId") == 0 {
			return nil, errors.New("project, memberId and roleId are required")
		}
		return map[string]any{"ok": true}, s.Harbor.UpdateMemberRole(ctx, project, intParam(params, "memberId"), intParam(params, "roleId"))
	case "harbor/memberRemove":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		project := strings.TrimSpace(strParam(params, "project"))
		if project == "" || intParam(params, "memberId") == 0 {
			return nil, errors.New("project and memberId are required")
		}
		return map[string]any{"ok": true}, s.Harbor.RemoveMember(ctx, project, intParam(params, "memberId"))
	case "harbor/retentionSave":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		return saveRetention(ctx, s, params)
	case "harbor/projectSetPublic":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		project := strings.TrimSpace(strParam(params, "project"))
		if project == "" {
			return nil, errors.New("project is required")
		}
		public := boolParam(params, "public")
		return map[string]any{"ok": true, "public": public}, s.Harbor.SetProjectPublic(ctx, project, public)
	case "harbor/projectCreate":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return createProject(ctx, s, params)
	case "harbor/quotaGet":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return quotaGet(ctx, s, params)
	case "harbor/quotaSet":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return quotaSet(ctx, s, params)
	case "harbor/logs":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return harborLogs(ctx, s, params)
	case "harbor/overview":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		return registryOverview(ctx, s, params)
	case "harbor/users":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		return s.Harbor.Users(ctx)
	case "harbor/userCreate":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		username := strings.TrimSpace(strParam(params, "username"))
		password := strParam(params, "password")
		if username == "" || password == "" {
			return nil, errors.New("username and password are required")
		}
		return map[string]any{"ok": true}, s.Harbor.CreateUser(ctx, username,
			strParam(params, "email"), strParam(params, "realname"), password, strParam(params, "comment"))
	case "harbor/userPassword":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		if intParam(params, "userId") == 0 || strParam(params, "newPassword") == "" {
			return nil, errors.New("userId and newPassword are required")
		}
		return map[string]any{"ok": true}, s.Harbor.SetUserPassword(ctx, intParam(params, "userId"), strParam(params, "newPassword"))
	case "harbor/userDelete":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		if intParam(params, "userId") == 0 {
			return nil, errors.New("userId is required")
		}
		return map[string]any{"ok": true}, s.Harbor.DeleteUser(ctx, intParam(params, "userId"))
	case "harbor/userAdmin":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		if intParam(params, "userId") == 0 {
			return nil, errors.New("userId is required")
		}
		return map[string]any{"ok": true}, s.Harbor.SetUserAdmin(ctx, intParam(params, "userId"), boolParam(params, "admin"))
	case "harbor/currentUser":
		s, err := resolveSession(params)
		if err != nil {
			return nil, err
		}
		if err := requireHarbor(s); err != nil {
			return nil, err
		}
		u, err := s.Harbor.CurrentUser(ctx)
		if err != nil {
			return nil, err
		}
		return map[string]any{"admin": u.SysAdmin, "user": u}, nil

	// Connection lifecycle (handled by the host; also routed here for safety)
	case "connection/test", "connection/connect":
		return handleConnect(ctx, params, method == "connection/test")
	case "connection/disconnect":
		if id := strParam(params, "connectionId"); id != "" {
			dropSession(id)
		} else if conn, err := parseConnection(params); err == nil {
			dropSession(conn.ID)
		}
		return map[string]any{"success": true, "message": "Disconnected"}, nil
	case "connection/action":
		return handleAction(ctx, params)

	default:
		return nil, &methodNotFoundError{method: method}
	}
}

// settingsConnID decides which connection a settings read/write belongs to.
// The UI passes connectionId explicitly; a session is only consulted as a
// fallback so settings stay reachable even if the session was dropped.
func settingsConnID(params map[string]any) string {
	if id := strings.TrimSpace(strParam(params, "connectionId")); id != "" {
		return id
	}
	if s, err := resolveSession(params); err == nil && s != nil {
		return s.Conn.ID
	}
	return "default"
}

func handleConnect(ctx context.Context, params map[string]any, testOnly bool) (any, error) {
	conn, err := parseConnection(params)
	if err != nil {
		return nil, err
	}
	s, err := buildSession(conn)
	if err != nil {
		return nil, err
	}
	if err := s.verify(ctx); err != nil {
		return nil, err
	}
	upgraded := detectHarbor(ctx, s)
	if !testOnly {
		storeSession(s)
	}
	kind := s.RegistryType
	if upgraded {
		kind += " — detected, was configured as docker-v2"
	}
	return map[string]any{
		"success":      true,
		"message":      "Connected to " + s.BaseURL + " (" + kind + ")",
		"registryType": s.RegistryType,
		"endpoint":     s.BaseURL,
	}, nil
}

// detectHarbor upgrades a connection declared as a generic OCI v2 registry when
// the server actually answers Harbor's API. Picking "Docker Registry v2" for a
// real Harbor is the most common misconfiguration: the generic endpoints work,
// so the sidebar happily shows a project tree, but every Harbor-only operation
// is refused — a state that contradicts itself. A 200 on /api/v2.0/ping is
// proof the server runs Harbor, so the session quietly becomes one and the
// connect message says so.
func detectHarbor(ctx context.Context, s *Session) bool {
	if s.RegistryType != "docker-v2" {
		return false
	}
	if _, code, err := s.Harbor.do(ctx, http.MethodGet, "/api/v2.0/ping"); err == nil && code == http.StatusOK {
		s.RegistryType = registryTypeHarbor
		return true
	}
	return false
}

func handleAction(ctx context.Context, params map[string]any) (any, error) {
	id := ""
	if action, ok := params["action"].(map[string]any); ok {
		id, _ = action["id"].(string)
	}
	switch id {
	case "refresh":
		conn, err := parseConnection(params)
		if err != nil {
			return nil, err
		}
		s, err := buildSession(conn)
		if err != nil {
			return nil, err
		}
		if err := s.verify(ctx); err != nil {
			return nil, err
		}
		detectHarbor(ctx, s)
		storeSession(s)
		return map[string]any{
			"success":      true,
			"message":      "Refreshed " + s.BaseURL + " (" + s.RegistryType + ")",
			"registryType": s.RegistryType,
			"endpoint":     s.BaseURL,
		}, nil
	default:
		return map[string]any{"success": true, "message": "OK"}, nil
	}
}

func parseConnection(params map[string]any) (*Connection, error) {
	raw, ok := params["connection"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("missing connection object")
	}
	b, _ := json.Marshal(raw)
	var conn Connection
	if err := json.Unmarshal(b, &conn); err != nil {
		return nil, fmt.Errorf("invalid connection: %w", err)
	}
	if rt, ok := params["runtime"].(map[string]any); ok {
		rb, _ := json.Marshal(rt)
		_ = json.Unmarshal(rb, &conn.Runtime)
	}
	// Some hosts deliver the secret at the TOP LEVEL of the lifecycle request
	// (params.secret) instead of inside the connection object. Merge every
	// shape we know of; never overwrite a value already present.
	if sec, ok := params["secret"].(map[string]any); ok {
		if conn.Secret == nil {
			conn.Secret = map[string]string{}
		}
		for k, v := range sec {
			if conn.Secret[k] == "" {
				conn.Secret[k] = fmt.Sprintf("%v", v)
			}
		}
	}
	if conn.ID == "" {
		conn.ID = "imrepo-connection"
	}
	return &conn, nil
}

// registryTypeHarbor is the only preset whose REST API can delete a single tag.
const registryTypeHarbor = "harbor"

const (
	// A project with hundreds of repositories would turn one click into hundreds
	// of requests; scan a bounded prefix and say so.
	maxUntaggedScanRepos = 100
	// Upper bound on one cleanup call, so a bug in the client cannot turn a
	// confirmation into an unbounded delete loop.
	maxCleanupBatch = 300
)

// requireHarbor guards operations that only Harbor's REST API can perform.
func requireHarbor(s *Session) error {
	if s.RegistryType != registryTypeHarbor {
		return fmt.Errorf(
			"this operation needs the Harbor API (this connection is configured as a plain OCI v2 registry). If the server actually runs Harbor, reconnect or hit refresh — Harbor features are then enabled automatically")
	}
	return nil
}

// cleanupUntagged deletes dangling artifacts, re-verifying every one of them
// immediately before deletion.
//
// The scan a user confirms can be minutes old, and a digest that was dangling
// then may carry a tag now. Deleting it anyway would destroy a live image, so a
// target that has since been tagged is reported as skipped, never deleted.
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
func (s *Session) verify(ctx context.Context) error {
	var causes []string

	if resp, err := s.Oci.do(ctx, http.MethodGet, "/v2/", nil, "", "registry:catalog:*"); err == nil {
		resp.Body.Close()
		// 401/403 still proves the endpoint speaks the registry protocol.
		if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return nil
		}
		causes = append(causes, fmt.Sprintf("GET %s/v2/ -> HTTP %d", s.BaseURL, resp.StatusCode))
	} else {
		cause := fmt.Sprintf("GET %s/v2/ -> %v", s.BaseURL, err)
		// A transport-level failure (refused / unknown host / bad TLS) already
		// explains everything; pinging Harbor would only repeat the same text.
		if isTransportFailure(err) {
			return fmt.Errorf("cannot reach registry: %s%s", cause, connectionHint)
		}
		causes = append(causes, cause)
	}

	if _, code, err := s.Harbor.do(ctx, http.MethodGet, "/api/v2.0/ping"); err == nil && code == http.StatusOK {
		return nil
	} else if err != nil {
		causes = append(causes, fmt.Sprintf("GET %s/api/v2.0/ping -> %v", s.BaseURL, err))
	} else {
		causes = append(causes, fmt.Sprintf("GET %s/api/v2.0/ping -> HTTP %d", s.BaseURL, code))
	}

	return fmt.Errorf("cannot reach registry: %s%s", strings.Join(causes, " | "), connectionHint)
}

const connectionHint = " (check host/port, network reachability, TLS trust, and the \"insecure / self-signed\" option)"

// isTransportFailure reports whether err means we never completed an HTTP
// exchange, so retrying another endpoint on the same host is pointless.
func isTransportFailure(err error) bool {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return true
	}
	var certErr *tls.CertificateVerificationError
	if errors.As(err, &certErr) {
		return true
	}
	var opErr *net.OpError
	return errors.As(err, &opErr)
}

// rankIndexEntries orders a manifest list so a real image comes first.
//
// BuildKit pushes attestation entries next to the images; those declare platform
// "unknown/unknown" and contain no layers. Selecting one yields "0 layers",
// which reads as a broken feature rather than a wrong pick.
func rankIndexEntries(manifests []any) []map[string]any {
	var preferred, known, unknown []map[string]any
	for _, m := range manifests {
		mm, ok := m.(map[string]any)
		if !ok {
			continue
		}
		p, _ := mm["platform"].(map[string]any)
		osName, _ := p["os"].(string)
		arch, _ := p["architecture"].(string)
		switch {
		case osName == "linux" && arch == "amd64":
			preferred = append(preferred, mm)
		case osName != "" && osName != "unknown" && arch != "" && arch != "unknown":
			known = append(known, mm)
		default:
			unknown = append(unknown, mm)
		}
	}
	return append(append(preferred, known...), unknown...)
}

type layerOut struct {
	Index     int    `json:"index"`
	Command   string `json:"command"`
	Size      int64  `json:"size"`
	Digest    string `json:"digest"`
	MediaType string `json:"mediaType"`
}

// analyzeManifest resolves a manifest (following an index if needed), reads the
// config blob and returns per-layer Dockerfile commands with their sizes.
func analyzeManifest(ctx context.Context, s *Session, repo, ref string) (any, error) {
	mr, err := s.Oci.Manifest(ctx, repo, ref)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(mr.Body), &doc); err != nil {
		return nil, fmt.Errorf("invalid manifest JSON: %w", err)
	}

	platform := map[string]any{}

	// Follow a manifest list / index down to a concrete image. Entries are tried
	// in preference order and skipped when they turn out not to be an image, so a
	// stray attestation entry can never produce an empty layer list.
	if manifests, ok := doc["manifests"].([]any); ok {
		candidates := rankIndexEntries(manifests)
		if len(candidates) == 0 {
			return nil, fmt.Errorf("manifest list is empty")
		}
		var lastErr error
		resolved := false
		for _, cand := range candidates {
			digest, _ := cand["digest"].(string)
			if digest == "" {
				continue
			}
			child, err := s.Oci.Manifest(ctx, repo, digest)
			if err != nil {
				lastErr = err
				continue
			}
			var childDoc map[string]any
			if err := json.Unmarshal([]byte(child.Body), &childDoc); err != nil {
				lastErr = err
				continue
			}
			// Attestation manifests carry no config/layers; skip them.
			if _, hasLayers := childDoc["layers"].([]any); !hasLayers {
				if _, hasConfig := childDoc["config"]; !hasConfig {
					continue
				}
			}
			doc = childDoc
			mr = child
			platform = mapFrom(cand["platform"])
			resolved = true
			break
		}
		if !resolved {
			if lastErr != nil {
				return nil, fmt.Errorf("resolving an image manifest from the manifest list failed: %w", lastErr)
			}
			return nil, fmt.Errorf("manifest list contains no image manifest")
		}
	}

	cfg, _ := doc["config"].(map[string]any)
	cfgDigest, _ := cfg["digest"].(string)
	layersRaw, _ := doc["layers"].([]any)

	var commands []string
	if cfgDigest != "" {
		if blob, err := s.Oci.Blob(ctx, repo, cfgDigest); err == nil {
			var cfgDoc map[string]any
			if json.Unmarshal(blob, &cfgDoc) == nil {
				if hist, ok := cfgDoc["history"].([]any); ok {
					for _, h := range hist {
						hm, ok := h.(map[string]any)
						if !ok {
							continue
						}
						if empty, _ := hm["empty_layer"].(bool); empty {
							continue
						}
						cb, _ := hm["created_by"].(string)
						commands = append(commands, cb)
					}
				}
			}
		}
	}

	layers := []layerOut{}
	var total int64
	for i, l := range layersRaw {
		lm, ok := l.(map[string]any)
		if !ok {
			continue
		}
		size, _ := lm["size"].(float64)
		digest, _ := lm["digest"].(string)
		mediaType, _ := lm["mediaType"].(string)
		cmd := ""
		if i < len(commands) {
			cmd = commands[i]
		}
		layers = append(layers, layerOut{Index: i + 1, Command: cmd, Size: int64(size), Digest: digest, MediaType: mediaType})
		total += int64(size)
	}

	return map[string]any{
		"digest":    mr.Digest,
		"mediaType": mr.MediaType,
		"platform":  platform,
		"layers":    layers,
		"totalSize": total,
	}, nil
}

func mapFrom(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}
