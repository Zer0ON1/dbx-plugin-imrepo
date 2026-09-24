package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// ---------------------------------------------------------------------------
// Per-connection credential persistence
//
// The DBX host only hands the connection secret to the plugin during lifecycle
// requests; when the workbench reconnects after a plugin restart, the secret
// may be absent. Without a password the session can browse public projects but
// every management API answers 401 — the exact "password not loaded" state the
// diagnostics report.
//
// To make admin features survive that, the last password seen for a connection
// is remembered sidecar-side, mirroring what `docker login` already does in
// ~/.docker/config.json. It is stored base64-encoded (obfuscation, not
// encryption) in the user's private config dir, per the same threat model as
// the Docker CLI on a single-user workstation.
// ---------------------------------------------------------------------------

type credentialStore struct {
	Version int               `json:"version"`
	Secrets map[string]string `json:"secrets"` // connectionId -> base64(password)
}

var (
	credentialsMu    sync.Mutex
	credentialsCache *credentialStore
)

func credentialPath() string {
	dir, err := os.UserConfigDir()
	if err != nil || dir == "" {
		return ""
	}
	return filepath.Join(dir, "imrepo-dbx-plugin", "credentials.json")
}

func loadCredentials() *credentialStore {
	if credentialsCache != nil {
		return credentialsCache
	}
	st := &credentialStore{Version: 1, Secrets: map[string]string{}}
	if p := credentialPath(); p != "" {
		if raw, err := os.ReadFile(p); err == nil {
			var parsed credentialStore
			if json.Unmarshal(raw, &parsed) == nil && parsed.Secrets != nil {
				st = &parsed
			}
		}
	}
	credentialsCache = st
	return credentialsCache
}

func saveCredentials(st *credentialStore) error {
	p := credentialPath()
	if p == "" {
		return os.ErrInvalid
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	// 0600: the file holds credentials; keep it readable by the owner only.
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// rememberCredential stores the password for a connection. Called whenever a
// session is built with a real password present, so the stored copy always
// reflects the last password the operator actually entered.
func rememberCredential(connID, password string) {
	if connID == "" || password == "" {
		return
	}
	credentialsMu.Lock()
	defer credentialsMu.Unlock()
	st := loadCredentials()
	if st.Secrets == nil {
		st.Secrets = map[string]string{}
	}
	st.Secrets[connID] = base64.StdEncoding.EncodeToString([]byte(password))
	_ = saveCredentials(st)
}

// storedCredential returns the remembered password for a connection.
func storedCredential(connID string) (string, bool) {
	credentialsMu.Lock()
	defer credentialsMu.Unlock()
	st := loadCredentials()
	if st == nil || st.Secrets == nil {
		return "", false
	}
	enc, ok := st.Secrets[connID]
	if !ok {
		return "", false
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", false
	}
	return string(raw), true
}
