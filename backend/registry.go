package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Project lifecycle + administration extensions
//
//   CreateProject   POST /api/v2.0/projects
//   Quota           GET|PUT /api/v2.0/quotas (reference=project)
//   AuditLogs       GET /api/v2.0/audit-logs
//   RegistryOverview  totals across every project (+ pull counts from logs)
// ---------------------------------------------------------------------------

// Harbor's own project-name grammar: lowercase alphanumerics with ., _ and -,
// must start with a letter or digit.
var projectNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,254}$`)

func createProject(ctx context.Context, s *Session, params map[string]any) (any, error) {
	if err := requireHarbor(s); err != nil {
		return nil, err
	}
	name := strings.ToLower(strings.TrimSpace(strParam(params, "name")))
	if name == "" {
		return nil, errors.New("project name is required")
	}
	if !projectNameRe.MatchString(name) {
		return nil, errors.New("invalid project name: use lowercase letters, digits, '.', '_' and '-', starting with a letter or digit")
	}
	public := boolParam(params, "public")
	body := map[string]any{
		"project_name": name,
		"metadata":     map[string]any{"public": boolString(public)},
	}
	data, code, err := s.Harbor.doBody(ctx, http.MethodPost, "/api/v2.0/projects", body)
	if err != nil {
		return nil, err
	}
	switch code {
	case http.StatusCreated, http.StatusOK:
		return map[string]any{"ok": true, "name": name, "public": public}, nil
	case http.StatusConflict:
		return nil, fmt.Errorf("a project named %q already exists", name)
	default:
		return nil, mgmtErr("creating the project", code, data, nil)
	}
}

// ---------------------------------------------------------------------------
// Storage quota per project
// ---------------------------------------------------------------------------

type HarborQuota struct {
	ID   int64          `json:"id"`
	Hard map[string]any `json:"hard"`
	Used map[string]any `json:"used"`
}

// quotaFor resolves the project's quota entry (Harbor keeps one per project).
func (h *HarborClient) quotaFor(ctx context.Context, projectID int64) (*HarborQuota, error) {
	data, code, err := h.do(ctx, http.MethodGet,
		fmt.Sprintf("/api/v2.0/quotas?reference=project&reference_id=%d&page=1&page_size=1", projectID))
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, mgmtErr("reading the project quota", code, data, nil)
	}
	var list []HarborQuota
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, errors.New("the project has no quota entry (Harbor assigns one on creation)")
	}
	return &list[0], nil
}

func quotaGet(ctx context.Context, s *Session, params map[string]any) (any, error) {
	if err := requireHarbor(s); err != nil {
		return nil, err
	}
	project := strings.TrimSpace(strParam(params, "project"))
	if project == "" {
		return nil, errors.New("project is required")
	}
	detail, err := s.Harbor.ProjectDetail(ctx, project)
	if err != nil {
		return nil, err
	}
	q, err := s.Harbor.quotaFor(ctx, int64(detail.ProjectID))
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"project":   project,
		"quotaId":   q.ID,
		"hardBytes": quotaNumber(q.Hard),
		"usedBytes": quotaNumber(q.Used),
	}, nil
}

// quotaNumber folds Harbor's number-or-string encoding of storage values.
func quotaNumber(m map[string]any) int64 {
	if m == nil {
		return -1
	}
	switch t := m["storage"].(type) {
	case float64:
		return int64(t)
	case string:
		var n int64
		fmt.Sscanf(strings.TrimSpace(t), "%d", &n)
		return n
	default:
		return -1
	}
}

func quotaSet(ctx context.Context, s *Session, params map[string]any) (any, error) {
	if err := requireHarbor(s); err != nil {
		return nil, err
	}
	project := strings.TrimSpace(strParam(params, "project"))
	if project == "" {
		return nil, errors.New("project is required")
	}
	hardBytes := int64(intParam(params, "hardBytes"))
	if hardBytes < 0 {
		hardBytes = -1 // -1 is Harbor's "no limit"
	} else if hardBytes == 0 {
		return nil, errors.New("a 0-byte quota would freeze the project; use -1 for no limit")
	}
	detail, err := s.Harbor.ProjectDetail(ctx, project)
	if err != nil {
		return nil, err
	}
	q, err := s.Harbor.quotaFor(ctx, int64(detail.ProjectID))
	if err != nil {
		return nil, err
	}
	data, code, err := s.Harbor.doBody(ctx, http.MethodPut,
		fmt.Sprintf("/api/v2.0/quotas/%d", q.ID),
		map[string]any{"hard": map[string]any{"storage": hardBytes}})
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, mgmtErr("updating the project quota", code, data, nil)
	}
	return map[string]any{"ok": true, "hardBytes": hardBytes}, nil
}

// ---------------------------------------------------------------------------
// Audit logs (pull / push / create / delete), global or per project
// ---------------------------------------------------------------------------

type HarborAuditLog struct {
	ID        int    `json:"id"`
	OpTime    string `json:"op_time"`
	Operation string `json:"operation"`
	Resource  string `json:"resource"`
	Username  string `json:"username"`
}

func harborLogs(ctx context.Context, s *Session, params map[string]any) (any, error) {
	if err := requireHarbor(s); err != nil {
		return nil, err
	}
	q := url.Values{}
	q.Set("page", fmt.Sprintf("%d", maxInt(intParam(params, "page"), 1)))
	q.Set("page_size", fmt.Sprintf("%d", clampInt(intParam(params, "pageSize"), 10, 100, 50)))
	if op := strings.TrimSpace(strParam(params, "operation")); op != "" {
		q.Set("operation", op)
	}
	if project := strings.TrimSpace(strParam(params, "project")); project != "" {
		detail, err := s.Harbor.ProjectDetail(ctx, project)
		if err != nil {
			return nil, err
		}
		q.Set("project_id", fmt.Sprintf("%d", detail.ProjectID))
	}
	data, code, err := s.Harbor.do(ctx, http.MethodGet, "/api/v2.0/audit-logs?"+q.Encode())
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, mgmtErr("reading audit logs", code, data, nil)
	}
	var logs []HarborAuditLog
	if err := json.Unmarshal(data, &logs); err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(logs))
	for _, l := range logs {
		out = append(out, map[string]any{
			"time": l.OpTime, "operation": l.Operation,
			"resource": l.Resource, "username": l.Username,
		})
	}
	return map[string]any{"logs": out, "page": intParam(params, "page"), "pageSize": q.Get("page_size")}, nil
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func clampInt(v, lo, hi, def int) int {
	if v == 0 {
		return def
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ---------------------------------------------------------------------------
// Registry-wide overview
// ---------------------------------------------------------------------------

// RegistryOverview aggregates the dashboard: how many projects, how many
// images, how much space they occupy, and how often they were pulled within
// the recent windows. Pull counts come from Harbor's audit log, scanned once
// and counted for 1/3/7 days at the same time so switching the window in the
// UI never costs another request.
type RegistryOverview struct {
	ProjectCount  int            `json:"projectCount"`
	ImageCount    int            `json:"imageCount"`
	RepoCount     int            `json:"repoCount"`
	TotalSize     int64          `json:"totalSize"`
	PullCounts    map[string]int `json:"pullCounts"` // "1" | "3" | "7" days
	PullTruncated bool           `json:"pullTruncated"`
	ProjectErrors []string       `json:"projectErrors,omitempty"`
	// RecentProjects are the newest projects (by creation_time), TopPulled the
	// most-pulled over the last 7 days — the sidebar overview links to these.
	RecentProjects []map[string]any `json:"recentProjects,omitempty"`
	TopPulled      []map[string]any `json:"topPulled,omitempty"`
	// SizeByProject ranks projects by storage, most-consuming first — feeds the
	// storage-distribution chart.
	SizeByProject []map[string]any `json:"sizeByProject,omitempty"`
}

func registryOverview(ctx context.Context, s *Session, params map[string]any) (any, error) {
	if err := requireHarbor(s); err != nil {
		return nil, err
	}
	projects, err := s.Harbor.Projects(ctx)
	if err != nil {
		return nil, err
	}
	out := &RegistryOverview{
		ProjectCount: len(projects),
		PullCounts:   map[string]int{"1": 0, "3": 0, "7": 0},
	}

	// Walk every project's repositories concurrently (same shape as
	// ProjectImages, but across all projects). One failing project is reported,
	// not fatal.
	type projRepos struct {
		name  string
		repos []HarborRepository
		err   error
	}
	results := make([]projRepos, len(projects))
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for i := range projects {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			repos, err := s.Harbor.Repositories(ctx, projects[i].Name)
			results[i] = projRepos{name: projects[i].Name, repos: repos, err: err}
		}(i)
	}
	wg.Wait()

	type job struct {
		project string
		repo    HarborRepository
	}
	jobs := make([]job, 0, 64)
	for _, r := range results {
		if r.err != nil {
			out.ProjectErrors = append(out.ProjectErrors, fmt.Sprintf("%s: %v", r.name, r.err))
			continue
		}
		out.RepoCount += len(r.repos)
		for _, repo := range r.repos {
			jobs = append(jobs, job{project: r.name, repo: repo})
		}
	}

	const overviewWorkers = 6
	pages := make([][]HarborArtifact, len(jobs))
	errMsgs := make([]string, len(jobs))
	wsem := make(chan struct{}, overviewWorkers)
	var wwg sync.WaitGroup
	for i := range jobs {
		wwg.Add(1)
		go func(i int) {
			defer wwg.Done()
			wsem <- struct{}{}
			defer func() { <-wsem }()
			arts, err := s.Harbor.Artifacts(ctx, jobs[i].project, jobs[i].repo.Name)
			if err != nil {
				errMsgs[i] = fmt.Sprintf("%s/%s: %v", jobs[i].project, jobs[i].repo.Name, err)
				return
			}
			pages[i] = arts
		}(i)
	}
	wwg.Wait()

	repoErrSeen := map[string]bool{}
	sizeByProject := map[string]int64{}
	for i := range jobs {
		if errMsgs[i] != "" && !repoErrSeen[errMsgs[i]] {
			repoErrSeen[errMsgs[i]] = true
			out.ProjectErrors = append(out.ProjectErrors, errMsgs[i])
		}
		for _, a := range pages[i] {
			out.ImageCount++
			out.TotalSize += a.Size
			sizeByProject[jobs[i].project] += a.Size
		}
	}
	out.SizeByProject = rankSizes(sizeByProject, 6)

	out.PullCounts, out.PullTruncated = s.Harbor.pullCounts(ctx, []int{1, 3, 7})
	out.RecentProjects = recentProjects(projects, 6)
	out.TopPulled = s.Harbor.topPulledProjects(ctx, 7, 6)
	return out, nil
}

// recentProjects orders the project list by creation time, newest first.
func recentProjects(projects []HarborProject, n int) []map[string]any {
	ordered := append([]HarborProject{}, projects...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].CreationTime > ordered[j].CreationTime
	})
	if n > len(ordered) {
		n = len(ordered)
	}
	out := make([]map[string]any, 0, n)
	for _, p := range ordered[:n] {
		out = append(out, map[string]any{"name": p.Name, "created": p.CreationTime})
	}
	return out
}

// topPulledProjects counts pull operations per project over the last `days`
// days (from the audit log) and returns the top `n`, most-pulled first.
func (h *HarborClient) topPulledProjects(ctx context.Context, days, n int) []map[string]any {
	cutoff := time.Now().AddDate(0, 0, -days)
	counts := map[string]int{}
	const maxPages = 40
	for page := 1; page <= maxPages; page++ {
		data, code, err := h.do(ctx, http.MethodGet,
			fmt.Sprintf("/api/v2.0/audit-logs?operation=pull&page=%d&page_size=100", page))
		if err != nil || code != http.StatusOK {
			break
		}
		var logs []HarborAuditLog
		if json.Unmarshal(data, &logs) != nil || len(logs) == 0 {
			break
		}
		reachedCutoff := false
		for _, l := range logs {
			t, ok := parseLogTime(l.OpTime)
			if !ok {
				continue
			}
			if t.Before(cutoff) {
				reachedCutoff = true
				continue
			}
			if proj := projectFromResource(l.Resource); proj != "" {
				counts[proj]++
			}
		}
		if reachedCutoff || len(logs) < 100 {
			break
		}
	}
	type pc struct {
		name  string
		count int
	}
	ranked := make([]pc, 0, len(counts))
	for name, c := range counts {
		ranked = append(ranked, pc{name, c})
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].count > ranked[j].count })
	if n > len(ranked) {
		n = len(ranked)
	}
	out := make([]map[string]any, 0, n)
	for _, r := range ranked[:n] {
		out = append(out, map[string]any{"name": r.name, "pulls": r.count})
	}
	return out
}

// rankSizes orders a name→size map by size (descending) and returns the top n
// as {name, size} entries for a chart.
func rankSizes(m map[string]int64, n int) []map[string]any {
	type sz struct {
		name string
		size int64
	}
	ranked := make([]sz, 0, len(m))
	for name, size := range m {
		ranked = append(ranked, sz{name, size})
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].size > ranked[j].size })
	if n > len(ranked) {
		n = len(ranked)
	}
	out := make([]map[string]any, 0, n)
	for _, r := range ranked[:n] {
		out = append(out, map[string]any{"name": r.name, "size": r.size})
	}
	return out
}

// projectFromResource extracts the project name from an audit-log resource
// string like "project/repo:tag", "project/repo" or "project".
func projectFromResource(res string) string {
	res = strings.TrimSpace(res)
	if res == "" {
		return ""
	}
	if i := strings.IndexByte(res, '/'); i > 0 {
		return res[:i]
	}
	return res
}

// pullCounts counts pull operations within each of the requested day windows
// from Harbor's audit log. Log pages are fetched newest-first until a page is
// entirely older than the widest window or the page budget runs out — a busy
// registry may hold more history than we walk, in which case the counts are
// floors and PullTruncated says so.
func (h *HarborClient) pullCounts(ctx context.Context, windowsDays []int) (map[string]int, bool) {
	counts := map[string]int{}
	widest := windowsDays[0]
	for _, d := range windowsDays {
		if d > widest {
			widest = d
		}
	}
	now := time.Now()
	cutoff := now.AddDate(0, 0, -widest)

	truncated := false
	const maxPages = 40 // 40 * 100 entries: a hard stop, never an unbounded walk
	for page := 1; page <= maxPages; page++ {
		data, code, err := h.do(ctx, http.MethodGet,
			fmt.Sprintf("/api/v2.0/audit-logs?operation=pull&page=%d&page_size=100", page))
		if err != nil || code != http.StatusOK {
			truncated = true // the history beyond here is unknown, so the counts are partial
			break
		}
		var logs []HarborAuditLog
		if json.Unmarshal(data, &logs) != nil || len(logs) == 0 {
			break
		}
		oldest := now
		reachedCutoff := false
		for _, l := range logs {
			t, ok := parseLogTime(l.OpTime)
			if !ok {
				continue
			}
			if t.Before(oldest) {
				oldest = t
			}
			if t.Before(cutoff) {
				reachedCutoff = true
				continue
			}
			for _, d := range windowsDays {
				if t.After(now.AddDate(0, 0, -d)) {
					counts[fmt.Sprintf("%d", d)]++
				}
			}
		}
		if reachedCutoff || oldest.Before(cutoff) || len(logs) < 100 {
			break
		}
	}
	return counts, truncated
}

// parseLogTime accepts the timestamp shapes Harbor has used across versions.
func parseLogTime(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05.000Z", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
