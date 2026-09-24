package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Vulnerability reports and the scanner settings behind them
//
// The CVE panel reads Harbor's vulnerability API. What Settings → Scanner
// changes is real: which severity counts as "needs attention", how long a
// report is reused, whether the panel is off, and — when the user explicitly
// applies it — the scanner and scan policy stored on the Harbor project.
// ---------------------------------------------------------------------------

// vulnReportResult is the panel payload. It carries the threshold decision
// alongside the raw findings so the UI never has to re-derive policy.
type vulnReportResult struct {
	Vulnerabilities  []map[string]any `json:"vulnerabilities"`
	Severity         string           `json:"severity,omitempty"` // worst finding reported by Harbor
	Highest          string           `json:"highest,omitempty"`  // worst finding we could classify
	Threshold        string           `json:"threshold"`
	ExceedsThreshold bool             `json:"exceedsThreshold"`
	Counts           map[string]int   `json:"counts"`
	Total            int              `json:"total"`
	Source           string           `json:"source"`
	Scanner          string           `json:"scanner,omitempty"`
	GeneratedAt      string           `json:"generatedAt,omitempty"`
	Disabled         bool             `json:"disabled,omitempty"`
	Reason           string           `json:"reason,omitempty"`
	Cached           bool             `json:"cached"`
}

func (s *Session) cachedVuln(key string, ttlSeconds int) (harborVulnPayload, bool) {
	if ttlSeconds <= 0 {
		return harborVulnPayload{}, false
	}
	s.vulnMu.Lock()
	defer s.vulnMu.Unlock()
	entry, ok := s.vulnCache[key]
	if !ok || time.Since(entry.at) > time.Duration(ttlSeconds)*time.Second {
		return harborVulnPayload{}, false
	}
	return entry.payload, true
}

func (s *Session) storeVuln(key string, payload harborVulnPayload) {
	s.vulnMu.Lock()
	defer s.vulnMu.Unlock()
	if s.vulnCache == nil {
		s.vulnCache = map[string]vulnCacheEntry{}
	}
	s.vulnCache[key] = vulnCacheEntry{payload: payload, at: time.Now()}
}

// clearVulnCache drops every cached report. Called after a scan is triggered or
// the scan policy changes, because the cached answer is no longer the truth.
func (s *Session) clearVulnCache() {
	s.vulnMu.Lock()
	defer s.vulnMu.Unlock()
	s.vulnCache = map[string]vulnCacheEntry{}
}

// vulnerabilities serves the CVE panel.
func vulnerabilities(ctx context.Context, s *Session, params map[string]any) (any, error) {
	project := strings.TrimSpace(strParam(params, "project"))
	// Scanning is configured per project; the connection-level scanner entry is
	// only the fallback for projects without their own override.
	sc := scannerFor(s.Conn.ID, project)
	threshold := sc.Threshold

	if sc.Source == "off" {
		return vulnReportResult{
			Vulnerabilities: []map[string]any{},
			Threshold:       threshold,
			Counts:          map[string]int{},
			Disabled:        true,
			Reason:          "vulnerability scanning is turned off for this project (project settings → scanner)",
			Source:          "off",
		}, nil
	}
	if err := requireHarbor(s); err != nil {
		return nil, err
	}

	repo := strings.TrimSpace(strParam(params, "repository"))
	ref := strings.TrimSpace(strParam(params, "reference"))
	if project == "" || repo == "" || ref == "" {
		return nil, errors.New("project, repository and reference are required")
	}

	key := project + "|" + repo + "|" + ref
	if !boolParam(params, "force") {
		if payload, ok := s.cachedVuln(key, sc.CacheSeconds); ok {
			// Verdict is recomputed here, not replayed: the cached part is the
			// expensive Harbor payload, the threshold is policy.
			report := buildVulnReport(payload, threshold)
			report.Cached = true
			return report, nil
		}
	}

	raw, err := s.Harbor.Vulnerabilities(ctx, project, repo, ref)
	if err != nil {
		return nil, err
	}
	payload := parseVulnPayload(raw)
	s.storeVuln(key, payload)
	return buildVulnReport(payload, threshold), nil
}

// harborVulnPayload is Harbor's vulnerability additions payload, cached as-is.
type harborVulnPayload struct {
	GeneratedAt     string           `json:"generated_at"`
	Severity        string           `json:"severity"`
	Scanner         map[string]any   `json:"scanner"`
	Vulnerabilities []map[string]any `json:"vulnerabilities"`
}

func parseVulnPayload(raw json.RawMessage) harborVulnPayload {
	var payload harborVulnPayload
	_ = json.Unmarshal(raw, &payload)
	if payload.Vulnerabilities == nil {
		payload.Vulnerabilities = []map[string]any{}
	}
	return payload
}

// buildVulnReport turns the cached findings into the panel payload, applying the
// severity threshold that is in force right now.
func buildVulnReport(payload harborVulnPayload, threshold string) vulnReportResult {
	report := vulnReportResult{
		Vulnerabilities: payload.Vulnerabilities,
		Severity:        payload.Severity,
		Threshold:       threshold,
		Counts:          map[string]int{"Critical": 0, "High": 0, "Medium": 0, "Low": 0},
		Total:           len(payload.Vulnerabilities),
		GeneratedAt:     payload.GeneratedAt,
		Source:          "harbor",
	}
	if report.Vulnerabilities == nil {
		report.Vulnerabilities = []map[string]any{}
	}
	if name, ok := payload.Scanner["name"].(string); ok {
		report.Scanner = name
	}
	worst := 0
	for _, v := range payload.Vulnerabilities {
		sev, _ := v["severity"].(string)
		sev = strings.TrimSpace(sev)
		if _, known := report.Counts[sev]; known {
			report.Counts[sev]++
		}
		if r := severityRank(sev); r > worst {
			worst = r
			report.Highest = canonicalSeverity(sev)
		}
	}
	if report.Highest == "" && strings.TrimSpace(payload.Severity) != "" {
		report.Highest = canonicalSeverity(payload.Severity)
	}
	report.ExceedsThreshold = severityRank(report.Highest) >= severityRank(threshold) && report.Highest != ""
	return report
}

// canonicalSeverity normalizes Harbor's spelling ("Critical", "UNKNOWN") into
// the four levels the panel ranks.
func canonicalSeverity(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "critical":
		return "Critical"
	case "high":
		return "High"
	case "medium":
		return "Medium"
	case "low":
		return "Low"
	default:
		return ""
	}
}

// scannerInfo reports what Harbor currently has, so the settings panel shows
// the real configuration rather than the values we happen to have stored.
func scannerInfo(ctx context.Context, s *Session, params map[string]any) (any, error) {
	if err := requireHarbor(s); err != nil {
		return nil, err
	}
	out := map[string]any{
		"available": true,
		"scanners":  []HarborScanner{},
		"project":   nil,
		"notes":     []string{},
	}
	notes := []string{}

	if scanners, err := s.Harbor.Scanners(ctx); err != nil {
		// A read-only account cannot list system scanners; that is a note, not a
		// failure of the panel.
		notes = append(notes, "could not list scanners: "+err.Error())
	} else {
		out["scanners"] = scanners
	}

	if project := strings.TrimSpace(strParam(params, "project")); project != "" {
		proj := map[string]any{"name": project}
		if uuid, err := s.Harbor.ProjectScanner(ctx, project); err != nil {
			notes = append(notes, "could not read the project scanner: "+err.Error())
		} else {
			proj["scannerUuid"] = uuid
		}
		if meta, err := s.Harbor.ProjectMetadata(ctx, project); err != nil {
			notes = append(notes, "could not read project metadata: "+err.Error())
		} else {
			proj["autoScan"] = metaBool(meta, "auto_scan")
			proj["preventVul"] = metaBool(meta, "prevent_vul")
			proj["severity"] = metaStr(meta, "severity")
		}
		out["project"] = proj
	}
	out["notes"] = notes
	return out, nil
}

// applyScanner writes the scan policy to Harbor. This changes server state, so
// it only runs when the user explicitly asks for it, and it reports exactly
// what it wrote.
func applyScanner(ctx context.Context, s *Session, params map[string]any) (any, error) {
	if err := requireHarbor(s); err != nil {
		return nil, err
	}
	project := strings.TrimSpace(strParam(params, "project"))
	if project == "" {
		return nil, errors.New("project is required")
	}

	applied := []string{}
	if uuid, ok := params["scannerUuid"]; ok {
		uuidStr := strings.TrimSpace(fmt.Sprintf("%v", uuid))
		if err := s.Harbor.SetProjectScanner(ctx, project, uuidStr); err != nil {
			return nil, err
		}
		applied = append(applied, "scanner="+orDefault(uuidStr, "system default"))
	}

	if hasParam(params, "autoScan") || hasParam(params, "preventVul") || hasParam(params, "severity") {
		// Read-modify-write: only the keys we were given are touched, so the rest
		// of the project's metadata survives.
		meta, err := s.Harbor.ProjectMetadata(ctx, project)
		if err != nil {
			return nil, err
		}
		if hasParam(params, "autoScan") {
			meta["auto_scan"] = boolString(boolParam(params, "autoScan"))
			applied = append(applied, "auto_scan="+boolString(boolParam(params, "autoScan")))
		}
		if hasParam(params, "preventVul") {
			meta["prevent_vul"] = boolString(boolParam(params, "preventVul"))
			applied = append(applied, "prevent_vul="+boolString(boolParam(params, "preventVul")))
		}
		if sev := strings.TrimSpace(strParam(params, "severity")); sev != "" {
			meta["severity"] = strings.ToLower(sev)
			applied = append(applied, "severity="+strings.ToLower(sev))
		}
		if err := s.Harbor.UpdateProjectMetadata(ctx, project, meta); err != nil {
			return nil, err
		}
	}

	if len(applied) == 0 {
		return nil, errors.New("nothing to apply: no scanner or scan policy values were given")
	}
	// Cached reports may predate the new policy.
	s.clearVulnCache()
	return map[string]any{
		"ok":      true,
		"applied": applied,
		"message": "Applied to Harbor project " + project + ": " + strings.Join(applied, ", "),
	}, nil
}

// triggerScan asks Harbor to (re)scan one artifact and drops the cached report.
func triggerScan(ctx context.Context, s *Session, params map[string]any) (any, error) {
	if err := requireHarbor(s); err != nil {
		return nil, err
	}
	project := strings.TrimSpace(strParam(params, "project"))
	repo := strings.TrimSpace(strParam(params, "repository"))
	ref := strings.TrimSpace(strParam(params, "reference"))
	if project == "" || repo == "" || ref == "" {
		return nil, errors.New("project, repository and reference are required")
	}
	if err := s.Harbor.TriggerScan(ctx, project, repo, ref); err != nil {
		return nil, err
	}
	s.clearVulnCache()
	return map[string]any{
		"ok":      true,
		"message": "Scan requested; Harbor runs it asynchronously, refresh the report in a moment",
	}, nil
}

func hasParam(params map[string]any, key string) bool {
	_, ok := params[key]
	return ok
}

func boolString(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

func orDefault(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

// metaStr/metaBool read Harbor's project metadata, which stores everything as
// strings ("true"/"false") rather than JSON booleans.
func metaStr(meta map[string]any, key string) string {
	if v, ok := meta[key].(string); ok {
		return v
	}
	if v, ok := meta[key].(bool); ok {
		return boolString(v)
	}
	return ""
}

func metaBool(meta map[string]any, key string) bool {
	return strings.EqualFold(metaStr(meta, key), "true")
}
