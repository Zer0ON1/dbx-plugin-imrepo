package main

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// Connection is the connection object the DBX host passes during lifecycle
// requests. The REAL host shape (see the CLI dev-runtime and the host itself):
//
//	external_config    ← every manifest field bound to "config"
//	connection_secrets ← every manifest field bound to "secret"
//
// The older `config` / `secret` keys are still accepted so locally crafted
// requests keep working, but the host never sends them.
type Connection struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	Database string `json:"database"`
	// Legacy shapes (accepted, never sent by the host).
	Config map[string]any    `json:"config"`
	Secret map[string]string `json:"secret"`
	// The real host shapes.
	ExternalConfig    map[string]any    `json:"external_config"`
	ConnectionSecrets map[string]string `json:"connection_secrets"`

	Runtime RuntimeInfo `json:"runtime,omitempty"`
}

// RuntimeInfo carries the tunnel/proxy-transformed endpoint.
type RuntimeInfo struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

// lookupAny fetches a non-nil entry from a config-ish map.
func lookupAny(m map[string]any, key string) (any, bool) {
	if m == nil {
		return nil, false
	}
	v, ok := m[key]
	if !ok || v == nil {
		return nil, false
	}
	return v, true
}

func anyToString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case json.Number:
		return t.String()
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

// configStr reads a string-valued config entry, from the host's
// external_config first, then the legacy config map.
func (c *Connection) configStr(key string) string {
	if c == nil {
		return ""
	}
	for _, m := range []map[string]any{c.ExternalConfig, c.Config} {
		if v, ok := lookupAny(m, key); ok {
			return anyToString(v)
		}
	}
	return ""
}

// configBool reads a boolean-valued config entry, from the host's
// external_config first, then the legacy config map.
func (c *Connection) configBool(key string) bool {
	if c == nil {
		return false
	}
	for _, m := range []map[string]any{c.ExternalConfig, c.Config} {
		v, ok := lookupAny(m, key)
		if !ok {
			continue
		}
		switch t := v.(type) {
		case bool:
			return t
		case string:
			return t == "true" || t == "1"
		}
	}
	return false
}

// secretStr reads a secret entry, from the host's connection_secrets first,
// then the legacy secret map.
func (c *Connection) secretStr(key string) string {
	if c == nil {
		return ""
	}
	for _, m := range []map[string]string{c.ConnectionSecrets, c.Secret} {
		if m == nil {
			continue
		}
		if v, ok := m[key]; ok && v != "" {
			return v
		}
	}
	return ""
}

// password resolves the Basic/robot password from the several places the host
// may deliver it — the plain password field, the secret map, and finally the
// sidecar's persisted copy. That last fallback is what keeps admin features
// working after the host reconnects without sending the secret.
func (c *Connection) password() string {
	if c == nil {
		return ""
	}
	if c.Password != "" {
		return c.Password
	}
	if p := c.secretStr("password"); p != "" {
		return p
	}
	if p, ok := storedCredential(c.ID); ok {
		return p
	}
	return ""
}

// authType normalizes the authentication selection.
func (c *Connection) authType() string {
	t := c.configStr("auth_type")
	if t == "" {
		return "basic"
	}
	return t
}

// registryType returns the registry preset type.
func (c *Connection) registryType() string {
	t := c.configStr("registry_type")
	if t == "" {
		return "docker-v2"
	}
	return t
}

func connError(msg string) error { return fmt.Errorf("%s", msg) }
