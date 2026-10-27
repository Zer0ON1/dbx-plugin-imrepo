package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Image archives — upload a .tar/.tar.gz into the registry, export one back out
//
// Both directions are deliberately file-based rather than "read the whole
// image into memory": a registry image is routinely several gigabytes. An
// upload is written to a temp file chunk by chunk, then indexed and pushed
// blob by blob; an export is streamed from the registry into a temp archive and
// handed to the UI four megabytes at a time. The UI never needs to hold the
// archive, and neither does the sidecar.
//
// Two archive shapes are accepted on upload:
//   * docker save output — manifest.json + config/layers (the modern containerd
//     output also carries index.json/oci-layout; manifest.json wins because it
//     names the tags the user actually saved);
//   * an OCI image layout — oci-layout + index.json + blobs/sha256/*.
// Exports can be either shape, with or without gzip.
// ---------------------------------------------------------------------------

const (
	// The DBX host bridge rejects a request whose JSON params exceed 2 MiB.
	// A 4 MiB raw chunk becomes ~5.6 MiB of base64 and trips that limit before
	// it ever reaches the sidecar, so upload chunks stay at 1 MiB: base64 plus
	// the envelope is ~1.4 MiB, leaving room for the host's own accounting.
	transferUploadChunkBytes = 1 << 20
	// Export chunks travel the other way (sidecar response → plugin), where the
	// bridge does not apply the request limit; the SDK's 8 MiB JSON cap is the
	// bound. 4 MiB raw → ~5.6 MiB of base64 is comfortably inside it.
	transferExportChunkBytes = 4 << 20
	transferMaxChunk         = 8 << 20  // hard cap on one inbound chunk
	transferSmallMax         = 32 << 20 // manifests/config blobs read into memory
	transferJobLimit         = 6 * time.Hour
	transferStaleAge         = 12 * time.Hour
)

var (
	digestPattern     = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	repositoryPattern = regexp.MustCompile(`^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*$`)
)

func validRepository(repo string) bool {
	return repo != "" && len(repo) <= 255 && repositoryPattern.MatchString(repo)
}

// validReference keeps a tag/digest reference from turning into a different
// /v2/ endpoint when it is concatenated into the manifest URL.
func validReference(ref string) bool {
	return tagPattern.MatchString(ref) || digestPattern.MatchString(ref)
}

// imageConfigMediaTypes identify a container image config. Helm charts and
// other OCI artifacts carry configs too, but docker load has no idea what to do
// with them — those can only be exported as an OCI layout.
func isImageConfigMediaType(mediaType string) bool {
	mt := cleanMediaType(mediaType)
	return mt == "" ||
		strings.Contains(mt, "image.config") ||
		strings.Contains(mt, "container.image")
}

// transferPlatform is the os/architecture[/variant] triple an image targets.
type transferPlatform struct {
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
	Variant      string `json:"variant,omitempty"`
}

func (p transferPlatform) String() string {
	if p.OS == "" && p.Architecture == "" {
		return ""
	}
	out := p.OS + "/" + p.Architecture
	if p.Variant != "" {
		out += "/" + p.Variant
	}
	return out
}

func platformFromDescriptor(p *ociPlatform) transferPlatform {
	if p == nil {
		return transferPlatform{}
	}
	return transferPlatform{OS: p.OS, Architecture: p.Architecture, Variant: p.Variant}
}

// transferImage is one selectable entry of an uploaded archive.
type transferImage struct {
	Format       string             `json:"format"` // docker | oci
	Refs         []string           `json:"refs,omitempty"`
	Repository   string             `json:"suggestedRepository,omitempty"`
	Tag          string             `json:"suggestedTag,omitempty"`
	MediaType    string             `json:"mediaType,omitempty"`
	Digest       string             `json:"digest,omitempty"`
	ConfigDigest string             `json:"configDigest,omitempty"`
	Layers       int                `json:"layers"`
	Size         int64              `json:"size"`
	Platforms    []transferPlatform `json:"platforms,omitempty"`

	docker *dockerImageRef
	oci    *ociDescriptor
}

type dockerImageRef struct {
	Config string
	Layers []string
}

// ---------------------------------------------------------------------------
// OCI JSON shapes shared by inspection, push and export
// ---------------------------------------------------------------------------

type ociPlatform struct {
	Architecture string `json:"architecture"`
	OS           string `json:"os"`
	Variant      string `json:"variant,omitempty"`
}

type ociDescriptor struct {
	MediaType   string            `json:"mediaType"`
	Digest      string            `json:"digest"`
	Size        int64             `json:"size"`
	Platform    *ociPlatform      `json:"platform,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

type ociDocument struct {
	SchemaVersion int               `json:"schemaVersion"`
	MediaType     string            `json:"mediaType"`
	Config        *ociDescriptor    `json:"config,omitempty"`
	Layers        []ociDescriptor   `json:"layers,omitempty"`
	Manifests     []ociDescriptor   `json:"manifests,omitempty"`
	Annotations   map[string]string `json:"annotations,omitempty"`
}

func isIndexDoc(doc *ociDocument) bool {
	return len(doc.Manifests) > 0 ||
		strings.Contains(doc.MediaType, "image.index") ||
		strings.Contains(doc.MediaType, "manifest.list")
}

type dockerManifestEntry struct {
	Config   string   `json:"Config"`
	RepoTags []string `json:"RepoTags"`
	Layers   []string `json:"Layers"`
}

type imageConfig struct {
	Architecture string `json:"architecture"`
	OS           string `json:"os"`
	Variant      string `json:"variant,omitempty"`
}

// ---------------------------------------------------------------------------
// Temp files and transfer jobs
// ---------------------------------------------------------------------------

type transferStore struct {
	mu      sync.Mutex
	uploads map[string]*uploadJob
	exports map[string]*exportJob
}

var transferJobs = &transferStore{uploads: map[string]*uploadJob{}, exports: map[string]*exportJob{}}

type uploadJob struct {
	id     string
	connID string
	name   string

	rawPath    string
	tarPath    string
	rawSize    int64
	tarSize    int64
	compressed bool
	format     string

	received int64
	state    string // uploading | parsing | ready | error
	errMsg   string
	images   []transferImage
	idx      *tarIndex

	created time.Time
	used    time.Time

	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
	push   pushProgress
}

type pushProgress struct {
	State      string `json:"state"` // idle | running | done | error
	Phase      string `json:"phase,omitempty"`
	Done       int64  `json:"done"`
	Total      int64  `json:"total"`
	BlobsDone  int    `json:"blobsDone"`
	BlobsTotal int    `json:"blobsTotal"`
	Repository string `json:"repository,omitempty"`
	Tag        string `json:"tag,omitempty"`
	Error      string `json:"error,omitempty"`
}

type exportJob struct {
	id       string
	connID   string
	name     string
	path     string
	format   string
	gzip     bool
	platform string
	tag      string

	state  string // preparing | running | ready | error
	errMsg string
	done   int64
	total  int64
	size   int64

	created time.Time
	used    time.Time

	mu     sync.Mutex
	cancel context.CancelFunc
	doneCh chan struct{}
}

func newTransferID() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

func transferDirectory() (string, error) {
	if dir, err := pluginConfigDir(); err == nil && dir != "" {
		p := filepath.Join(dir, "transfers")
		if err := os.MkdirAll(p, 0o700); err == nil {
			return p, nil
		}
	}
	p := filepath.Join(os.TempDir(), "imrepo-transfers")
	if err := os.MkdirAll(p, 0o700); err != nil {
		return "", fmt.Errorf("cannot create the transfer directory: %w", err)
	}
	return p, nil
}

// sweepTransferFiles is best effort: the directory is this plugin's own, and a
// sidecar that was killed mid-transfer must not accumulate archives forever.
func sweepTransferFiles(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-24 * time.Hour)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || info.IsDir() {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

func (st *transferStore) sweepJobs() {
	cutoff := time.Now().Add(-transferStaleAge)
	var oldUploads []*uploadJob
	var oldExports []*exportJob
	st.mu.Lock()
	for id, j := range st.uploads {
		j.mu.Lock()
		if j.used.Before(cutoff) {
			oldUploads = append(oldUploads, j)
			delete(st.uploads, id)
		}
		j.mu.Unlock()
	}
	for id, j := range st.exports {
		j.mu.Lock()
		if j.used.Before(cutoff) {
			oldExports = append(oldExports, j)
			delete(st.exports, id)
		}
		j.mu.Unlock()
	}
	st.mu.Unlock()
	for _, j := range oldUploads {
		if j.cancel != nil {
			j.cancel()
		}
		removeIfExists(j.rawPath)
		removeIfExists(j.tarPath)
	}
	for _, j := range oldExports {
		if j.cancel != nil {
			j.cancel()
		}
		removeIfExists(j.path)
	}
}

func removeIfExists(name string) {
	if name != "" {
		_ = os.Remove(name)
	}
}

// ---------------------------------------------------------------------------
// Tar index
// ---------------------------------------------------------------------------

type tarEntry struct {
	Offset int64
	Size   int64
}

type tarIndex struct {
	Path    string
	Size    int64
	Entries map[string]tarEntry
}

// countSeeker tracks the logical position of the tar stream and still lets
// archive/tar seek over entry bodies (discard uses io.Seeker when available),
// so indexing a multi-gigabyte archive reads headers, not gigabytes.
type countSeeker struct {
	f *os.File
	n int64
}

func (c *countSeeker) Read(p []byte) (int, error) {
	n, err := c.f.Read(p)
	c.n += int64(n)
	return n, err
}

func (c *countSeeker) Seek(offset int64, whence int) (int64, error) {
	pos, err := c.f.Seek(offset, whence)
	if err == nil {
		c.n = pos
	}
	return pos, err
}

func indexTarFile(name string) (*tarIndex, error) {
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	cs := &countSeeker{f: f}
	tr := tar.NewReader(cs)
	idx := &tarIndex{Path: name, Size: info.Size(), Entries: map[string]tarEntry{}}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("reading the archive failed: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg && hdr.Typeflag != tar.TypeRegA {
			continue
		}
		entryName := strings.TrimPrefix(hdr.Name, "./")
		if entryName == "" || strings.HasPrefix(entryName, "/") || strings.Contains(entryName, "..") || hdr.Size < 0 {
			continue // never used as a path on disk; refuse to index it
		}
		if _, exists := idx.Entries[entryName]; !exists {
			idx.Entries[entryName] = tarEntry{Offset: cs.n, Size: hdr.Size}
		}
	}
	return idx, nil
}

func (idx *tarIndex) open(name string) (io.ReadCloser, int64, error) {
	entry, ok := idx.Entries[name]
	if !ok {
		return nil, 0, fmt.Errorf("%q is missing from the archive", name)
	}
	f, err := os.Open(idx.Path)
	if err != nil {
		return nil, 0, err
	}
	return &sectionCloser{r: io.NewSectionReader(f, entry.Offset, entry.Size), f: f}, entry.Size, nil
}

// sectionCloser keeps the borrowed file alive for the lifetime of the section.
type sectionCloser struct {
	r *io.SectionReader
	f *os.File
}

func (s *sectionCloser) Read(p []byte) (int, error) { return s.r.Read(p) }
func (s *sectionCloser) Close() error               { return s.f.Close() }

func (idx *tarIndex) readSmall(name string, limit int64) ([]byte, error) {
	rc, size, err := idx.open(name)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	if size > limit {
		return nil, fmt.Errorf("%q is %d bytes, larger than the %d byte limit", name, size, limit)
	}
	data, err := io.ReadAll(io.LimitReader(rc, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%q exceeds the %d byte limit", name, limit)
	}
	return data, nil
}

// section hands out a replayable reader over one entry. The caller closes it.
func (idx *tarIndex) section(name string) (*fileSection, int64, error) {
	entry, ok := idx.Entries[name]
	if !ok {
		return nil, 0, fmt.Errorf("%q is missing from the archive", name)
	}
	f, err := os.Open(idx.Path)
	if err != nil {
		return nil, 0, err
	}
	return &fileSection{f: f, r: io.NewSectionReader(f, entry.Offset, entry.Size)}, entry.Size, nil
}

type fileSection struct {
	f *os.File
	r *io.SectionReader
}

func (s *fileSection) Read(p []byte) (int, error) { return s.r.Read(p) }
func (s *fileSection) Seek(offset int64, whence int) (int64, error) {
	return s.r.Seek(offset, whence)
}
func (s *fileSection) Close() error { return s.f.Close() }

func (idx *tarIndex) has(name string) bool {
	_, ok := idx.Entries[name]
	return ok
}

// ---------------------------------------------------------------------------
// Archive inspection
// ---------------------------------------------------------------------------

func inspectArchive(idx *tarIndex) (string, []transferImage, error) {
	if idx.has("manifest.json") {
		raw, err := idx.readSmall("manifest.json", transferSmallMax)
		if err != nil {
			return "", nil, err
		}
		images, err := inspectDockerArchive(idx, raw)
		return "docker", images, err
	}
	if idx.has("index.json") {
		images, err := inspectOCIArchive(idx)
		return "oci", images, err
	}
	return "", nil, errors.New("not an image archive: expected manifest.json (docker save) or index.json (OCI image layout)")
}

func inspectDockerArchive(idx *tarIndex, raw []byte) ([]transferImage, error) {
	var entries []dockerManifestEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("manifest.json is not valid JSON: %w", err)
	}
	if len(entries) == 0 {
		return nil, errors.New("manifest.json lists no images")
	}
	out := make([]transferImage, 0, len(entries))
	for i, entry := range entries {
		if strings.TrimSpace(entry.Config) == "" {
			return nil, fmt.Errorf("manifest.json entry %d has no Config path", i+1)
		}
		cfgRaw, err := idx.readSmall(entry.Config, transferSmallMax)
		if err != nil {
			return nil, fmt.Errorf("manifest.json entry %d: %w", i+1, err)
		}
		var cfg imageConfig
		_ = json.Unmarshal(cfgRaw, &cfg)

		size := int64(len(cfgRaw))
		for _, layer := range entry.Layers {
			info, ok := idx.Entries[layer]
			if !ok {
				return nil, fmt.Errorf("manifest.json entry %d references a missing layer %q", i+1, layer)
			}
			size += info.Size
		}
		refs := make([]string, 0, len(entry.RepoTags))
		for _, ref := range entry.RepoTags {
			if strings.TrimSpace(ref) != "" {
				refs = append(refs, strings.TrimSpace(ref))
			}
		}
		repo, tag := "", ""
		if len(refs) > 0 {
			repo, tag = splitImageRef(refs[0])
		}
		platforms := []transferPlatform{}
		if cfg.OS != "" || cfg.Architecture != "" {
			platforms = append(platforms, transferPlatform{OS: cfg.OS, Architecture: cfg.Architecture, Variant: cfg.Variant})
		}
		out = append(out, transferImage{
			Format:       "docker",
			Refs:         refs,
			Repository:   repo,
			Tag:          tag,
			MediaType:    "application/vnd.docker.distribution.manifest.v2+json",
			ConfigDigest: "sha256:" + sha256Hex(cfgRaw),
			Layers:       len(entry.Layers),
			Size:         size,
			Platforms:    platforms,
			docker:       &dockerImageRef{Config: entry.Config, Layers: append([]string{}, entry.Layers...)},
		})
	}
	return out, nil
}

func inspectOCIArchive(idx *tarIndex) ([]transferImage, error) {
	raw, err := idx.readSmall("index.json", transferSmallMax)
	if err != nil {
		return nil, err
	}
	var doc ociDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("index.json is not valid JSON: %w", err)
	}
	if len(doc.Manifests) == 0 {
		return nil, errors.New("index.json lists no images")
	}
	out := make([]transferImage, 0, len(doc.Manifests))
	for _, desc := range doc.Manifests {
		summary, err := summarizeOCI(idx, desc, 0)
		if err != nil {
			return nil, err
		}
		imageName := desc.Annotations["io.containerd.image.name"]
		refName := desc.Annotations["org.opencontainers.image.ref.name"]
		repo, tag := "", ""
		refs := []string{}
		if imageName != "" {
			refs = append(refs, imageName)
			repo, tag = splitImageRef(imageName)
		}
		if refName != "" && tagPattern.MatchString(refName) {
			if tag == "" {
				tag = refName
			}
			if imageName == "" {
				refs = append(refs, refName)
			}
		}
		d := desc
		out = append(out, transferImage{
			Format:       "oci",
			Refs:         refs,
			Repository:   repo,
			Tag:          tag,
			MediaType:    desc.MediaType,
			Digest:       desc.Digest,
			ConfigDigest: summary.configDigest,
			Layers:       summary.layers,
			Size:         summary.size,
			Platforms:    summary.platforms,
			oci:          &d,
		})
	}
	return out, nil
}

type ociSummary struct {
	size         int64
	layers       int
	configDigest string
	platforms    []transferPlatform
}

func summarizeOCI(idx *tarIndex, desc ociDescriptor, depth int) (*ociSummary, error) {
	if depth > 8 {
		return nil, errors.New("the archive's manifest graph is nested too deeply")
	}
	raw, err := readOCIArchiveBlob(idx, desc.Digest, transferSmallMax)
	if err != nil {
		return nil, err
	}
	var doc ociDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("manifest %s is not valid JSON: %w", desc.Digest, err)
	}
	// The descriptor size is authoritative when present; otherwise the bytes are.
	out := &ociSummary{size: int64(len(raw))}
	if desc.Size > 0 {
		out.size = desc.Size
	}
	if isIndexDoc(&doc) {
		for _, child := range doc.Manifests {
			childSummary, err := summarizeOCI(idx, child, depth+1)
			if err != nil {
				return nil, err
			}
			out.size += childSummary.size
			out.layers += childSummary.layers
			if p := platformFromDescriptor(child.Platform); p.String() != "" {
				out.platforms = append(out.platforms, p)
			} else {
				out.platforms = append(out.platforms, childSummary.platforms...)
			}
			if out.configDigest == "" {
				out.configDigest = childSummary.configDigest
			}
		}
		return out, nil
	}
	if doc.Config != nil {
		out.configDigest = doc.Config.Digest
		out.size += doc.Config.Size
		if p := platformFromDescriptor(desc.Platform); p.String() != "" {
			out.platforms = []transferPlatform{p}
		} else if cfgRaw, err := readOCIArchiveBlob(idx, doc.Config.Digest, transferSmallMax); err == nil {
			var cfg imageConfig
			if json.Unmarshal(cfgRaw, &cfg) == nil && (cfg.OS != "" || cfg.Architecture != "") {
				out.platforms = []transferPlatform{{OS: cfg.OS, Architecture: cfg.Architecture, Variant: cfg.Variant}}
			}
		}
	} else if p := platformFromDescriptor(desc.Platform); p.String() != "" {
		out.platforms = []transferPlatform{p}
	}
	for _, layer := range doc.Layers {
		out.size += layer.Size
	}
	out.layers = len(doc.Layers)
	return out, nil
}

func readOCIArchiveBlob(idx *tarIndex, digest string, limit int64) ([]byte, error) {
	if !digestPattern.MatchString(digest) {
		return nil, fmt.Errorf("unsupported blob digest %q", digest)
	}
	name := "blobs/sha256/" + strings.TrimPrefix(digest, "sha256:")
	raw, err := idx.readSmall(name, limit)
	if err != nil {
		return nil, fmt.Errorf("blob %s: %w", digest, err)
	}
	if got := "sha256:" + sha256Hex(raw); got != digest {
		return nil, fmt.Errorf("blob %s is corrupt: its content hashes to %s", digest, got)
	}
	return raw, nil
}

// splitImageRef separates "registry.example.com/team/app:v1" into
// ("team/app", "v1"). A leading component that looks like a registry host is
// stripped, because the same image is usually uploaded to a different registry.
func splitImageRef(ref string) (repo, tag string) {
	ref = strings.TrimSpace(strings.Trim(ref, "/"))
	if ref == "" || digestPattern.MatchString(ref) {
		return "", ""
	}
	lastSlash := strings.LastIndex(ref, "/")
	lastColon := strings.LastIndex(ref, ":")
	if lastColon > lastSlash {
		tag = ref[lastColon+1:]
		repo = ref[:lastColon]
	} else {
		repo = ref
	}
	if i := strings.Index(repo, "/"); i > 0 {
		first := repo[:i]
		if strings.Contains(first, ".") || strings.Contains(first, ":") || first == "localhost" {
			repo = repo[i+1:]
		}
	}
	return strings.Trim(repo, "/"), tag
}

// ---------------------------------------------------------------------------
// Upload RPCs
// ---------------------------------------------------------------------------

func uploadBegin(_ context.Context, s *Session, params map[string]any) (any, error) {
	name := strings.TrimSpace(strParam(params, "name"))
	if name == "" {
		name = "image"
	}
	// The name is only a label. What the file is gets decided from its bytes
	// (gzip magic → tar structure → manifest.json/index.json), because a user
	// can rename a docker-save archive to anything and an extension is not
	// evidence of anything.
	dir, err := transferDirectory()
	if err != nil {
		return nil, err
	}
	transferJobs.sweepJobs()
	sweepTransferFiles(dir)

	id := newTransferID()
	rawPath := filepath.Join(dir, id+".upload")
	f, err := os.OpenFile(rawPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("cannot create the upload file: %w", err)
	}
	f.Close()

	now := time.Now()
	job := &uploadJob{
		id: id, connID: s.Conn.ID, name: name, rawPath: rawPath,
		state: "uploading", created: now, used: now,
	}
	transferJobs.mu.Lock()
	transferJobs.uploads[id] = job
	transferJobs.mu.Unlock()
	return map[string]any{"id": id, "name": name, "chunkBytes": transferUploadChunkBytes}, nil
}

func lookupUpload(s *Session, id string) (*uploadJob, error) {
	transferJobs.mu.Lock()
	job := transferJobs.uploads[id]
	transferJobs.mu.Unlock()
	if job == nil {
		return nil, errors.New("the upload session is no longer available")
	}
	job.mu.Lock()
	connID := job.connID
	job.mu.Unlock()
	if connID != s.Conn.ID {
		return nil, errors.New("the upload belongs to another connection")
	}
	return job, nil
}

func uploadChunk(_ context.Context, s *Session, params map[string]any) (any, error) {
	id := strings.TrimSpace(strParam(params, "id"))
	job, err := lookupUpload(s, id)
	if err != nil {
		return nil, err
	}
	data, err := base64.StdEncoding.DecodeString(strParam(params, "data"))
	if err != nil {
		return nil, errors.New("the chunk is not valid base64")
	}
	if len(data) == 0 {
		return nil, errors.New("the chunk is empty")
	}
	if len(data) > transferMaxChunk {
		return nil, fmt.Errorf("the chunk is %d bytes; the limit is %d", len(data), transferMaxChunk)
	}
	offset := int64Param(params, "offset")

	job.mu.Lock()
	defer job.mu.Unlock()
	if job.state != "uploading" {
		return nil, fmt.Errorf("the upload is %s and no longer accepts chunks", job.state)
	}
	if offset != job.received {
		return nil, fmt.Errorf("unexpected chunk offset %d (expected %d)", offset, job.received)
	}
	f, err := os.OpenFile(job.rawPath, os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	if _, err := f.WriteAt(data, offset); err != nil {
		f.Close()
		return nil, fmt.Errorf("writing the upload failed: %w", err)
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	job.received += int64(len(data))
	job.used = time.Now()
	return map[string]any{"received": job.received, "chunkBytes": transferUploadChunkBytes}, nil
}

func uploadEnd(_ context.Context, s *Session, params map[string]any) (any, error) {
	id := strings.TrimSpace(strParam(params, "id"))
	job, err := lookupUpload(s, id)
	if err != nil {
		return nil, err
	}
	job.mu.Lock()
	if job.state != "uploading" {
		state := job.state
		job.mu.Unlock()
		return nil, fmt.Errorf("the upload is already %s", state)
	}
	if job.received == 0 {
		job.mu.Unlock()
		return nil, errors.New("the selected file is empty")
	}
	job.state = "parsing"
	job.rawSize = job.received
	job.used = time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), transferJobLimit)
	job.cancel = cancel
	job.done = make(chan struct{})
	rawPath := job.rawPath
	job.mu.Unlock()

	go parseUpload(ctx, job, rawPath)
	return map[string]any{"id": job.id, "state": "parsing"}, nil
}

func parseUpload(ctx context.Context, job *uploadJob, rawPath string) {
	defer close(job.done)

	compressed, err := isGzipFile(rawPath)
	if err != nil {
		setUploadError(job, err)
		return
	}
	tarPath := strings.TrimSuffix(rawPath, ".upload") + ".tar"
	if compressed {
		if err := gunzipFileContext(ctx, rawPath, tarPath); err != nil {
			if ctx.Err() != nil {
				setUploadError(job, errors.New("the upload was cancelled"))
			} else {
				setUploadError(job, fmt.Errorf("the file starts with the gzip magic but could not be decompressed: %w", err))
			}
			return
		}
		removeIfExists(rawPath)
	} else if err := os.Rename(rawPath, tarPath); err != nil {
		// Renaming is not required; index the raw file if the filesystem refuses.
		// Keep rawPath in that case — it is now the archive being indexed.
		tarPath = rawPath
	}

	if ctx.Err() != nil {
		setUploadError(job, errors.New("the upload was cancelled"))
		return
	}
	info, err := os.Stat(tarPath)
	if err != nil {
		setUploadError(job, err)
		return
	}
	idx, err := indexTarFile(tarPath)
	if err != nil {
		if compressed {
			setUploadError(job, fmt.Errorf("the file decompresses but is not a valid tar archive: %w", err))
		} else {
			setUploadError(job, fmt.Errorf("the file is neither gzip-compressed nor a valid tar archive: %w", err))
		}
		return
	}
	format, images, err := inspectArchive(idx)
	if err != nil {
		setUploadError(job, err)
		return
	}

	job.mu.Lock()
	job.tarPath = tarPath
	job.compressed = compressed
	job.tarSize = info.Size()
	job.format = format
	job.images = images
	job.idx = idx
	job.state = "ready"
	job.errMsg = ""
	job.used = time.Now()
	job.mu.Unlock()
}

func setUploadError(job *uploadJob, err error) {
	job.mu.Lock()
	job.state = "error"
	job.errMsg = err.Error()
	job.used = time.Now()
	job.mu.Unlock()
}

func isGzipFile(name string) (bool, error) {
	f, err := os.Open(name)
	if err != nil {
		return false, err
	}
	defer f.Close()
	var magic [2]byte
	n, err := io.ReadFull(f, magic[:])
	if err == io.ErrUnexpectedEOF || err == io.EOF {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return n == 2 && magic[0] == 0x1f && magic[1] == 0x8b, nil
}

func gunzipFileContext(ctx context.Context, src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	gz, err := gzip.NewReader(in)
	if err != nil {
		return err
	}
	defer gz.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	buf := make([]byte, 1<<20)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := gz.Read(buf)
		if n > 0 {
			if _, err := out.Write(buf[:n]); err != nil {
				return err
			}
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

func uploadStatus(_ context.Context, s *Session, params map[string]any) (any, error) {
	id := strings.TrimSpace(strParam(params, "id"))
	job, err := lookupUpload(s, id)
	if err != nil {
		return nil, err
	}
	job.mu.Lock()
	defer job.mu.Unlock()
	job.used = time.Now()
	return map[string]any{
		"id":    job.id,
		"name":  job.name,
		"state": job.state,
		"error": job.errMsg,
		"push":  job.push,
		"archive": map[string]any{
			"format":     job.format,
			"compressed": job.compressed,
			"size":       job.rawSize,
			"images":     job.images,
		},
	}, nil
}

func uploadPush(_ context.Context, s *Session, params map[string]any) (any, error) {
	id := strings.TrimSpace(strParam(params, "id"))
	job, err := lookupUpload(s, id)
	if err != nil {
		return nil, err
	}
	repo := strings.Trim(strings.TrimSpace(strParam(params, "repository")), "/")
	tag := strings.TrimSpace(strParam(params, "tag"))
	if !validRepository(repo) {
		return nil, fmt.Errorf("invalid repository %q: use lowercase letters, digits and . _ - /", repo)
	}
	if s.RegistryType == registryTypeHarbor && !strings.Contains(repo, "/") {
		return nil, errors.New("Harbor repositories live inside a project: choose a project and a repository name")
	}
	if tag == "" {
		return nil, errors.New("tag is required")
	}
	if !tagPattern.MatchString(tag) {
		return nil, fmt.Errorf("invalid tag %q: a tag must match [A-Za-z0-9_][A-Za-z0-9._-]{0,127}", tag)
	}
	imageIndex := intParam(params, "imageIndex")
	if imageIndex < 0 {
		imageIndex = 0
	}
	platform := strings.TrimSpace(strParam(params, "platform"))
	if platform != "" {
		p := parsePlatform(platform)
		if p.OS == "" || p.Architecture == "" {
			return nil, fmt.Errorf("invalid platform %q (use os/arch[/variant])", platform)
		}
	}

	job.mu.Lock()
	if job.state != "ready" {
		state := job.state
		job.mu.Unlock()
		return nil, fmt.Errorf("the archive is %s, not ready to upload", state)
	}
	if imageIndex >= len(job.images) {
		job.mu.Unlock()
		return nil, fmt.Errorf("image %d is not in this archive", imageIndex)
	}
	if job.push.State == "running" {
		job.mu.Unlock()
		return nil, errors.New("an upload is already running")
	}
	image := job.images[imageIndex]
	job.push = pushProgress{State: "running", Phase: "preparing", Repository: repo, Tag: tag}
	ctx, cancel := context.WithTimeout(context.Background(), transferJobLimit)
	job.cancel = cancel
	job.done = make(chan struct{})
	job.used = time.Now()
	job.mu.Unlock()

	go func() {
		defer close(job.done)
		err := pushArchiveImage(ctx, s, job, image, repo, tag, platform)
		job.mu.Lock()
		defer job.mu.Unlock()
		if err != nil {
			if ctx.Err() != nil {
				job.push.State = "error"
				job.push.Error = "the upload was cancelled"
			} else {
				job.push.State = "error"
				job.push.Error = err.Error()
			}
			return
		}
		job.push.State = "done"
		job.push.Phase = "done"
		job.push.Done = job.push.Total
		job.used = time.Now()
	}()
	return map[string]any{"started": true}, nil
}

func uploadClose(_ context.Context, s *Session, params map[string]any) (any, error) {
	id := strings.TrimSpace(strParam(params, "id"))
	job, err := lookupUpload(s, id)
	if err != nil {
		return map[string]any{"ok": true}, nil
	}
	transferJobs.mu.Lock()
	if transferJobs.uploads[id] == job {
		delete(transferJobs.uploads, id)
	}
	transferJobs.mu.Unlock()
	job.mu.Lock()
	cancel, done := job.cancel, job.done
	rawPath, tarPath := job.rawPath, job.tarPath
	job.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
	removeIfExists(rawPath)
	removeIfExists(tarPath)
	return map[string]any{"ok": true}, nil
}

// ---------------------------------------------------------------------------
// Push one archive image
// ---------------------------------------------------------------------------

func setPushPhase(job *uploadJob, phase string) {
	job.mu.Lock()
	job.push.Phase = phase
	job.used = time.Now()
	job.mu.Unlock()
}

func setPushTotal(job *uploadJob, total int64, blobs int) {
	job.mu.Lock()
	job.push.Total = total
	job.push.BlobsTotal = blobs
	job.mu.Unlock()
}

func addPushDone(job *uploadJob, done int64) {
	job.mu.Lock()
	if done > job.push.Done {
		job.push.Done = done
	}
	job.used = time.Now()
	job.mu.Unlock()
}

func bumpPushBlob(job *uploadJob) {
	job.mu.Lock()
	job.push.BlobsDone++
	job.used = time.Now()
	job.mu.Unlock()
}

func pushArchiveImage(ctx context.Context, s *Session, job *uploadJob, image transferImage, repo, tag, platform string) error {
	job.mu.Lock()
	idx := job.idx
	job.mu.Unlock()
	if idx == nil {
		return errors.New("the archive is no longer indexed")
	}
	if image.docker != nil {
		return pushDockerImage(ctx, s, job, idx, *image.docker, repo, tag)
	}
	if image.oci != nil {
		return pushOCIImage(ctx, s, job, idx, *image.oci, repo, tag, platform)
	}
	return errors.New("unsupported archive entry")
}

func pushDockerImage(ctx context.Context, s *Session, job *uploadJob, idx *tarIndex, image dockerImageRef, repo, tag string) error {
	setPushPhase(job, "hashing")
	configRaw, err := idx.readSmall(image.Config, transferSmallMax)
	if err != nil {
		return err
	}
	configDigest := "sha256:" + sha256Hex(configRaw)

	type layerInfo struct {
		name      string
		digest    string
		size      int64
		mediaType string
	}
	layers := make([]layerInfo, 0, len(image.Layers))
	var total int64 = int64(len(configRaw))
	for _, name := range image.Layers {
		digest, size, kind, err := hashTarEntry(ctx, idx, name)
		if err != nil {
			return err
		}
		if kind == "zstd" {
			return fmt.Errorf("layer %s uses zstd compression, which a docker-save archive cannot describe; re-save the image with gzip compression", name)
		}
		mediaType := "application/vnd.docker.image.rootfs.diff.tar"
		if kind == "gzip" {
			mediaType = "application/vnd.docker.image.rootfs.diff.tar.gzip"
		}
		layers = append(layers, layerInfo{name: name, digest: digest, size: size, mediaType: mediaType})
		total += size
	}
	setPushTotal(job, total, len(layers)+1)

	setPushPhase(job, "config")
	var done int64
	err = s.Oci.PushBlob(ctx, repo, configDigest, int64(len(configRaw)), func() (io.ReadSeeker, error) {
		return bytes.NewReader(configRaw), nil
	}, func(_ int64, _ int64) {})
	if err != nil {
		return fmt.Errorf("uploading the image config: %w", err)
	}
	done += int64(len(configRaw))
	addPushDone(job, done)
	bumpPushBlob(job)

	for i, layer := range layers {
		setPushPhase(job, fmt.Sprintf("layer %d/%d", i+1, len(layers)))
		base := done
		err := s.Oci.PushBlob(ctx, repo, layer.digest, layer.size, func() (io.ReadSeeker, error) {
			sec, _, err := idx.section(layer.name)
			return sec, err
		}, func(transferred, _ int64) {
			addPushDone(job, base+transferred)
		})
		if err != nil {
			return fmt.Errorf("uploading layer %d/%d (%s): %w", i+1, len(layers), layer.digest, err)
		}
		done += layer.size
		addPushDone(job, done)
		bumpPushBlob(job)
	}

	type descriptor struct {
		MediaType string `json:"mediaType"`
		Size      int64  `json:"size"`
		Digest    string `json:"digest"`
	}
	manifest := struct {
		SchemaVersion int          `json:"schemaVersion"`
		MediaType     string       `json:"mediaType"`
		Config        descriptor   `json:"config"`
		Layers        []descriptor `json:"layers"`
	}{
		SchemaVersion: 2,
		MediaType:     "application/vnd.docker.distribution.manifest.v2+json",
		Config: descriptor{
			MediaType: "application/vnd.docker.container.image.v1+json",
			Size:      int64(len(configRaw)),
			Digest:    configDigest,
		},
		Layers: make([]descriptor, 0, len(layers)),
	}
	for _, layer := range layers {
		manifest.Layers = append(manifest.Layers, descriptor{
			MediaType: layer.mediaType, Size: layer.size, Digest: layer.digest,
		})
	}
	body, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	setPushPhase(job, "manifest")
	if err := s.Oci.PushManifest(ctx, repo, tag, manifest.MediaType, body); err != nil {
		return err
	}
	addPushDone(job, job.pushTotal())
	return nil
}

func (j *uploadJob) pushTotal() int64 {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.push.Total
}

func hashTarEntry(ctx context.Context, idx *tarIndex, name string) (digest string, size int64, compression string, err error) {
	sec, size, err := idx.section(name)
	if err != nil {
		return "", 0, "", err
	}
	defer sec.Close()
	h := sha256.New()
	buf := make([]byte, 256<<10)
	var read int64
	first := true
	compression = ""
	for {
		if err := ctx.Err(); err != nil {
			return "", 0, "", err
		}
		n, readErr := sec.Read(buf)
		if n > 0 {
			if first {
				compression = sniffCompression(buf[:n])
				first = false
			}
			h.Write(buf[:n])
			read += int64(n)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return "", 0, "", readErr
		}
	}
	if read != size {
		return "", 0, "", fmt.Errorf("%q changed while it was being read", name)
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), size, compression, nil
}

// sniffCompression identifies the layer wrappers an upload may carry. Only
// gzip and plain tar can be described by a docker-save archive; zstd is
// detected so the push can refuse it with a useful message instead of writing
// bytes under a media type that says "uncompressed".
func sniffCompression(head []byte) string {
	switch {
	case len(head) >= 2 && head[0] == 0x1f && head[1] == 0x8b:
		return "gzip"
	case len(head) >= 4 && head[0] == 0x28 && head[1] == 0xb5 && head[2] == 0x2f && head[3] == 0xfd:
		return "zstd"
	default:
		return ""
	}
}

// archiveImagePlatform reads the config blob named by a single-image manifest.
// It is used to refuse a platform request that the archive cannot satisfy.
func archiveImagePlatform(idx *tarIndex, doc ociDocument) transferPlatform {
	if doc.Config == nil {
		return transferPlatform{}
	}
	raw, err := readOCIArchiveBlob(idx, doc.Config.Digest, transferSmallMax)
	if err != nil {
		return transferPlatform{}
	}
	var cfg imageConfig
	if json.Unmarshal(raw, &cfg) != nil {
		return transferPlatform{}
	}
	return transferPlatform{OS: cfg.OS, Architecture: cfg.Architecture, Variant: cfg.Variant}
}

func pushOCIImage(ctx context.Context, s *Session, job *uploadJob, idx *tarIndex, desc ociDescriptor, repo, tag, platform string) error {
	setPushPhase(job, "reading manifests")
	if platform != "" {
		raw, err := readOCIArchiveBlob(idx, desc.Digest, transferSmallMax)
		if err != nil {
			return err
		}
		var doc ociDocument
		if err := json.Unmarshal(raw, &doc); err != nil {
			return fmt.Errorf("manifest %s is not valid JSON: %w", desc.Digest, err)
		}
		if isIndexDoc(&doc) {
			child, err := choosePlatform(doc.Manifests, platform)
			if err != nil {
				return err
			}
			desc = child
		} else {
			current := archiveImagePlatform(idx, doc)
			want := parsePlatform(platform)
			if current.String() != "" &&
				(current.OS != want.OS || current.Architecture != want.Architecture ||
					(want.Variant != "" && current.Variant != want.Variant)) {
				return fmt.Errorf("the archive contains %s, not %s", current.String(), want.String())
			}
		}
	}
	graph, err := collectOCIArchiveGraph(idx, desc)
	if err != nil {
		return err
	}
	var total int64
	for _, blob := range graph.blobs {
		total += blob.Size
	}
	for _, manifest := range graph.manifests {
		total += int64(len(manifest.Body))
	}
	setPushTotal(job, total, len(graph.blobs)+len(graph.manifests))

	var done int64
	for i, blob := range graph.blobs {
		setPushPhase(job, fmt.Sprintf("blob %d/%d", i+1, len(graph.blobs)))
		name := "blobs/sha256/" + strings.TrimPrefix(blob.Digest, "sha256:")
		sec, size, err := idx.section(name)
		if err != nil {
			return err
		}
		// Verify the bytes before they leave the machine: a corrupted archive
		// should fail with a readable message, not as a registry-side digest error.
		got, _, _, err := hashTarEntry(ctx, idx, name)
		sec.Close()
		if err != nil {
			return err
		}
		if got != blob.Digest {
			return fmt.Errorf("blob %s is corrupt: its content hashes to %s", blob.Digest, got)
		}
		if blob.Size != 0 && size != blob.Size {
			return fmt.Errorf("blob %s is %d bytes, the manifest says %d", blob.Digest, size, blob.Size)
		}
		base := done
		err = s.Oci.PushBlob(ctx, repo, blob.Digest, size, func() (io.ReadSeeker, error) {
			sec, _, err := idx.section(name)
			return sec, err
		}, func(transferred, _ int64) {
			addPushDone(job, base+transferred)
		})
		if err != nil {
			return fmt.Errorf("uploading blob %s: %w", blob.Digest, err)
		}
		done += size
		addPushDone(job, done)
		bumpPushBlob(job)
	}
	for i, manifest := range graph.manifests {
		setPushPhase(job, fmt.Sprintf("manifest %d/%d", i+1, len(graph.manifests)))
		reference := manifest.Digest
		if i == len(graph.manifests)-1 {
			reference = tag
		}
		if err := s.Oci.PushManifest(ctx, repo, reference, manifest.MediaType, manifest.Body); err != nil {
			return err
		}
		done += int64(len(manifest.Body))
		addPushDone(job, done)
		bumpPushBlob(job)
	}
	return nil
}

// ---------------------------------------------------------------------------
// OCI manifest graph (shared by upload and export)
// ---------------------------------------------------------------------------

type ociBlobRef struct {
	Digest    string
	Size      int64
	MediaType string
}

type ociManifestRef struct {
	Digest    string
	MediaType string
	Body      []byte
}

type ociGraph struct {
	blobs     []ociBlobRef
	manifests []ociManifestRef
}

func collectOCIArchiveGraph(idx *tarIndex, top ociDescriptor) (*ociGraph, error) {
	g := &ociGraph{}
	seenBlob := map[string]bool{}
	seenManifest := map[string]bool{}
	var walk func(desc ociDescriptor, depth int) error
	walk = func(desc ociDescriptor, depth int) error {
		if depth > 8 {
			return errors.New("the archive's manifest graph is nested too deeply")
		}
		raw, err := readOCIArchiveBlob(idx, desc.Digest, transferSmallMax)
		if err != nil {
			return err
		}
		digest := "sha256:" + sha256Hex(raw)
		if desc.Digest != "" && desc.Digest != digest {
			return fmt.Errorf("manifest %s is corrupt: its content hashes to %s", desc.Digest, digest)
		}
		if seenManifest[digest] {
			return nil
		}
		seenManifest[digest] = true

		var doc ociDocument
		if err := json.Unmarshal(raw, &doc); err != nil {
			return fmt.Errorf("manifest %s is not valid JSON: %w", digest, err)
		}
		mediaType := doc.MediaType
		if mediaType == "" {
			mediaType = desc.MediaType
		}
		if mediaType == "" {
			if isIndexDoc(&doc) {
				mediaType = "application/vnd.oci.image.index.v1+json"
			} else {
				mediaType = "application/vnd.oci.image.manifest.v1+json"
			}
		}
		if isIndexDoc(&doc) {
			for _, child := range doc.Manifests {
				if err := walk(child, depth+1); err != nil {
					return err
				}
			}
		} else {
			if doc.Config != nil {
				if !seenBlob[doc.Config.Digest] {
					seenBlob[doc.Config.Digest] = true
					g.blobs = append(g.blobs, ociBlobRef{Digest: doc.Config.Digest, Size: doc.Config.Size, MediaType: doc.Config.MediaType})
				}
			}
			for _, layer := range doc.Layers {
				if !seenBlob[layer.Digest] {
					seenBlob[layer.Digest] = true
					g.blobs = append(g.blobs, ociBlobRef{Digest: layer.Digest, Size: layer.Size, MediaType: layer.MediaType})
				}
			}
		}
		g.manifests = append(g.manifests, ociManifestRef{Digest: digest, MediaType: mediaType, Body: raw})
		return nil
	}
	if err := walk(top, 0); err != nil {
		return nil, err
	}
	return g, nil
}

func collectOCIRegistryGraph(ctx context.Context, s *Session, repo string, top ociDescriptor) (*ociGraph, error) {
	g := &ociGraph{}
	seenBlob := map[string]bool{}
	seenManifest := map[string]bool{}
	var walk func(desc ociDescriptor, depth int) error
	walk = func(desc ociDescriptor, depth int) error {
		if depth > 8 {
			return errors.New("the image's manifest graph is nested too deeply")
		}
		mr, err := s.Oci.Manifest(ctx, repo, desc.Digest)
		if err != nil {
			return err
		}
		raw := []byte(mr.Body)
		digest := "sha256:" + sha256Hex(raw)
		if desc.Digest != "" && desc.Digest != digest {
			return fmt.Errorf("manifest %s is corrupt: its content hashes to %s", desc.Digest, digest)
		}
		if seenManifest[digest] {
			return nil
		}
		seenManifest[digest] = true
		var doc ociDocument
		if err := json.Unmarshal(raw, &doc); err != nil {
			return fmt.Errorf("manifest %s is not valid JSON: %w", digest, err)
		}
		mediaType := doc.MediaType
		if mediaType == "" {
			mediaType = mr.MediaType
		}
		if i := strings.IndexByte(mediaType, ';'); i >= 0 {
			mediaType = strings.TrimSpace(mediaType[:i])
		}
		if mediaType == "" {
			if isIndexDoc(&doc) {
				mediaType = "application/vnd.oci.image.index.v1+json"
			} else {
				mediaType = "application/vnd.oci.image.manifest.v1+json"
			}
		}
		if isIndexDoc(&doc) {
			for _, child := range doc.Manifests {
				if err := walk(child, depth+1); err != nil {
					return err
				}
			}
		} else {
			if doc.Config != nil && !seenBlob[doc.Config.Digest] {
				seenBlob[doc.Config.Digest] = true
				g.blobs = append(g.blobs, ociBlobRef{Digest: doc.Config.Digest, Size: doc.Config.Size, MediaType: doc.Config.MediaType})
			}
			for _, layer := range doc.Layers {
				if !seenBlob[layer.Digest] {
					seenBlob[layer.Digest] = true
					g.blobs = append(g.blobs, ociBlobRef{Digest: layer.Digest, Size: layer.Size, MediaType: layer.MediaType})
				}
			}
		}
		g.manifests = append(g.manifests, ociManifestRef{Digest: digest, MediaType: mediaType, Body: raw})
		return nil
	}
	if err := walk(top, 0); err != nil {
		return nil, err
	}
	return g, nil
}

// ---------------------------------------------------------------------------
// Export RPCs
// ---------------------------------------------------------------------------

type exportPlatform struct {
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
	Variant      string `json:"variant,omitempty"`
	Digest       string `json:"digest,omitempty"`
	Size         int64  `json:"size"`
}

type exportPlan struct {
	Repository string           `json:"repository"`
	Reference  string           `json:"reference"`
	Tag        string           `json:"tag"`
	Digest     string           `json:"digest"`
	MediaType  string           `json:"mediaType"`
	IsIndex    bool             `json:"isIndex"`
	IsImage    bool             `json:"isImage"`
	Size       int64            `json:"size"`
	Platforms  []exportPlatform `json:"platforms"`
}

func transferExportPlan(ctx context.Context, s *Session, params map[string]any) (any, error) {
	repo := strings.Trim(strings.TrimSpace(strParam(params, "repository")), "/")
	ref := strings.TrimSpace(strParam(params, "reference"))
	if !validRepository(repo) {
		return nil, fmt.Errorf("invalid repository %q", repo)
	}
	if !validReference(ref) {
		return nil, fmt.Errorf("invalid reference %q: use a tag or a sha256 digest", ref)
	}
	plan, err := buildExportPlan(ctx, s, repo, ref)
	if err != nil {
		return nil, err
	}
	return plan, nil
}

func buildExportPlan(ctx context.Context, s *Session, repo, ref string) (*exportPlan, error) {
	mr, err := s.Oci.Manifest(ctx, repo, ref)
	if err != nil {
		return nil, err
	}
	var doc ociDocument
	if err := json.Unmarshal([]byte(mr.Body), &doc); err != nil {
		return nil, fmt.Errorf("the manifest is not valid JSON: %w", err)
	}
	digest := mr.Digest
	if digest == "" {
		digest = "sha256:" + sha256Hex([]byte(mr.Body))
	}
	mediaType := cleanMediaType(mr.MediaType)
	if mediaType == "" {
		mediaType = cleanMediaType(doc.MediaType)
	}
	plan := &exportPlan{
		Repository: repo, Reference: ref, Digest: digest, MediaType: mediaType,
		Platforms: []exportPlatform{},
	}
	if tagPattern.MatchString(ref) {
		plan.Tag = ref
	} else if strings.Contains(ref, ":") && !digestPattern.MatchString(ref) {
		plan.Tag = ""
	}
	if digestPattern.MatchString(ref) {
		plan.Tag = ""
	}
	if isIndexDoc(&doc) {
		plan.IsIndex = true
		seen := map[string]bool{}
		for _, child := range doc.Manifests {
			p := exportPlatform{Digest: child.Digest, Size: child.Size}
			if child.Platform != nil {
				p.OS, p.Architecture, p.Variant = child.Platform.OS, child.Platform.Architecture, child.Platform.Variant
			}
			summary, err := summarizeRegistryManifest(ctx, s, repo, child, 0)
			if err == nil {
				if summary.image {
					plan.IsImage = true
				}
				p.Size = summary.size
				if p.OS == "" && p.Architecture == "" && len(summary.platforms) > 0 {
					p.OS, p.Architecture, p.Variant = summary.platforms[0].OS, summary.platforms[0].Architecture, summary.platforms[0].Variant
				}
				for _, blob := range summary.blobs {
					if !seen[blob] {
						seen[blob] = true
						plan.Size += blobSize(summary.sizes, blob)
					}
				}
			}
			plan.Platforms = append(plan.Platforms, p)
		}
		plan.Size += int64(len(mr.Body))
	} else {
		if doc.Config != nil {
			plan.IsImage = isImageConfigMediaType(doc.Config.MediaType)
			plan.Size += int64(len(mr.Body)) + doc.Config.Size
			if cfgRaw, err := s.Oci.Blob(ctx, repo, doc.Config.Digest); err == nil {
				var cfg imageConfig
				if json.Unmarshal(cfgRaw, &cfg) == nil && (cfg.OS != "" || cfg.Architecture != "") {
					plan.Platforms = append(plan.Platforms, exportPlatform{
						OS: cfg.OS, Architecture: cfg.Architecture, Variant: cfg.Variant,
						Digest: digest, Size: plan.Size,
					})
				}
			}
		}
		for _, layer := range doc.Layers {
			plan.Size += layer.Size
		}
		if len(plan.Platforms) == 0 {
			plan.Platforms = append(plan.Platforms, exportPlatform{Digest: digest, Size: plan.Size})
		}
	}
	return plan, nil
}

// summarizeRegistryManifest is a lighter variant of summarizeOCI used by the
// export plan: it reads the manifest (and its config) over HTTP and reports the
// total bytes, platforms and the blob digests it needs.
type registrySummary struct {
	size      int64
	image     bool
	blobs     []string
	sizes     map[string]int64
	platforms []transferPlatform
}

func summarizeRegistryManifest(ctx context.Context, s *Session, repo string, desc ociDescriptor, depth int) (*registrySummary, error) {
	if depth > 8 {
		return nil, errors.New("the image's manifest graph is nested too deeply")
	}
	mr, err := s.Oci.Manifest(ctx, repo, desc.Digest)
	if err != nil {
		return nil, err
	}
	var doc ociDocument
	if err := json.Unmarshal([]byte(mr.Body), &doc); err != nil {
		return nil, err
	}
	out := &registrySummary{size: int64(len(mr.Body)), sizes: map[string]int64{}}
	if isIndexDoc(&doc) {
		for _, child := range doc.Manifests {
			childSummary, err := summarizeRegistryManifest(ctx, s, repo, child, depth+1)
			if err != nil {
				return nil, err
			}
			out.size += childSummary.size
			out.image = out.image || childSummary.image
			for d, sz := range childSummary.sizes {
				out.sizes[d] = sz
				out.blobs = append(out.blobs, d)
			}
			out.platforms = append(out.platforms, childSummary.platforms...)
		}
		return out, nil
	}
	if doc.Config != nil {
		out.image = isImageConfigMediaType(doc.Config.MediaType)
		out.sizes[doc.Config.Digest] = doc.Config.Size
		out.blobs = append(out.blobs, doc.Config.Digest)
	}
	for _, layer := range doc.Layers {
		if _, ok := out.sizes[layer.Digest]; !ok {
			out.sizes[layer.Digest] = layer.Size
			out.blobs = append(out.blobs, layer.Digest)
		}
	}
	if p := platformFromDescriptor(desc.Platform); p.String() != "" {
		out.platforms = append(out.platforms, p)
	} else if doc.Config != nil {
		if cfgRaw, err := s.Oci.Blob(ctx, repo, doc.Config.Digest); err == nil {
			var cfg imageConfig
			if json.Unmarshal(cfgRaw, &cfg) == nil && (cfg.OS != "" || cfg.Architecture != "") {
				out.platforms = append(out.platforms, transferPlatform{OS: cfg.OS, Architecture: cfg.Architecture, Variant: cfg.Variant})
			}
		}
	}
	return out, nil
}

func blobSize(sizes map[string]int64, digest string) int64 { return sizes[digest] }

func cleanMediaType(value string) string {
	value = strings.TrimSpace(value)
	if i := strings.IndexByte(value, ';'); i >= 0 {
		value = strings.TrimSpace(value[:i])
	}
	return value
}

func transferExportBegin(_ context.Context, s *Session, params map[string]any) (any, error) {
	repo := strings.Trim(strings.TrimSpace(strParam(params, "repository")), "/")
	ref := strings.TrimSpace(strParam(params, "reference"))
	format := strings.ToLower(strings.TrimSpace(strParam(params, "format")))
	if format == "" {
		format = "docker"
	}
	if format != "docker" && format != "oci" {
		return nil, fmt.Errorf("unknown archive format %q (use docker or oci)", format)
	}
	if !validRepository(repo) {
		return nil, fmt.Errorf("invalid repository %q", repo)
	}
	if !validReference(ref) {
		return nil, fmt.Errorf("invalid reference %q: use a tag or a sha256 digest", ref)
	}
	tag, err := normalizeArchiveTag(strParam(params, "tag"))
	if err != nil {
		return nil, err
	}
	gz := boolParam(params, "gzip")
	platform := strings.TrimSpace(strParam(params, "platform"))

	dir, err := transferDirectory()
	if err != nil {
		return nil, err
	}
	transferJobs.sweepJobs()
	sweepTransferFiles(dir)

	id := newTransferID()
	name := archiveFileName(repo, tag, platform, format, gz)
	j := &exportJob{
		id: id, connID: s.Conn.ID, name: name,
		path: filepath.Join(dir, id+".export.tar"), format: format,
		gzip: gz, platform: platform, tag: tag,
		state: "preparing", created: time.Now(), used: time.Now(),
	}
	ctx, cancel := context.WithTimeout(context.Background(), transferJobLimit)
	j.cancel = cancel
	j.doneCh = make(chan struct{})
	transferJobs.mu.Lock()
	transferJobs.exports[id] = j
	transferJobs.mu.Unlock()
	go runExport(ctx, s, j, repo, ref)
	return map[string]any{"id": id, "name": name, "state": "preparing", "size": 0}, nil
}

func normalizeArchiveTag(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "latest", nil
	}
	if digestPattern.MatchString(raw) {
		return "sha256-" + strings.TrimPrefix(raw, "sha256:")[:12], nil
	}
	if !tagPattern.MatchString(raw) {
		return "", fmt.Errorf("invalid tag %q: a tag must match [A-Za-z0-9_][A-Za-z0-9._-]{0,127}", raw)
	}
	return raw, nil
}

func archiveFileName(repo, tag, platform, format string, gz bool) string {
	leaf := path.Base(repo)
	if leaf == "" || leaf == "." || leaf == "/" {
		leaf = "image"
	}
	name := safeFilePart(leaf) + "-" + safeFilePart(tag)
	if platform != "" {
		name += "-" + safeFilePart(strings.ReplaceAll(platform, "/", "-"))
	}
	if format == "oci" && platform == "" {
		name += "-oci"
	}
	// Keep the save-dialog name inside filesystem limits; the extension is
	// appended after the cut so the file still identifies itself.
	if len(name) > 180 {
		name = name[:180]
	}
	name += ".tar"
	if gz {
		name += ".gz"
	}
	return name
}

func safeFilePart(value string) string {
	value = strings.TrimSpace(value)
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-.")
	if out == "" {
		return "image"
	}
	return out
}

func runExport(ctx context.Context, s *Session, job *exportJob, repo, ref string) {
	defer close(job.doneCh)
	err := writeExportArchive(ctx, s, job, repo, ref)
	job.mu.Lock()
	defer job.mu.Unlock()
	if err != nil {
		job.state = "error"
		if ctx.Err() != nil {
			job.errMsg = "the export was cancelled"
		} else {
			job.errMsg = err.Error()
		}
		removeIfExists(job.path)
		return
	}
	info, statErr := os.Stat(job.path)
	if statErr != nil {
		job.state = "error"
		job.errMsg = statErr.Error()
		return
	}
	job.size = info.Size()
	job.state = "ready"
	job.used = time.Now()
}

func writeExportArchive(ctx context.Context, s *Session, job *exportJob, repo, ref string) error {
	out, err := os.OpenFile(job.path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	// From here on the file is owned by this function; closing happens in one place.
	closed := false
	defer func() {
		if !closed {
			out.Close()
		}
	}()
	var w io.Writer = out
	var gz *gzip.Writer
	if job.gzip {
		gz, err = gzip.NewWriterLevel(out, gzip.BestSpeed)
		if err != nil {
			return err
		}
		w = gz
	}
	tw := tar.NewWriter(w)

	job.mu.Lock()
	job.state = "running"
	job.mu.Unlock()

	if job.format == "docker" {
		err = writeDockerExport(ctx, s, job, repo, ref, tw)
	} else {
		err = writeOCIExportFile(ctx, s, job, repo, ref, tw)
	}
	if err != nil {
		tw.Close()
		if gz != nil {
			gz.Close()
		}
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if gz != nil {
		if err := gz.Close(); err != nil {
			return err
		}
	}
	if err := out.Close(); err != nil {
		return err
	}
	closed = true
	return nil
}

func writeTarFileHeader(tw *tar.Writer, name string, size int64) error {
	return tw.WriteHeader(&tar.Header{
		Name: name, Mode: 0o644, Size: size, ModTime: time.Now(),
		Typeflag: tar.TypeReg, Format: tar.FormatPAX,
	})
}

func setExportProgress(job *exportJob, done, total int64) {
	job.mu.Lock()
	if done > job.done || job.done == 0 {
		job.done = done
	}
	if total > 0 {
		job.total = total
	}
	job.used = time.Now()
	job.mu.Unlock()
}

func addExportDone(job *exportJob, n int64) {
	job.mu.Lock()
	job.done = job.done + n
	job.used = time.Now()
	job.mu.Unlock()
}

func writeDockerExport(ctx context.Context, s *Session, job *exportJob, repo, ref string, tw *tar.Writer) error {
	mr, err := s.Oci.Manifest(ctx, repo, ref)
	if err != nil {
		return err
	}
	var doc ociDocument
	if err := json.Unmarshal([]byte(mr.Body), &doc); err != nil {
		return fmt.Errorf("the manifest is not valid JSON: %w", err)
	}
	selected := ociDescriptor{Digest: mr.Digest, MediaType: cleanMediaType(mr.MediaType), Size: int64(len(mr.Body))}
	if isIndexDoc(&doc) {
		child, err := choosePlatform(doc.Manifests, job.platform)
		if err != nil {
			return err
		}
		childMR, err := s.Oci.Manifest(ctx, repo, child.Digest)
		if err != nil {
			return err
		}
		var childDoc ociDocument
		if err := json.Unmarshal([]byte(childMR.Body), &childDoc); err != nil {
			return err
		}
		selected = child
		if selected.Digest == "" {
			selected.Digest = "sha256:" + sha256Hex([]byte(childMR.Body))
		}
		if len(childDoc.Layers) == 0 && childDoc.Config == nil {
			return fmt.Errorf("platform %s is not an image manifest", job.platform)
		}
		doc = childDoc
	}
	if doc.Config == nil {
		return errors.New("the selected manifest does not describe an image")
	}
	if !isImageConfigMediaType(doc.Config.MediaType) {
		return fmt.Errorf("this artifact is not a container image (config %s); export it as an OCI layout instead", cleanMediaType(doc.Config.MediaType))
	}
	cfgRaw, err := s.Oci.Blob(ctx, repo, doc.Config.Digest)
	if err != nil {
		return fmt.Errorf("reading the image config: %w", err)
	}
	if doc.Config.Size > 0 && int64(len(cfgRaw)) != doc.Config.Size {
		return fmt.Errorf("the image config is %d bytes, the manifest says %d", len(cfgRaw), doc.Config.Size)
	}
	cfgDigest := "sha256:" + sha256Hex(cfgRaw)
	if doc.Config.Digest != "" && cfgDigest != doc.Config.Digest {
		return fmt.Errorf("the image config is corrupt: it hashes to %s, not %s", cfgDigest, doc.Config.Digest)
	}
	var total int64 = int64(len(cfgRaw))
	for _, layer := range doc.Layers {
		total += layer.Size
	}
	setExportProgress(job, 0, total)

	cfgName := strings.TrimPrefix(cfgDigest, "sha256:") + ".json"
	if err := writeTarFileHeader(tw, cfgName, int64(len(cfgRaw))); err != nil {
		return err
	}
	if _, err := tw.Write(cfgRaw); err != nil {
		return err
	}
	addExportDone(job, int64(len(cfgRaw)))

	layerNames := make([]string, 0, len(doc.Layers))
	for _, layer := range doc.Layers {
		hexDigest := strings.TrimPrefix(layer.Digest, "sha256:")
		if hexDigest == "" || strings.ContainsAny(hexDigest, "/\\") {
			return fmt.Errorf("invalid layer digest %q", layer.Digest)
		}
		if strings.Contains(strings.ToLower(layer.MediaType), "zstd") {
			return fmt.Errorf("layer %s uses zstd compression; docker load cannot read it — export as an OCI layout instead", layer.Digest)
		}
		name := hexDigest + "/layer.tar"
		layerNames = append(layerNames, name)
		if err := copyRegistryBlob(ctx, s, repo, layer, tw, name, job); err != nil {
			return err
		}
	}

	manifest := []struct {
		Config   string   `json:"Config"`
		RepoTags []string `json:"RepoTags"`
		Layers   []string `json:"Layers"`
	}{{
		Config: cfgName, RepoTags: []string{repo + ":" + job.tag}, Layers: layerNames,
	}}
	body, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	if err := writeTarFileHeader(tw, "manifest.json", int64(len(body))); err != nil {
		return err
	}
	if _, err := tw.Write(body); err != nil {
		return err
	}
	addExportDone(job, int64(len(body)))
	return nil
}

func choosePlatform(descs []ociDescriptor, platform string) (ociDescriptor, error) {
	want := parsePlatform(platform)
	if want.OS == "" {
		// No explicit choice: prefer linux/amd64, then any known platform, then
		// the first entry. BuildKit attestations ("unknown/unknown") sort last.
		for _, desc := range descs {
			p := platformFromDescriptor(desc.Platform)
			if p.OS == "linux" && p.Architecture == "amd64" {
				return desc, nil
			}
		}
		for _, desc := range descs {
			p := platformFromDescriptor(desc.Platform)
			if p.OS != "" && p.OS != "unknown" && p.Architecture != "" && p.Architecture != "unknown" {
				return desc, nil
			}
		}
		if len(descs) > 0 {
			return descs[0], nil
		}
		return ociDescriptor{}, errors.New("the manifest list is empty")
	}
	for _, desc := range descs {
		p := platformFromDescriptor(desc.Platform)
		if p.OS == want.OS && p.Architecture == want.Architecture &&
			(want.Variant == "" || p.Variant == want.Variant) {
			return desc, nil
		}
	}
	available := make([]string, 0, len(descs))
	for _, desc := range descs {
		if p := platformFromDescriptor(desc.Platform); p.String() != "" {
			available = append(available, p.String())
		}
	}
	return ociDescriptor{}, fmt.Errorf("the image has no %s platform (available: %s)", want.String(), strings.Join(available, ", "))
}

func parsePlatform(value string) transferPlatform {
	parts := strings.Split(strings.TrimSpace(value), "/")
	p := transferPlatform{}
	if len(parts) > 0 {
		p.OS = parts[0]
	}
	if len(parts) > 1 {
		p.Architecture = parts[1]
	}
	if len(parts) > 2 {
		p.Variant = parts[2]
	}
	if p.OS == "" || p.Architecture == "" {
		return transferPlatform{}
	}
	return p
}

func copyRegistryBlob(ctx context.Context, s *Session, repo string, desc ociDescriptor, tw *tar.Writer, name string, job *exportJob) error {
	if desc.Size < 0 {
		return fmt.Errorf("blob %s has a negative size", desc.Digest)
	}
	if err := writeTarFileHeader(tw, name, desc.Size); err != nil {
		return err
	}
	resp, err := s.Oci.OpenBlob(ctx, repo, desc.Digest)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	h := sha256.New()
	written, err := io.CopyN(io.MultiWriter(tw, h), resp.Body, desc.Size)
	if err != nil {
		return fmt.Errorf("reading blob %s failed after %d of %d bytes: %w", desc.Digest, written, desc.Size, err)
	}
	if got := "sha256:" + hex.EncodeToString(h.Sum(nil)); got != desc.Digest {
		return fmt.Errorf("blob %s is corrupt: it hashes to %s", desc.Digest, got)
	}
	addExportDone(job, desc.Size)
	return nil
}

func writeOCIExportFile(ctx context.Context, s *Session, job *exportJob, repo, ref string, tw *tar.Writer) error {
	mr, err := s.Oci.Manifest(ctx, repo, ref)
	if err != nil {
		return err
	}
	var doc ociDocument
	if err := json.Unmarshal([]byte(mr.Body), &doc); err != nil {
		return fmt.Errorf("the manifest is not valid JSON: %w", err)
	}
	top := ociDescriptor{
		MediaType: cleanMediaType(mr.MediaType),
		Digest:    mr.Digest,
		Size:      int64(len(mr.Body)),
	}
	if top.MediaType == "" {
		top.MediaType = cleanMediaType(doc.MediaType)
	}
	if top.Digest == "" {
		top.Digest = "sha256:" + sha256Hex([]byte(mr.Body))
	}
	if isIndexDoc(&doc) && job.platform != "" {
		child, err := choosePlatform(doc.Manifests, job.platform)
		if err != nil {
			return err
		}
		top = child
		if top.Digest == "" {
			return errors.New("the selected platform has no digest")
		}
	}
	graph, err := collectOCIRegistryGraph(ctx, s, repo, top)
	if err != nil {
		return err
	}
	var total int64
	for _, blob := range graph.blobs {
		total += blob.Size
	}
	for _, manifest := range graph.manifests {
		total += int64(len(manifest.Body))
	}
	setExportProgress(job, 0, total)

	layout := []byte(`{"imageLayoutVersion":"1.0.0"}`)
	if err := writeTarFileHeader(tw, "oci-layout", int64(len(layout))); err != nil {
		return err
	}
	if _, err := tw.Write(layout); err != nil {
		return err
	}

	for _, blob := range graph.blobs {
		name := "blobs/sha256/" + strings.TrimPrefix(blob.Digest, "sha256:")
		if err := copyRegistryBlob(ctx, s, repo, ociDescriptor{Digest: blob.Digest, Size: blob.Size}, tw, name, job); err != nil {
			return err
		}
	}
	for _, manifest := range graph.manifests {
		name := "blobs/sha256/" + strings.TrimPrefix(manifest.Digest, "sha256:")
		if err := writeTarFileHeader(tw, name, int64(len(manifest.Body))); err != nil {
			return err
		}
		if _, err := tw.Write(manifest.Body); err != nil {
			return err
		}
		addExportDone(job, int64(len(manifest.Body)))
	}

	// The top manifest may have been selected from an index; find its actual
	// bytes to report the digest and size in index.json.
	var topRef ociManifestRef
	for _, manifest := range graph.manifests {
		if manifest.Digest == top.Digest {
			topRef = manifest
			break
		}
	}
	if topRef.Digest == "" && len(graph.manifests) > 0 {
		topRef = graph.manifests[len(graph.manifests)-1]
	}
	if topRef.Digest == "" {
		return errors.New("the resolved manifest is empty")
	}
	indexDoc := struct {
		SchemaVersion int             `json:"schemaVersion"`
		MediaType     string          `json:"mediaType"`
		Manifests     []ociDescriptor `json:"manifests"`
	}{
		SchemaVersion: 2,
		MediaType:     "application/vnd.oci.image.index.v1+json",
		Manifests: []ociDescriptor{{
			MediaType: topRef.MediaType, Digest: topRef.Digest, Size: int64(len(topRef.Body)),
			Annotations: map[string]string{"org.opencontainers.image.ref.name": job.tag},
		}},
	}
	indexBody, err := json.Marshal(indexDoc)
	if err != nil {
		return err
	}
	if err := writeTarFileHeader(tw, "index.json", int64(len(indexBody))); err != nil {
		return err
	}
	if _, err := tw.Write(indexBody); err != nil {
		return err
	}
	addExportDone(job, int64(len(indexBody)))
	return nil
}

func transferExportStatus(_ context.Context, s *Session, params map[string]any) (any, error) {
	id := strings.TrimSpace(strParam(params, "id"))
	job, err := lookupExport(s, id)
	if err != nil {
		return nil, err
	}
	job.mu.Lock()
	defer job.mu.Unlock()
	job.used = time.Now()
	return map[string]any{
		"id": job.id, "name": job.name, "state": job.state, "error": job.errMsg,
		"done": job.done, "total": job.total, "size": job.size,
		"format": job.format, "gzip": job.gzip, "platform": job.platform, "tag": job.tag,
	}, nil
}

func lookupExport(s *Session, id string) (*exportJob, error) {
	transferJobs.mu.Lock()
	job := transferJobs.exports[id]
	transferJobs.mu.Unlock()
	if job == nil {
		return nil, errors.New("the export session is no longer available")
	}
	job.mu.Lock()
	connID := job.connID
	job.mu.Unlock()
	if connID != s.Conn.ID {
		return nil, errors.New("the export belongs to another connection")
	}
	return job, nil
}

func transferExportChunk(_ context.Context, s *Session, params map[string]any) (any, error) {
	id := strings.TrimSpace(strParam(params, "id"))
	job, err := lookupExport(s, id)
	if err != nil {
		return nil, err
	}
	offset := int64Param(params, "offset")
	length := int64Param(params, "length")
	if length <= 0 || length > transferExportChunkBytes {
		length = transferExportChunkBytes
	}
	job.mu.Lock()
	state, size, path := job.state, job.size, job.path
	job.used = time.Now()
	job.mu.Unlock()
	if state != "ready" {
		return nil, fmt.Errorf("the archive is %s, not ready", state)
	}
	if offset < 0 || offset > size {
		return nil, fmt.Errorf("offset %d is outside the %d byte archive", offset, size)
	}
	if offset == size {
		return map[string]any{"data": "", "offset": offset, "length": 0, "eof": true, "size": size}, nil
	}
	if offset+length > size {
		length = size - offset
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, length)
	if _, err := f.ReadAt(buf, offset); err != nil && err != io.EOF {
		return nil, err
	}
	return map[string]any{
		"data": base64.StdEncoding.EncodeToString(buf), "offset": offset,
		"length": len(buf), "eof": offset+int64(len(buf)) >= size, "size": size,
	}, nil
}

func transferExportClose(_ context.Context, s *Session, params map[string]any) (any, error) {
	id := strings.TrimSpace(strParam(params, "id"))
	job, err := lookupExport(s, id)
	if err != nil {
		return map[string]any{"ok": true}, nil
	}
	transferJobs.mu.Lock()
	if transferJobs.exports[id] == job {
		delete(transferJobs.exports, id)
	}
	transferJobs.mu.Unlock()
	job.mu.Lock()
	cancel, done := job.cancel, job.doneCh
	path := job.path
	job.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
	removeIfExists(path)
	return map[string]any{"ok": true}, nil
}
