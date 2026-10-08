package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Harbor REST API v2.0 client
// ---------------------------------------------------------------------------

type HarborClient struct {
	base string
	cred *Credential
	http *http.Client
}

func newHarborClient(base string, cred *Credential, hc *http.Client) *HarborClient {
	return &HarborClient{base: base, cred: cred, http: hc}
}

func (h *HarborClient) do(ctx context.Context, method, path string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, method, h.base+path, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("accept", "application/json")
	if h.cred != nil && h.cred.Header() != "" {
		req.Header.Set("authorization", h.cred.Header())
	}
	resp, err := h.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return data, resp.StatusCode, nil
}

// doCounting is `do` plus the X-Total-Count header, which Harbor sets on list
// endpoints. Pagination needs it to know how many pages exist: without the
// total, a full page and the last page look identical, and the UI can only
// offer "next" blindly.
func (h *HarborClient) doCounting(ctx context.Context, method, path string) ([]byte, int, int, error) {
	req, err := http.NewRequestWithContext(ctx, method, h.base+path, nil)
	if err != nil {
		return nil, 0, 0, err
	}
	req.Header.Set("accept", "application/json")
	if h.cred != nil && h.cred.Header() != "" {
		req.Header.Set("authorization", h.cred.Header())
	}
	resp, err := h.http.Do(req)
	if err != nil {
		return nil, 0, 0, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	total := 0
	if raw := resp.Header.Get("X-Total-Count"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			total = n
		}
	}
	return data, resp.StatusCode, total, nil
}

type HarborProject struct {
	ProjectID    int    `json:"project_id"`
	Name         string `json:"name"`
	Public       bool   `json:"public"`
	RepoCount    int64  `json:"repo_count"`
	CreationTime string `json:"creation_time"`
}

func (h *HarborClient) Projects(ctx context.Context) ([]HarborProject, error) {
	data, code, err := h.do(ctx, http.MethodGet, "/api/v2.0/projects?page=1&page_size=100")
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("harbor projects failed (%d): %s", code, truncate(string(data), 300))
	}
	var out []HarborProject
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}

type HarborRepository struct {
	Name          string `json:"name"`      // name within the project (for Harbor API)
	FullName      string `json:"full_name"` // project/name (for OCI /v2/ endpoints)
	ProjectID     int    `json:"project_id"`
	ArtifactCount int64  `json:"artifact_count"`
	PullCount     int64  `json:"pull_count"`
	UpdateTime    string `json:"update_time"`
}

func (h *HarborClient) Repositories(ctx context.Context, project string) ([]HarborRepository, error) {
	p := url.PathEscape(project)
	data, code, err := h.do(ctx, http.MethodGet, "/api/v2.0/projects/"+p+"/repositories?page=1&page_size=100")
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("harbor repositories failed (%d): %s", code, truncate(string(data), 300))
	}
	var out []HarborRepository
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].FullName = out[i].Name
		if strings.HasPrefix(out[i].Name, project+"/") {
			out[i].Name = strings.TrimPrefix(out[i].Name, project+"/")
		}
	}
	return out, nil
}

type HarborTag struct {
	Name     string `json:"name"`
	PushTime string `json:"push_time"`
	PullTime string `json:"pull_time"`
}

// HarborPlatform is the os/architecture pair Harbor reports for an image.
type HarborPlatform struct {
	Architecture string `json:"architecture"`
	OS           string `json:"os"`
}

// HarborReference is one child of an index/manifest-list artifact; multi-arch
// images carry one reference (with its platform) per supported architecture.
type HarborReference struct {
	ChildDigest string          `json:"child_digest"`
	Platform    *HarborPlatform `json:"platform"`
}

type HarborArtifact struct {
	ID         int64             `json:"id"`
	Type       string            `json:"type"`
	Digest     string            `json:"digest"`
	Size       int64             `json:"size"`
	PushTime   string            `json:"push_time"`
	PullTime   string            `json:"pull_time"`
	MediaType  string            `json:"media_type"`
	Tags       []HarborTag       `json:"tags"`
	Platform   *HarborPlatform   `json:"platform"`
	References []HarborReference `json:"references"`
	// Computed from Platform/References by Artifacts(), not decoded — Harbor
	// sends the parts, the UI wants the answer. It was missing for a while, and
	// the tag table read it as undefined: the badges showed up on the project
	// overview (a different struct) and nowhere else.
	Arches []string `json:"arches,omitempty"`
}

// arches lists the artifact's architectures, de-duplicated and in a stable
// order. A multi-arch image answers from its references; a single-arch one from
// its own platform.
func (a *HarborArtifact) arches() []string {
	seen := map[string]bool{}
	var out []string
	add := func(p *HarborPlatform) {
		if p == nil || p.Architecture == "" || seen[p.Architecture] {
			return
		}
		seen[p.Architecture] = true
		out = append(out, p.Architecture)
	}
	add(a.Platform)
	for _, r := range a.References {
		add(r.Platform)
	}
	return out
}

func (h *HarborClient) Artifacts(ctx context.Context, project, repo string) ([]HarborArtifact, error) {
	p := url.PathEscape(project)
	r := url.PathEscape(repo)
	data, code, err := h.do(ctx, http.MethodGet, "/api/v2.0/projects/"+p+"/repositories/"+r+"/artifacts?page=1&page_size=100&with_tag=true")
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("harbor artifacts failed (%d): %s", code, truncate(string(data), 300))
	}
	var out []HarborArtifact
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Arches = out[i].arches()
	}
	return out, nil
}

// UntaggedArtifact is an artifact no tag points at: unreachable by name, only by
// digest. Reclaiming it means deleting the artifact itself.
type UntaggedArtifact struct {
	Repository string `json:"repository"` // short name within the project
	Digest     string `json:"digest"`
	Size       int64  `json:"size"`
	PushTime   string `json:"push_time"`
	MediaType  string `json:"media_type"`
	// Protected marks an artifact the configured cleanup rules refuse to touch,
	// with Reason explaining which rule did it. The UI disables those rows, so a
	// rule never deletes something silently.
	Protected bool   `json:"protected,omitempty"`
	Reason    string `json:"protectedReason,omitempty"`
}

// UntaggedScan is the result of walking a project for dangling artifacts.
// RepositoryErrors and Truncated are reported rather than swallowed: an
// incomplete scan must never look like a clean registry.
type UntaggedScan struct {
	Items      []UntaggedArtifact `json:"items"`
	Scanned    int                `json:"scannedRepositories"`
	Total      int                `json:"totalRepositories"`
	Truncated  bool               `json:"truncated"`
	RepoErrors []string           `json:"repositoryErrors,omitempty"`
	TotalSize  int64              `json:"totalSize"`

	// Rules that produced the scan, echoed back so the dialog can explain the
	// result without guessing, plus the counters they imply.
	Rules          map[string]any `json:"rules"`
	ProtectedCount int            `json:"protectedCount"`
	EligibleCount  int            `json:"eligibleCount"`
	EligibleSize   int64          `json:"eligibleSize"`
}

// mgmtErr shapes a management-API failure. A 401 here deserves special wording:
// public projects read fine without credentials, so a rejected login often goes
// unnoticed until one of these calls — the message says what to do about it.
func mgmtErr(what string, code int, data []byte, err error) error {
	if err != nil {
		return fmt.Errorf("%s failed: %w", what, err)
	}
	if code == http.StatusUnauthorized {
		return fmt.Errorf("%s failed (401 unauthorized): Harbor rejected the connection credentials — run Settings → Connection diagnostics to pinpoint the cause (wrong username/password, a \"No Authentication\" connection, or a non-admin account)", what)
	}
	return fmt.Errorf("%s failed (%d): %s", what, code, truncate(string(data), 200))
}

// artifactPages fetches each repository's artifacts concurrently, bounded by
// workers. The result is index-aligned with repos; errMsgs[i] is empty when the
// repository was read successfully. Writes go to per-index slots so the
// goroutines never share a slice that is being appended to.
func (h *HarborClient) artifactPages(ctx context.Context, project string, repos []HarborRepository, workers int) ([][]HarborArtifact, []string) {
	pages := make([][]HarborArtifact, len(repos))
	errMsgs := make([]string, len(repos))
	poolMap(workers, len(repos), func(i int) {
		arts, err := h.Artifacts(ctx, project, repos[i].Name)
		if err != nil {
			errMsgs[i] = fmt.Sprintf("%s: %v", repos[i].Name, err)
			return
		}
		pages[i] = arts
	})
	return pages, errMsgs
}

// Untagged lists dangling artifacts across a project.
//
// Harbor only reports tags per artifact, so this walks the project's
// repositories and keeps the artifacts whose tag list is empty. rules decides
// which of those the user may actually delete; the rest come back marked
// Protected with the reason, so the dialog can show why instead of hiding them.
func (h *HarborClient) Untagged(ctx context.Context, project string, rules CleanupRules) (*UntaggedScan, error) {
	repos, err := h.Repositories(ctx, project)
	if err != nil {
		return nil, err
	}
	maxRepos := rules.MaxReposPerScan
	scan := &UntaggedScan{Items: []UntaggedArtifact{}, Total: len(repos)}
	if maxRepos > 0 && len(repos) > maxRepos {
		repos = repos[:maxRepos]
		scan.Truncated = true
	}

	now := time.Now()
	pages, errMsgs := h.artifactPages(ctx, project, repos, 6)
	for i, arts := range pages {
		if errMsgs[i] != "" {
			// One unreadable repository must not fail the whole scan.
			scan.RepoErrors = append(scan.RepoErrors, errMsgs[i])
			continue
		}
		repo := repos[i]
		scan.Scanned++
		batch := []UntaggedArtifact{}
		for _, a := range arts {
			// Harbor omits `tags` entirely when there are none; both empty and
			// absent mean dangling. Index/attestation artifacts are skipped: they
			// belong to an image and would break it.
			if len(a.Tags) > 0 || a.Digest == "" || !isDeletableArtifactType(a.Type) {
				continue
			}
			batch = append(batch, UntaggedArtifact{
				Repository: repo.Name,
				Digest:     a.Digest,
				Size:       a.Size,
				PushTime:   a.PushTime,
				MediaType:  a.MediaType,
			})
		}
		applyCleanupRules(batch, rules, project, repo.Name, now)
		for _, it := range batch {
			if it.Protected {
				scan.ProtectedCount++
			} else {
				scan.EligibleCount++
				scan.EligibleSize += it.Size
			}
			scan.TotalSize += it.Size
		}
		scan.Items = append(scan.Items, batch...)
	}
	scan.Rules = map[string]any{
		"keepUntagged":    rules.KeepUntagged,
		"minAgeDays":      rules.MinAgeDays,
		"excludeRepos":    sortedPatterns(rules.ExcludeRepos),
		"maxReposPerScan": rules.MaxReposPerScan,
	}
	return scan, nil
}

// applyCleanupRules marks the artifacts a policy forbids deleting.
//
// Three rules, applied in the order a user would explain them: an excluded
// repository is out entirely, then anything too young, then the newest N are
// reserved. An artifact whose push time cannot be parsed is treated as the
// newest one when any age-dependent rule is active — refusing to delete
// something we cannot date is the only safe reading.
func applyCleanupRules(items []UntaggedArtifact, rules CleanupRules, project, repo string, now time.Time) {
	if len(items) == 0 {
		return
	}
	if pat, hit := matchAny(rules.ExcludeRepos, repo, project+"/"+repo); hit {
		for i := range items {
			items[i].Protected = true
			items[i].Reason = "repository is excluded by rule " + strconv.Quote(pat)
		}
		return
	}

	ageRuleActive := rules.MinAgeDays > 0
	keepRuleActive := rules.KeepUntagged > 0
	if !ageRuleActive && !keepRuleActive {
		return
	}

	// Rank newest-first; undateable entries sort to the front so they fall
	// inside the reservation rather than outside it.
	order := make([]int, len(items))
	for i := range order {
		order[i] = i
	}
	times := make([]time.Time, len(items))
	dated := make([]bool, len(items))
	for i, it := range items {
		times[i], dated[i] = parsePushTime(it.PushTime)
	}
	sort.SliceStable(order, func(a, b int) bool {
		ia, ib := order[a], order[b]
		if dated[ia] != dated[ib] {
			return !dated[ia]
		}
		if !dated[ia] {
			return false
		}
		return times[ia].After(times[ib])
	})
	reserved := map[int]bool{}
	for k := 0; k < rules.KeepUntagged && k < len(order); k++ {
		reserved[order[k]] = true
	}

	for i := range items {
		if !dated[i] {
			items[i].Protected = true
			items[i].Reason = "push time is missing or unparsable; kept because its age cannot be verified"
			continue
		}
		if ageRuleActive && now.Sub(times[i]) < time.Duration(rules.MinAgeDays)*24*time.Hour {
			items[i].Protected = true
			items[i].Reason = fmt.Sprintf("younger than the %d day minimum age", rules.MinAgeDays)
			continue
		}
		if reserved[i] {
			items[i].Protected = true
			items[i].Reason = fmt.Sprintf("inside the %d newest untagged artifacts that are kept", rules.KeepUntagged)
		}
	}
}

// parsePushTime reads the RFC3339 timestamps Harbor reports.
func parsePushTime(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999999999Z"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// protectedUnderRules re-decides a single artifact against the rules.
//
// The scan is only a proposal; this is the check the delete actually runs, so a
// rule edited between scan and confirm, or a listing that changed in between,
// cannot slip through.
//
// Rules that need no context (repository exclusion, minimum age) are evaluated
// straight off the artifact. The "keep the newest N" rule needs the repository's
// dangling set, so it is recomputed from repoArtifacts; when the artifact is not
// in that listing the ranking cannot be verified and the artifact is refused
// rather than assumed safe.
func protectedUnderRules(art UntaggedArtifact, repoArtifacts []HarborArtifact, rules CleanupRules, project, repo string, now time.Time) (string, bool) {
	if pat, hit := matchAny(rules.ExcludeRepos, repo, project+"/"+repo); hit {
		return "repository is excluded by rule " + strconv.Quote(pat), true
	}
	if rules.MinAgeDays > 0 {
		t, ok := parsePushTime(art.PushTime)
		switch {
		case !ok:
			return "push time is missing or unparsable; kept because its age cannot be verified", true
		case now.Sub(t) < time.Duration(rules.MinAgeDays)*24*time.Hour:
			return fmt.Sprintf("younger than the %d day minimum age", rules.MinAgeDays), true
		}
	}
	if rules.KeepUntagged > 0 {
		batch := []UntaggedArtifact{}
		for _, a := range repoArtifacts {
			if len(a.Tags) > 0 || a.Digest == "" || !isDeletableArtifactType(a.Type) {
				continue
			}
			batch = append(batch, UntaggedArtifact{
				Repository: repo, Digest: a.Digest, Size: a.Size, PushTime: a.PushTime, MediaType: a.MediaType,
			})
		}
		applyCleanupRules(batch, rules, project, repo, now)
		found := false
		for _, it := range batch {
			if it.Digest != art.Digest {
				continue
			}
			found = true
			if it.Protected {
				return it.Reason, true
			}
		}
		if !found {
			return fmt.Sprintf("not found in the repository listing, so the %d-newest reservation cannot be verified", rules.KeepUntagged), true
		}
	}
	return "", false
}

// isDeletableArtifactType restricts cleanup to standalone content.
//
// Images and Helm charts are the artifacts a repository is actually made of, so
// an untagged one is genuine garbage. Other types (CNAB, WASM, UNKNOWN) are left
// alone: their lifecycle is not obvious from the API alone, and offering them
// for bulk deletion is not worth the risk.
//
// An empty type means Harbor omitted the field; treat it as an image, since that
// is what the overwhelming majority of artifacts are.
func isDeletableArtifactType(t string) bool {
	switch t {
	case "", "IMAGE", "CHART":
		return true
	default:
		return false
	}
}

// Artifact re-reads a single artifact (tags included) right before it is
// deleted. Returns (nil, nil) when the registry says it is gone.
//
// The scan can be minutes old by the time the operator confirms, and a digest
// that was dangling then may be tagged now. Deleting it anyway would destroy a
// live image, so every delete is gated on this fresh read.
func (h *HarborClient) Artifact(ctx context.Context, project, repo, reference string) (*HarborArtifact, error) {
	p := url.PathEscape(project)
	r := url.PathEscape(repo)
	a := url.PathEscape(reference)
	data, code, err := h.do(ctx, http.MethodGet,
		"/api/v2.0/projects/"+p+"/repositories/"+r+"/artifacts/"+a+"?with_tag=true")
	if err != nil {
		return nil, err
	}
	if code == http.StatusNotFound {
		return nil, nil
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("harbor artifact lookup failed (%d): %s", code, truncate(string(data), 200))
	}
	var art HarborArtifact
	if err := json.Unmarshal(data, &art); err != nil {
		return nil, err
	}
	return &art, nil
}

func (h *HarborClient) DeleteTag(ctx context.Context, project, repo, reference, tag string) error {
	p := url.PathEscape(project)
	r := url.PathEscape(repo)
	a := url.PathEscape(reference)
	t := url.PathEscape(tag)
	data, code, err := h.do(ctx, http.MethodDelete, "/api/v2.0/projects/"+p+"/repositories/"+r+"/artifacts/"+a+"/tags/"+t)
	if err != nil {
		return err
	}
	if code != http.StatusOK && code != http.StatusNoContent && code != http.StatusAccepted {
		return fmt.Errorf("harbor delete tag failed (%d): %s", code, truncate(string(data), 300))
	}
	return nil
}

func (h *HarborClient) DeleteArtifact(ctx context.Context, project, repo, reference string) error {
	p := url.PathEscape(project)
	r := url.PathEscape(repo)
	a := url.PathEscape(reference)
	data, code, err := h.do(ctx, http.MethodDelete, "/api/v2.0/projects/"+p+"/repositories/"+r+"/artifacts/"+a)
	if err != nil {
		return err
	}
	if code != http.StatusOK && code != http.StatusNoContent && code != http.StatusAccepted {
		return fmt.Errorf("harbor delete artifact failed (%d): %s", code, truncate(string(data), 300))
	}
	return nil
}

// Vulnerabilities returns the raw vulnerability report JSON (Trivy / Harbor format).
func (h *HarborClient) Vulnerabilities(ctx context.Context, project, repo, reference string) (json.RawMessage, error) {
	p := url.PathEscape(project)
	r := url.PathEscape(repo)
	a := url.PathEscape(reference)
	data, code, err := h.do(ctx, http.MethodGet, "/api/v2.0/projects/"+p+"/repositories/"+r+"/artifacts/"+a+"/additions/vulnerabilities")
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("harbor vulnerabilities failed (%d): %s", code, truncate(string(data), 300))
	}
	// Harbor may wrap the report under a media-type key; unwrap if so.
	var wrapper map[string]json.RawMessage
	if err := json.Unmarshal(data, &wrapper); err == nil {
		for k, v := range wrapper {
			if strings.Contains(strings.ToLower(k), "vulnerability") {
				return v, nil
			}
		}
	}
	return data, nil
}

// ---------------------------------------------------------------------------
// Scanners and project-level scan policy
//
// Harbor owns the scanners; what the plugin can genuinely do is read what is
// configured, change the project's choice, and trigger a scan. All of it is
// real API traffic — nothing here is a stored preference pretending to be a
// feature.
// ---------------------------------------------------------------------------

type HarborScanner struct {
	UUID        string `json:"uuid"`
	Name        string `json:"name"`
	Description string `json:"description"`
	URL         string `json:"url"`
	IsDefault   bool   `json:"is_default"`
	Health      string `json:"health"`
}

// doBody is the request helper for the endpoints that need a JSON payload.
func (h *HarborClient) doBody(ctx context.Context, method, path string, payload any) ([]byte, int, error) {
	var body io.Reader
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return nil, 0, err
		}
		body = strings.NewReader(string(b))
	}
	req, err := http.NewRequestWithContext(ctx, method, h.base+path, body)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("accept", "application/json")
	if payload != nil {
		req.Header.Set("content-type", "application/json")
	}
	if h.cred != nil && h.cred.Header() != "" {
		req.Header.Set("authorization", h.cred.Header())
	}
	resp, err := h.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return data, resp.StatusCode, nil
}

// Scanners lists the scanners registered in Harbor. This is a system-level
// endpoint, so a non-admin account gets 403 — the caller reports that as a
// note rather than failing the whole panel.
func (h *HarborClient) Scanners(ctx context.Context) ([]HarborScanner, error) {
	data, code, err := h.do(ctx, http.MethodGet, "/api/v2.0/scanners?page=1&page_size=100")
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, mgmtErr("listing scanners", code, data, nil)
	}
	var out []HarborScanner
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ProjectScanner returns the scanner uuid the project is pinned to. An empty
// uuid means the project follows the system default.
func (h *HarborClient) ProjectScanner(ctx context.Context, project string) (string, error) {
	p := url.PathEscape(project)
	data, code, err := h.do(ctx, http.MethodGet, "/api/v2.0/projects/"+p+"/scanner")
	if err != nil {
		return "", err
	}
	if code != http.StatusOK {
		return "", mgmtErr("reading the project scanner", code, data, nil)
	}
	var out HarborScanner
	if err := json.Unmarshal(data, &out); err != nil {
		return "", err
	}
	return out.UUID, nil
}

// ProjectMetadata returns the project's metadata map (auto_scan, prevent_vul,
// severity, ...). Read before writing so an update cannot drop keys this plugin
// does not know about.
func (h *HarborClient) ProjectMetadata(ctx context.Context, project string) (map[string]any, error) {
	p := url.PathEscape(project)
	data, code, err := h.do(ctx, http.MethodGet, "/api/v2.0/projects/"+p)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("reading project metadata failed (%d): %s", code, truncate(string(data), 200))
	}
	var out struct {
		Metadata map[string]any `json:"metadata"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	return out.Metadata, nil
}

// UpdateProjectMetadata writes the whole metadata map back (read-modify-write,
// so unrelated keys survive).
func (h *HarborClient) UpdateProjectMetadata(ctx context.Context, project string, meta map[string]any) error {
	p := url.PathEscape(project)
	data, code, err := h.doBody(ctx, http.MethodPut, "/api/v2.0/projects/"+p, map[string]any{"metadata": meta})
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return mgmtErr("updating project metadata", code, data, nil)
	}
	return nil
}

// SetProjectScanner pins the project to a scanner uuid.
func (h *HarborClient) SetProjectScanner(ctx context.Context, project, uuid string) error {
	p := url.PathEscape(project)
	data, code, err := h.doBody(ctx, http.MethodPut, "/api/v2.0/projects/"+p+"/scanner", map[string]any{"uuid": uuid})
	if err != nil {
		return err
	}
	if code != http.StatusOK && code != http.StatusCreated {
		return fmt.Errorf("setting the project scanner failed (%d): %s", code, truncate(string(data), 300))
	}
	return nil
}

// ProjectImage is one image (artifact) in the project-level overview. Tags are
// carried so the pull/retag actions still work, but the overview itself is
// image-first: a row is a digest, not a tag.
type ProjectImage struct {
	Repository string   `json:"repository"` // short name within the project
	Digest     string   `json:"digest"`
	Type       string   `json:"type"`
	Size       int64    `json:"size"`
	PushTime   string   `json:"push_time"`
	Tags       []string `json:"tags"`
	Arches     []string `json:"arches,omitempty"`
	TagCount   int      `json:"tagCount"`
}

// ProjectImages is the project-level image overview: every artifact across every
// repository, plus the totals the view shows up top. RepositoryErrors and
// Truncated are reported rather than swallowed so a partial walk never reads as
// a complete one.
// ProjectRepo is one repository as the overview lists it.
//
// The overview used to show one row per artifact, which on a real project meant
// 58 rows for 13 repositories — the same name repeated, each row carrying that
// single artifact's tag count, so the column read 1 or 0 almost everywhere.
// A repository is the unit people think in here; the per-image detail is one
// click away, in the repository's own tag view.
type ProjectRepo struct {
	Repository string   `json:"repository"`
	ImageCount int      `json:"imageCount"`
	TagCount   int      `json:"tagCount"`
	TotalSize  int64    `json:"totalSize"`
	PushedAt   string   `json:"pushedAt"`
	Arches     []string `json:"arches,omitempty"`
	// The newest tag and its digest, which is what a pull command and a
	// vulnerability lookup need. Empty when the repository holds no tagged image.
	LatestTag    string `json:"latestTag,omitempty"`
	LatestDigest string `json:"latestDigest,omitempty"`
}

type ProjectImages struct {
	Project         string         `json:"project"`
	RepositoryCount int            `json:"repositoryCount"`
	ImageCount      int            `json:"imageCount"`
	TagCount        int            `json:"tagCount"`
	TotalSize       int64          `json:"totalSize"`
	Images          []ProjectImage `json:"images"`
	// Repositories is what the overview table renders; Images stays because the
	// numbers above are derived from it and the per-image view still needs it.
	Repositories []ProjectRepo `json:"repositories"`
	Truncated    bool          `json:"truncated"`
	RepoErrors   []string      `json:"repositoryErrors,omitempty"`
}

// ProjectImages walks every repository in a project and aggregates its artifacts
// into a single image listing. maxRepos bounds the walk; a bigger project is cut
// off and flagged, never silently half-listed.
func (h *HarborClient) ProjectImages(ctx context.Context, project string, maxRepos int) (*ProjectImages, error) {
	repos, err := h.Repositories(ctx, project)
	if err != nil {
		return nil, err
	}
	out := &ProjectImages{Project: project, Images: []ProjectImage{}, RepositoryCount: len(repos)}
	if maxRepos > 0 && len(repos) > maxRepos {
		repos = repos[:maxRepos]
		out.Truncated = true
	}

	// Concurrent fetch keeps the overview fast on a project with many
	// repositories; aggregation below stays sequential and deterministic.
	pages, errMsgs := h.artifactPages(ctx, project, repos, 6)
	for i, arts := range pages {
		if errMsgs[i] != "" {
			out.RepoErrors = append(out.RepoErrors, errMsgs[i])
			continue
		}
		for _, a := range arts {
			tags := make([]string, 0, len(a.Tags))
			for _, t := range a.Tags {
				tags = append(tags, t.Name)
			}
			out.Images = append(out.Images, ProjectImage{
				Repository: repos[i].Name,
				Digest:     a.Digest,
				Type:       a.Type,
				Size:       a.Size,
				PushTime:   a.PushTime,
				Tags:       tags,
				Arches:     a.arches(),
				TagCount:   len(tags),
			})
			out.TagCount += len(tags)
		}
	}
	out.ImageCount = len(out.Images)
	// Newest images first: the overview is for scanning, not for archaeology.
	sort.SliceStable(out.Images, func(i, j int) bool {
		return out.Images[i].PushTime > out.Images[j].PushTime
	})
	for _, im := range out.Images {
		out.TotalSize += im.Size
	}
	out.Repositories = aggregateRepositories(out.Images, repos)
	return out, nil
}

// aggregateRepositories folds the per-artifact listing into one row per
// repository: how many images it holds, how many tags point at them, their
// combined size, when it was last pushed, and the newest tag to pull.
func aggregateRepositories(images []ProjectImage, repos []HarborRepository) []ProjectRepo {
	byName := map[string]*ProjectRepo{}
	archSeen := map[string]map[string]bool{}
	for _, im := range images {
		r := byName[im.Repository]
		if r == nil {
			r = &ProjectRepo{Repository: im.Repository}
			byName[im.Repository] = r
			archSeen[im.Repository] = map[string]bool{}
		}
		r.ImageCount++
		r.TagCount += im.TagCount
		r.TotalSize += im.Size
		// Images arrive newest first, so the first one seen for a repository is
		// its most recent — and the first tagged one is what a pull uses.
		if im.PushTime > r.PushedAt {
			r.PushedAt = im.PushTime
		}
		if r.LatestTag == "" && len(im.Tags) > 0 {
			r.LatestTag = im.Tags[0]
			r.LatestDigest = im.Digest
		}
		for _, a := range im.Arches {
			archSeen[im.Repository][a] = true
		}
	}
	// Repositories that reported no artifacts still belong in the list: an empty
	// repository is a fact about the registry, not a reason to omit the name.
	for _, repo := range repos {
		if byName[repo.Name] == nil {
			byName[repo.Name] = &ProjectRepo{Repository: repo.Name}
			archSeen[repo.Name] = map[string]bool{}
		}
	}

	out := make([]ProjectRepo, 0, len(byName))
	for name, r := range byName {
		arches := make([]string, 0, len(archSeen[name]))
		for a := range archSeen[name] {
			arches = append(arches, a)
		}
		sort.Strings(arches)
		r.Arches = arches
		out = append(out, *r)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].PushedAt != out[j].PushedAt {
			return out[i].PushedAt > out[j].PushedAt
		}
		return out[i].Repository < out[j].Repository
	})
	return out
}

// TriggerScan asks Harbor to scan (or rescan) one artifact.
func (h *HarborClient) TriggerScan(ctx context.Context, project, repo, reference string) error {
	p := url.PathEscape(project)
	r := url.PathEscape(repo)
	a := url.PathEscape(reference)
	data, code, err := h.doBody(ctx, http.MethodPost,
		"/api/v2.0/projects/"+p+"/repositories/"+r+"/artifacts/"+a+"/scan",
		map[string]any{"scan_type": "vulnerability"})
	if err != nil {
		return err
	}
	// 202 = accepted; 200 shows up on older Harbor builds.
	if code != http.StatusAccepted && code != http.StatusOK {
		return mgmtErr("triggering a scan", code, data, nil)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Project administration: members, retention policy, and users
//
// Everything here is real Harbor API traffic behind admin privileges. Reads are
// done before writes ("先读已有，后写改动") so an update never blind-overwrites
// state the plugin does not understand.
// ---------------------------------------------------------------------------

// HarborMember is one project member (a user granted a role on the project).
type HarborMember struct {
	ID         int    `json:"id"`
	EntityName string `json:"entity_name"`
	EntityID   int    `json:"entity_id"`
	EntityType string `json:"entity_type"`
	RoleID     int    `json:"role_id"`
	RoleName   string `json:"role_name"`
}

func (h *HarborClient) Members(ctx context.Context, project string) ([]HarborMember, error) {
	p := url.PathEscape(project)
	data, code, err := h.do(ctx, http.MethodGet, "/api/v2.0/projects/"+p+"/members?page=1&page_size=100")
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, mgmtErr("listing project members", code, data, nil)
	}
	var out []HarborMember
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (h *HarborClient) AddMember(ctx context.Context, project string, roleID int, username string) error {
	p := url.PathEscape(project)
	body := map[string]any{"role_id": roleID, "member_user": map[string]any{"username": username}}
	data, code, err := h.doBody(ctx, http.MethodPost, "/api/v2.0/projects/"+p+"/members", body)
	if err != nil {
		return err
	}
	if code != http.StatusCreated && code != http.StatusOK {
		return mgmtErr("adding a member", code, data, nil)
	}
	return nil
}

func (h *HarborClient) UpdateMemberRole(ctx context.Context, project string, memberID, roleID int) error {
	p := url.PathEscape(project)
	data, code, err := h.doBody(ctx, http.MethodPut,
		fmt.Sprintf("/api/v2.0/projects/%s/members/%d", p, memberID),
		map[string]any{"role_id": roleID})
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return mgmtErr("updating a member role", code, data, nil)
	}
	return nil
}

func (h *HarborClient) RemoveMember(ctx context.Context, project string, memberID int) error {
	p := url.PathEscape(project)
	data, code, err := h.do(ctx, http.MethodDelete,
		fmt.Sprintf("/api/v2.0/projects/%s/members/%d", p, memberID))
	if err != nil {
		return err
	}
	if code != http.StatusOK && code != http.StatusNoContent {
		return mgmtErr("removing a member", code, data, nil)
	}
	return nil
}

// HarborUser is a registry user account.
type HarborUser struct {
	UserID   int    `json:"user_id"`
	Username string `json:"username"`
	Email    string `json:"email"`
	Realname string `json:"realname"`
	Comment  string `json:"comment"`
	SysAdmin bool   `json:"sysadmin_flag"`
	Creation string `json:"creation_time"`
}

func (h *HarborClient) Users(ctx context.Context) ([]HarborUser, error) {
	data, code, err := h.do(ctx, http.MethodGet, "/api/v2.0/users?page=1&page_size=100")
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, mgmtErr("listing users", code, data, nil)
	}
	var out []HarborUser
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CurrentUser returns the authenticated account. /users/current answers for any
// valid user login regardless of admin rights, which is exactly what the
// user-management panel needs to decide what to reveal.
func (h *HarborClient) CurrentUser(ctx context.Context) (*HarborUser, error) {
	data, code, err := h.do(ctx, http.MethodGet, "/api/v2.0/users/current")
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, mgmtErr("reading the current user", code, data, nil)
	}
	var out HarborUser
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (h *HarborClient) CreateUser(ctx context.Context, username, email, realname, password, comment string) error {
	body := map[string]any{
		"username": username,
		"email":    email,
		"realname": realname,
		"password": password,
		"comment":  comment,
	}
	data, code, err := h.doBody(ctx, http.MethodPost, "/api/v2.0/users", body)
	if err != nil {
		return err
	}
	if code != http.StatusCreated && code != http.StatusOK {
		return mgmtErr("creating a user", code, data, nil)
	}
	return nil
}

// SetUserPassword resets a user's password. An admin resets another user without
// knowing the old one; the old_password is accepted but optional here.
func (h *HarborClient) SetUserPassword(ctx context.Context, userID int, newPassword string) error {
	data, code, err := h.doBody(ctx, http.MethodPut,
		fmt.Sprintf("/api/v2.0/users/%d/password", userID),
		map[string]any{"new_password": newPassword})
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return mgmtErr("setting the password", code, data, nil)
	}
	return nil
}

func (h *HarborClient) SetUserAdmin(ctx context.Context, userID int, admin bool) error {
	data, code, err := h.doBody(ctx, http.MethodPut,
		fmt.Sprintf("/api/v2.0/users/%d/sysadmin", userID),
		map[string]any{"sysadmin_flag": admin})
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return mgmtErr("setting sysadmin", code, data, nil)
	}
	return nil
}

func (h *HarborClient) DeleteUser(ctx context.Context, userID int) error {
	data, code, err := h.do(ctx, http.MethodDelete, fmt.Sprintf("/api/v2.0/users/%d", userID))
	if err != nil {
		return err
	}
	if code != http.StatusOK && code != http.StatusNoContent {
		return mgmtErr("deleting a user", code, data, nil)
	}
	return nil
}

// HarborRetentionRule mirrors Harbor's retention rule shape.
type HarborRetentionRule struct {
	ID             int              `json:"id"`
	Priority       int              `json:"priority"`
	Disabled       bool             `json:"disabled"`
	Action         string           `json:"action"`
	Template       string           `json:"template"`
	Params         map[string]any   `json:"params"`
	TagSelectors   []map[string]any `json:"tag_selectors"`
	ScopeSelectors map[string]any   `json:"scope_selectors"`
}

// HarborRetention is a project's tag retention policy.
type HarborRetention struct {
	ID        int64                 `json:"id"`
	Algorithm string                `json:"algorithm"`
	Rules     []HarborRetentionRule `json:"rules"`
	Trigger   map[string]any        `json:"trigger"`
	Scope     map[string]any        `json:"scope"`
}

// ProjectDetail is the subset of GET /projects/{p} the admin panel needs.
type ProjectDetail struct {
	ProjectID   int            `json:"project_id"`
	Name        string         `json:"name"`
	Public      bool           `json:"public"`
	RetentionID int64          `json:"retention_id"`
	Metadata    map[string]any `json:"metadata"`
}

// ProjectDetail reads the project header, including the retention policy id it
// is bound to (when one exists).
func (h *HarborClient) ProjectDetail(ctx context.Context, project string) (*ProjectDetail, error) {
	p := url.PathEscape(project)
	data, code, err := h.do(ctx, http.MethodGet, "/api/v2.0/projects/"+p)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, mgmtErr("reading the project", code, data, nil)
	}
	var raw struct {
		ProjectID         int            `json:"project_id"`
		Name              string         `json:"name"`
		Public            bool           `json:"public"`
		Metadata          map[string]any `json:"metadata"`
		CurrentUserRoleID int            `json:"current_user_role_id"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	detail := &ProjectDetail{
		ProjectID: raw.ProjectID,
		Name:      raw.Name,
		Public:    raw.Public,
		Metadata:  raw.Metadata,
	}
	if raw.Metadata != nil {
		// Harbor stores the public/private flag in metadata.public; the top-level
		// `public` field is derived, so prefer the source of truth when present.
		if v, ok := raw.Metadata["public"]; ok {
			switch t := v.(type) {
			case string:
				detail.Public = t == "true"
			case bool:
				detail.Public = t
			}
		}
		if v, ok := raw.Metadata["retention_id"]; ok {
			switch t := v.(type) {
			case float64:
				detail.RetentionID = int64(t)
			case string:
				detail.RetentionID, _ = strconv.ParseInt(t, 10, 64)
			}
		}
	}
	return detail, nil
}

// SetProjectPublic flips a project between public and private. Harbor stores the
// flag in metadata.public, so this reads the current metadata first ("先读已有，
// 后写改动") and writes back the whole map — unrelated keys survive.
func (h *HarborClient) SetProjectPublic(ctx context.Context, project string, public bool) error {
	detail, err := h.ProjectDetail(ctx, project)
	if err != nil {
		return err
	}
	meta := detail.Metadata
	if meta == nil {
		meta = map[string]any{}
	}
	meta["public"] = strconv.FormatBool(public)
	return h.UpdateProjectMetadata(ctx, project, meta)
}

// Retention reads the retention policy bound to a project, or nil when none.
func (h *HarborClient) Retention(ctx context.Context, id int64) (*HarborRetention, error) {
	if id == 0 {
		return nil, nil
	}
	data, code, err := h.do(ctx, http.MethodGet, fmt.Sprintf("/api/v2.0/retentions/%d", id))
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, mgmtErr("reading the retention policy", code, data, nil)
	}
	var out HarborRetention
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SaveRetention creates a project retention policy or updates the existing one.
// "先读已有，后写改动": the caller fetches the current policy (and its id) first,
// then submits the whole modified policy — Harbor has no partial retention patch.
func (h *HarborClient) SaveRetention(ctx context.Context, project string, projectID int, policy *HarborRetention) error {
	if policy.ID != 0 {
		data, code, err := h.doBody(ctx, http.MethodPut,
			fmt.Sprintf("/api/v2.0/retentions/%d", policy.ID), policy)
		if err != nil {
			return err
		}
		if code != http.StatusOK {
			return mgmtErr("updating the retention policy", code, data, nil)
		}
		return nil
	}
	// Create: bind the new policy to this project via scope.
	if policy.Scope == nil {
		policy.Scope = map[string]any{"level": "project", "ref": projectID}
	}
	data, code, err := h.doBody(ctx, http.MethodPost, "/api/v2.0/retentions", policy)
	if err != nil {
		return err
	}
	if code != http.StatusCreated && code != http.StatusOK {
		return mgmtErr("creating the retention policy", code, data, nil)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Retention window
// ---------------------------------------------------------------------------

// retentionWindowBlocked refuses an operation that would remove one of the
// newest KeepTagged artifacts of a repository.
//
// "Keep the newest N artifacts" cannot be answered from a tag name — unlike the
// ProtectTags globs, it needs the repository's artifacts and their push times —
// so this guard costs a listing. It is consulted only when the setting is
// non-zero, so a connection that does not use the window pays nothing.
//
// The window was a UI hint for a long time: artifacts outside it were marked and
// nothing more, while deleting one of the newest N succeeded and contradicted
// what the setting says. It is enforced now, which is what the setting's name
// promises.
//
// Harbor only: a plain OCI v2 registry's tag list carries no push times, so
// "newest" is not knowable there. Saying so is better than ranking tags by name
// and calling that recency.
func (h *HarborClient) retentionWindowBlocked(ctx context.Context, project, repo, tag, digest string, keep int) error {
	if keep <= 0 {
		return nil
	}
	arts, err := h.Artifacts(ctx, project, repo)
	if err != nil {
		// A protection rule that fails open is not a protection rule. Refuse,
		// and say why, so the operator can retry rather than assume it passed.
		return fmt.Errorf("could not check the retention window for %s/%s (%v); refusing rather than skipping the check", project, repo, err)
	}
	sort.SliceStable(arts, func(i, j int) bool { return arts[i].PushTime > arts[j].PushTime })

	for i, a := range arts {
		if i >= keep {
			break
		}
		matched := false
		if digest != "" && a.Digest == digest {
			matched = true
		}
		if !matched && tag != "" {
			for _, t := range a.Tags {
				if t.Name == tag {
					matched = true
					break
				}
			}
		}
		if matched {
			return fmt.Errorf("this image is one of the %d most recent in %s (retention policy: keep the newest %d), so it is not deleted; change the policy in the plugin settings if that is intended",
				keep, repo, keep)
		}
	}
	return nil
}

// retentionKeep is the configured window, or 0 when the connection does not use
// one.
func (s *Session) retentionKeep() int {
	if s == nil {
		return 0
	}
	set, _ := settingsFor(s.Conn.ID)
	return set.Retention.KeepTagged
}

// guardRetentionWindow applies the window to one deletion, on the paths where a
// recency order exists.
func (s *Session) guardRetentionWindow(ctx context.Context, project, repo, tag, digest string) error {
	if s == nil || s.RegistryType != registryTypeHarbor {
		return nil
	}
	keep := s.retentionKeep()
	if keep <= 0 {
		return nil
	}
	return s.Harbor.retentionWindowBlocked(ctx, project, repo, tag, digest, keep)
}
