package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ---------------------------------------------------------------------------
// Where the plugin keeps its own files
//
// DBX hands every sidecar a DBX_PLUGIN_DATA_DIR: a directory reserved for this
// one plugin, alongside its install directory, that survives version upgrades
// and uninstalls. The plugin docs name it as the place for caches, tokens and
// anything else a sidecar writes — and because it sits inside DBX's own data
// directory, a deployment migrated by keeping that directory (the documented
// way for Docker and dbx-web) keeps the plugin's settings and remembered
// passwords with it.
//
// Versions before this one wrote to the per-user config directory instead
// (~/.config/imrepo-dbx-plugin on Linux) — which no deployment migration
// carries along. That stays as the fallback for hosts that set nothing, and
// whatever is found there is copied forward once, so an existing install keeps
// its settings instead of silently starting over.
// ---------------------------------------------------------------------------

var (
	pluginDirOnce  sync.Once
	pluginDirValue string
	pluginDirError error
)

// pluginConfigDir returns the directory this plugin owns. Resolution happens
// once per process: the environment does not change under a running sidecar,
// and every caller must see the same answer app/info reports.
func pluginConfigDir() (string, error) {
	pluginDirOnce.Do(func() { pluginDirValue, pluginDirError = resolvePluginConfigDir() })
	return pluginDirValue, pluginDirError
}

func resolvePluginConfigDir() (string, error) {
	if dir := strings.TrimSpace(os.Getenv("DBX_PLUGIN_DATA_DIR")); dir != "" {
		migrateLegacyConfig(dir)
		return dir, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil || dir == "" {
		return "", fmt.Errorf("cannot locate a user config directory: %v", err)
	}
	return filepath.Join(dir, "imrepo-dbx-plugin"), nil
}

// legacyConfigDir is where versions before this one wrote their files.
func legacyConfigDir() string {
	dir, err := os.UserConfigDir()
	if err != nil || dir == "" {
		return ""
	}
	return filepath.Join(dir, "imrepo-dbx-plugin")
}

// migrateLegacyConfig copies the files an earlier version wrote into the
// per-user config directory into the host-provided data directory, once.
//
// Copy, never move: the old location may still be in use — by a desktop
// install on the same machine, or by the same plugin running under a host that
// sets no DBX_PLUGIN_DATA_DIR — and a half-finished migration must not leave
// either side unreadable. Files already present at the destination are never
// overwritten, and a failure is not fatal: the plugin keeps working on defaults
// and rewrites on the next save. Errors are reported and dropped for the same
// reason, and note what happened without revealing any content.
func migrateLegacyConfig(newDir string) {
	old := legacyConfigDir()
	if old == "" || old == newDir {
		return
	}
	copied := false
	for _, f := range []struct {
		name string
		mode os.FileMode
	}{
		{"settings.json", 0o644},
		{"credentials.json", 0o600},
	} {
		dst := filepath.Join(newDir, f.name)
		if _, err := os.Stat(dst); err == nil {
			continue // already there: the destination is the newer copy
		}
		raw, err := os.ReadFile(filepath.Join(old, f.name))
		if err != nil {
			continue // nothing to migrate
		}
		if err := os.MkdirAll(newDir, 0o700); err != nil {
			log.Printf("imrepo: cannot create the plugin data directory %s: %v", newDir, err)
			return
		}
		if err := os.WriteFile(dst, raw, f.mode); err != nil {
			log.Printf("imrepo: cannot migrate %s into the plugin data directory: %v", f.name, err)
			continue
		}
		copied = true
	}
	if copied {
		log.Printf("imrepo: copied settings from %s into %s", old, newDir)
	}
}
