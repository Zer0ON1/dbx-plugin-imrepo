package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// ---------------------------------------------------------------------------
// Per-connection settings
//
// Settings live in a JSON file under the user config dir rather than in the
// sandbox: the UI has no durable storage, settings must survive a plugin
// reinstall, and the backend is what actually enforces them. The file is keyed
// by connection id so two registries can hold different policies.
//
// Every value here changes real behaviour — none of it is decorative:
//   Cleanup   -> decides which untagged artifacts the cleanup dialog may propose
//   Retention -> protected tags are refused by delete/rename, keep-N is advisory
//   Scanner   -> report cache TTL, severity threshold, Harbor-side scan config
// ---------------------------------------------------------------------------

const settingsFileVersion = 1

type CleanupRules struct {
	// KeepUntagged keeps the newest N untagged artifacts of every repository.
	KeepUntagged int `json:"keepUntagged"`
	// MinAgeDays protects anything pushed less than N days ago (0 = no age gate).
	MinAgeDays int `json:"minAgeDays"`
	// ExcludeRepos lists glob patterns; a matching repository is never proposed
	// for cleanup. Patterns are matched against both "repo" and "project/repo".
	ExcludeRepos []string `json:"excludeRepos"`
	// MaxReposPerScan bounds a project scan so a large project cannot turn into
	// an unbounded sweep.
	MaxReposPerScan int `json:"maxReposPerScan"`
}

type RetentionRules struct {
	// KeepTagged is the number of newest artifacts per repository considered
	// "inside policy". It is advisory (surfaced in the UI), never an automatic
	// deletion.
	KeepTagged int `json:"keepTagged"`
	// ProtectTags lists glob patterns that delete/rename may never remove.
	// This one is enforced by the backend.
	ProtectTags []string `json:"protectTags"`
}

type ScannerSettings struct {
	// Source: "harbor" uses Harbor's vulnerability API, "off" hides the panel.
	Source    string `json:"source"`
	Threshold string `json:"threshold"` // critical | high | medium | low
	// CacheSeconds is how long a vulnerability report is reused (0 = always refetch).
	CacheSeconds int `json:"cacheSeconds"`

	// Harbor-side configuration. These are only written to the registry when the
	// user explicitly applies them, because they change server state.
	AutoScan    bool   `json:"autoScan"`
	PreventVul  bool   `json:"preventVul"`
	ScannerUUID string `json:"scannerUuid"`
}

type Settings struct {
	Cleanup   CleanupRules    `json:"cleanup"`
	Retention RetentionRules  `json:"retention"`
	Scanner   ScannerSettings `json:"scanner"`
	// Projects holds per-project overrides. Today that is the scanner policy:
	// vulnerability scanning is configured per project, not globally.
	Projects map[string]ProjectSettings `json:"projects,omitempty"`
}

// ProjectSettings is the per-project slice of the settings file.
type ProjectSettings struct {
	Scanner ScannerSettings `json:"scanner"`
}

type settingsStore struct {
	Version     int                 `json:"version"`
	Connections map[string]Settings `json:"connections"`
}

var (
	settingsMu    sync.Mutex
	settingsCache *settingsStore
)

// defaultSettings is what a connection runs with until the user changes it:
// conservative, nothing destructive, nothing hidden.
func defaultSettings() Settings {
	return Settings{
		Cleanup: CleanupRules{
			KeepUntagged:    0, // no reservation: every untagged artifact is proposable
			MinAgeDays:      0, // no age gate
			ExcludeRepos:    []string{},
			MaxReposPerScan: maxUntaggedScanRepos,
		},
		Retention: RetentionRules{
			KeepTagged:  0,
			ProtectTags: []string{"latest"},
		},
		Scanner: ScannerSettings{
			Source:       "harbor",
			Threshold:    "high",
			CacheSeconds: 300,
			AutoScan:     false,
			PreventVul:   false,
		},
	}
}

// settingsPath is the JSON file backing the settings, created on first save.
func settingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil || dir == "" {
		return "", fmt.Errorf("cannot locate a user config directory: %v", err)
	}
	return filepath.Join(dir, "imrepo-dbx-plugin", "settings.json"), nil
}

func loadStore() *settingsStore {
	if settingsCache != nil {
		return settingsCache
	}
	st := &settingsStore{Version: settingsFileVersion, Connections: map[string]Settings{}}
	if p, err := settingsPath(); err == nil {
		if raw, err := os.ReadFile(p); err == nil {
			// A corrupt file must not brick the plugin: fall back to defaults and
			// let the next save overwrite it.
			var parsed settingsStore
			if json.Unmarshal(raw, &parsed) == nil && parsed.Connections != nil {
				parsed.Version = settingsFileVersion
				st = &parsed
			}
		}
	}
	settingsCache = st
	return settingsCache
}

func saveStore(st *settingsStore) error {
	p, err := settingsPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return fmt.Errorf("creating settings directory: %w", err)
	}
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	// Write-then-rename so an interrupted save cannot leave a half file behind.
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return fmt.Errorf("writing settings: %w", err)
	}
	if err := os.Rename(tmp, p); err != nil {
		return fmt.Errorf("replacing settings: %w", err)
	}
	return nil
}

// settingsFor returns the stored settings for a connection, or the defaults.
func settingsFor(connID string) (Settings, bool) {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	st := loadStore()
	s, ok := st.Connections[strings.TrimSpace(connID)]
	if !ok {
		return defaultSettings(), false
	}
	return normalize(s), true
}

func saveSettingsFor(connID string, s Settings) error {
	// Validate what was sent, not what we would have defaulted it to. Normalising
	// first silently turned an explicit "0" into "100", so an out-of-range value
	// was accepted and reported as saved.
	if err := validateSettings(s); err != nil {
		return err
	}
	s = normalize(s)
	settingsMu.Lock()
	defer settingsMu.Unlock()
	st := loadStore()
	if st.Connections == nil {
		st.Connections = map[string]Settings{}
	}
	st.Connections[strings.TrimSpace(connID)] = s
	return saveStore(st)
}

func resetSettingsFor(connID string) error {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	st := loadStore()
	delete(st.Connections, strings.TrimSpace(connID))
	return saveStore(st)
}

// normalize fills in anything missing and trims the pattern lists so the
// stored file stays readable.
func normalize(s Settings) Settings {
	d := defaultSettings()
	if s.Cleanup.MaxReposPerScan <= 0 {
		s.Cleanup.MaxReposPerScan = d.Cleanup.MaxReposPerScan
	}
	s.Cleanup.ExcludeRepos = cleanList(s.Cleanup.ExcludeRepos)
	s.Retention.ProtectTags = cleanList(s.Retention.ProtectTags)
	if s.Scanner.Source == "" {
		s.Scanner.Source = d.Scanner.Source
	}
	if s.Scanner.Threshold == "" {
		s.Scanner.Threshold = d.Scanner.Threshold
	}
	return s
}

func cleanList(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

// validateSettings rejects values that would either be a no-op surprise or a
// foot-gun. Bad glob patterns are the interesting case: `internal-[` would
// otherwise silently never match.
func validateSettings(s Settings) error {
	var problems []string
	if s.Cleanup.KeepUntagged < 0 || s.Cleanup.KeepUntagged > 1000 {
		problems = append(problems, "cleanup.keepUntagged must be between 0 and 1000")
	}
	if s.Cleanup.MinAgeDays < 0 || s.Cleanup.MinAgeDays > 3650 {
		problems = append(problems, "cleanup.minAgeDays must be between 0 and 3650")
	}
	if s.Cleanup.MaxReposPerScan < 1 || s.Cleanup.MaxReposPerScan > 500 {
		problems = append(problems, "cleanup.maxReposPerScan must be between 1 and 500")
	}
	if s.Retention.KeepTagged < 0 || s.Retention.KeepTagged > 1000 {
		problems = append(problems, "retention.keepTagged must be between 0 and 1000")
	}
	if s.Scanner.CacheSeconds < 0 || s.Scanner.CacheSeconds > 86400 {
		problems = append(problems, "scanner.cacheSeconds must be between 0 and 86400")
	}
	if s.Scanner.Source != "harbor" && s.Scanner.Source != "off" {
		problems = append(problems, `scanner.source must be "harbor" or "off"`)
	}
	if !isSeverity(s.Scanner.Threshold) {
		problems = append(problems, "scanner.threshold must be one of critical, high, medium, low")
	}
	for _, p := range s.Cleanup.ExcludeRepos {
		if !validPattern(p) {
			problems = append(problems, fmt.Sprintf("cleanup.excludeRepos: %q is not a valid pattern", p))
		}
	}
	for _, p := range s.Retention.ProtectTags {
		if !validPattern(p) {
			problems = append(problems, fmt.Sprintf("retention.protectTags: %q is not a valid pattern", p))
		}
	}
	for name, ps := range s.Projects {
		if err := validateScanner(ps.Scanner); err != nil {
			problems = append(problems, fmt.Sprintf("projects[%s].%s", name, err))
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("invalid settings: %s", strings.Join(problems, "; "))
	}
	return nil
}

func validPattern(p string) bool {
	_, err := path.Match(strings.ToLower(p), "probe")
	return err == nil
}

// matchAny returns the first pattern matching any candidate.
//
// Matching is case-insensitive and applied to every candidate, so a user can
// write `internal-*` (repo), `libs/*` (project/repo) or `release-*` (tag)
// without thinking about which form the plugin happens to hold internally.
func matchAny(patterns []string, candidates ...string) (string, bool) {
	for _, p := range patterns {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		for _, c := range candidates {
			if c == "" {
				continue
			}
			if ok, err := path.Match(strings.ToLower(p), strings.ToLower(c)); err == nil && ok {
				return p, true
			}
		}
	}
	return "", false
}

// tagProtected reports whether a tag may not be removed under the current
// retention policy. The returned pattern is what the user needs to change.
func (s *Session) tagProtected(tag string) (string, bool) {
	if s == nil || tag == "" {
		return "", false
	}
	set, _ := settingsFor(s.Conn.ID)
	return matchAny(set.Retention.ProtectTags, tag)
}

// scannerFor resolves the scanner policy in force for a project: the project's
// own override first, then the connection-level value (the historical home of
// the scanner settings), then the defaults.
func scannerFor(connID, project string) ScannerSettings {
	set, _ := settingsFor(connID)
	if project != "" {
		if ps, ok := set.Projects[strings.TrimSpace(project)]; ok {
			return normalizeScanner(ps.Scanner)
		}
	}
	return normalizeScanner(set.Scanner)
}

// projectScannerSettings returns the stored per-project scanner plus whether
// one actually exists (otherwise the caller is looking at the fallback).
func projectScannerSettings(connID, project string) (ScannerSettings, bool) {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	st := loadStore()
	conn, ok := st.Connections[strings.TrimSpace(connID)]
	if !ok {
		return defaultSettings().Scanner, false
	}
	ps, ok := conn.Projects[strings.TrimSpace(project)]
	if !ok {
		return normalizeScanner(conn.Scanner), false
	}
	return normalizeScanner(ps.Scanner), true
}

// saveProjectScanner stores the scanner policy for one project only.
func saveProjectScanner(connID, project string, sc ScannerSettings) error {
	if err := validateScanner(sc); err != nil {
		return err
	}
	sc = normalizeScanner(sc)
	settingsMu.Lock()
	defer settingsMu.Unlock()
	st := loadStore()
	if st.Connections == nil {
		st.Connections = map[string]Settings{}
	}
	conn, ok := st.Connections[strings.TrimSpace(connID)]
	if !ok {
		conn = defaultSettings()
	}
	if conn.Projects == nil {
		conn.Projects = map[string]ProjectSettings{}
	}
	conn.Projects[strings.TrimSpace(project)] = ProjectSettings{Scanner: sc}
	st.Connections[strings.TrimSpace(connID)] = conn
	return saveStore(st)
}

func normalizeScanner(sc ScannerSettings) ScannerSettings {
	d := defaultSettings().Scanner
	if sc.Source == "" {
		sc.Source = d.Source
	}
	if sc.Threshold == "" {
		sc.Threshold = d.Threshold
	}
	return sc
}

func validateScanner(sc ScannerSettings) error {
	var problems []string
	if sc.CacheSeconds < 0 || sc.CacheSeconds > 86400 {
		problems = append(problems, "scanner.cacheSeconds must be between 0 and 86400")
	}
	if sc.Source != "harbor" && sc.Source != "off" {
		problems = append(problems, `scanner.source must be "harbor" or "off"`)
	}
	if !isSeverity(sc.Threshold) {
		problems = append(problems, "scanner.threshold must be one of critical, high, medium, low")
	}
	if len(problems) > 0 {
		return fmt.Errorf("invalid settings: %s", strings.Join(problems, "; "))
	}
	return nil
}

func protectedTagError(tag, pattern string) error {
	return fmt.Errorf("tag %q is protected by the retention policy (pattern %q); change it in Settings → Retention", tag, pattern)
}

func isSeverity(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "critical", "high", "medium", "low":
		return true
	default:
		return false
	}
}

// severityRank orders severities for threshold comparisons.
func severityRank(v string) int {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "critical":
		return 4
	case "high":
		return 3
	case "medium":
		return 2
	case "low":
		return 1
	default:
		return 0
	}
}

// sortedPatterns is only used to give a deterministic order in scan output.
func sortedPatterns(in []string) []string {
	out := append([]string{}, in...)
	sort.Strings(out)
	return out
}
