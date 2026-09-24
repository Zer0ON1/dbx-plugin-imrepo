package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Session holds a connected registry: resolved credentials, base URL and
// prebuilt OCI / Harbor clients. Keyed by connection.id so the sandboxed UI
// can reference it without ever receiving secrets.
type Session struct {
	Conn         *Connection
	Cred         *Credential
	BaseURL      string
	RegistryType string
	Oci          *OciClient
	Harbor       *HarborClient

	// Vulnerability reports are per-artifact and expensive (Harbor proxies a
	// scanner), so they are cached for the TTL set in Settings → Scanner.
	vulnMu    sync.Mutex
	vulnCache map[string]vulnCacheEntry
}

// The cache holds the raw findings, not the panel payload: the severity
// threshold is applied when the report is read, so changing it in Settings takes
// effect immediately instead of being masked by a cached verdict.
type vulnCacheEntry struct {
	payload harborVulnPayload
	at      time.Time
}

var (
	sessionsMu sync.RWMutex
	sessions   = map[string]*Session{}
	activeID   string
)

func buildSession(conn *Connection) (*Session, error) {
	ctx := context.Background()
	cred, err := resolveCredential(ctx, conn)
	if err != nil {
		return nil, err
	}
	// Remember the password the moment we hold it, so a later reconnect without
	// the secret still unlocks management features.
	if cred != nil && cred.Scheme == "basic" && cred.Password != "" {
		rememberCredential(conn.ID, cred.Password)
	}
	base := baseURL(conn)
	hc := httpClient(conn)
	return &Session{
		Conn:         conn,
		Cred:         cred,
		BaseURL:      base,
		RegistryType: conn.registryType(),
		Oci:          newOciClient(base, cred, hc),
		Harbor:       newHarborClient(base, cred, hc),
	}, nil
}

func resolveCredential(ctx context.Context, conn *Connection) (*Credential, error) {
	p, err := newAuthProvider(conn)
	if err != nil {
		return nil, err
	}
	cred, err := p.Credential(ctx)
	if err != nil {
		return nil, err
	}
	return cred, nil
}

func storeSession(s *Session) {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	sessions[s.Conn.ID] = s
	activeID = s.Conn.ID
}

func dropSession(id string) {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	delete(sessions, id)
	if activeID == id {
		activeID = ""
	}
}

func getSession(id string) *Session {
	sessionsMu.RLock()
	defer sessionsMu.RUnlock()
	return sessions[id]
}

// resolveSession locates the session the UI wants to operate on.
// Priority: params.connectionId -> params.connection (object) -> active -> sole session.
func resolveSession(params map[string]any) (*Session, error) {
	if id := strParam(params, "connectionId"); id != "" {
		if s := getSession(id); s != nil {
			return s, nil
		}
	}
	if raw, ok := params["connection"].(map[string]any); ok {
		b, _ := json.Marshal(raw)
		var conn Connection
		if err := json.Unmarshal(b, &conn); err == nil && conn.ID != "" {
			if s := getSession(conn.ID); s != nil {
				return s, nil
			}
		}
	}
	sessionsMu.RLock()
	id := activeID
	sole := ""
	if len(sessions) == 1 {
		for k := range sessions {
			sole = k
		}
	}
	sessionsMu.RUnlock()
	if id != "" {
		if s := getSession(id); s != nil {
			return s, nil
		}
	}
	if sole != "" {
		if s := getSession(sole); s != nil {
			return s, nil
		}
	}
	return nil, fmt.Errorf("no active connection: open (connect) a registry first")
}

func strParam(params map[string]any, key string) string {
	if params == nil {
		return ""
	}
	if v, ok := params[key].(string); ok {
		return v
	}
	return ""
}

// boolParam reads a boolean flag, accepting the string form too because a form
// value may arrive as "true"/"false" depending on the host encoding.
func boolParam(params map[string]any, key string) bool {
	if params == nil {
		return false
	}
	switch v := params[key].(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(strings.TrimSpace(v), "true")
	default:
		return false
	}
}

// intParam reads an integer parameter, accepting every numeric encoding the host
// might send (int, float64, json.Number, numeric string).
func intParam(params map[string]any, key string) int {
	if params == nil {
		return 0
	}
	switch v := params[key].(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		n, _ := v.Int64()
		return int(n)
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(v))
		return n
	default:
		return 0
	}
}
