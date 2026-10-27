package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// ---------------------------------------------------------------------------
// OCI Distribution — the push half, and streaming blob reads for export
//
// The read paths in oci.go buffer every response; that is fine for manifests
// and config blobs and unusable for image layers, which routinely run to
// hundreds of megabytes. Everything here streams instead: blobs go up from a
// replayable reader and come down as an io.ReadCloser the caller copies from.
// ---------------------------------------------------------------------------

// request is the streaming counterpart of OciClient.do.
//
// makeBody is called once per attempt, so a token challenge can be answered by
// replaying the body. It returns (nil, 0, nil) for a body-less request.
// Credentials are only ever sent to the registry itself: an upload Location
// may be a pre-signed URL on another host (S3 and friends), and forwarding the
// registry's Authorization header there would both break the signature and
// hand the credential to a third party.
func (c *OciClient) request(
	ctx context.Context,
	method, urlStr string,
	makeBody func() (io.Reader, int64, error),
	contentType, scope string,
	headers map[string]string,
) (*http.Response, error) {
	sameHost := c.sameHost(urlStr)
	attempts := 0
	for {
		var body io.Reader
		var size int64
		if makeBody != nil {
			var err error
			body, size, err = makeBody()
			if err != nil {
				return nil, err
			}
		}
		req, err := http.NewRequestWithContext(ctx, method, urlStr, body)
		if err != nil {
			return nil, err
		}
		if makeBody != nil {
			req.ContentLength = size
			req.GetBody = func() (io.ReadCloser, error) {
				replay, _, err := makeBody()
				if err != nil {
					return nil, err
				}
				if rc, ok := replay.(io.ReadCloser); ok {
					return rc, nil
				}
				return io.NopCloser(replay), nil
			}
		}
		if contentType != "" {
			req.Header.Set("content-type", contentType)
		}
		req.Header.Set("accept", "*/*")
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		if sameHost {
			if tok := c.tokenFor(scope); tok != "" {
				req.Header.Set("authorization", "Bearer "+tok)
			} else if c.cred != nil {
				req.Header.Set("authorization", c.cred.Header())
			}
		}

		client := c.stream
		if client == nil {
			client = c.http
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode == http.StatusUnauthorized && attempts == 0 && sameHost {
			challenge := resp.Header.Get("www-authenticate")
			resp.Body.Close()
			if tok, ok := c.fetchToken(ctx, challenge, scope); ok {
				c.setToken(scope, tok)
				attempts++
				continue
			}
		}
		return resp, nil
	}
}

func (c *OciClient) sameHost(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return true
	}
	base, err := url.Parse(c.base)
	if err != nil {
		return true
	}
	return strings.EqualFold(u.Host, base.Host)
}

// absoluteLocation resolves a Location header, which registries send both as a
// path ("/v2/.../uploads/<id>") and as an absolute URL (often a storage host).
func (c *OciClient) absoluteLocation(loc string) string {
	u, err := url.Parse(strings.TrimSpace(loc))
	if err != nil {
		return c.base + "/" + strings.TrimLeft(loc, "/")
	}
	if u.IsAbs() {
		return u.String()
	}
	base, err := url.Parse(c.base)
	if err != nil {
		return c.base + "/" + strings.TrimLeft(loc, "/")
	}
	return base.ResolveReference(u).String()
}

// withDigest adds ?digest= to an upload Location without losing its own query.
func withDigest(loc, digest string) string {
	u, err := url.Parse(loc)
	if err != nil {
		return loc
	}
	q := u.Query()
	q.Set("digest", digest)
	u.RawQuery = q.Encode()
	return u.String()
}

// BlobExists asks the registry whether a blob is already present. A registry
// that answers 401 is treated as "unknown" rather than an error: the upload can
// still proceed, and a push-only account may legitimately lack pull on HEAD.
func (c *OciClient) BlobExists(ctx context.Context, repo, digest string) bool {
	resp, err := c.request(ctx, http.MethodHead, c.base+"/v2/"+repo+"/blobs/"+digest,
		nil, "", scopeFor(repo, "pull,push"), nil)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// startUpload opens one blob-upload session and returns its Location.
func (c *OciClient) startUpload(ctx context.Context, repo string) (string, error) {
	resp, err := c.request(ctx, http.MethodPost, c.base+"/v2/"+repo+"/blobs/uploads/",
		nil, "", scopeFor(repo, "pull,push"), nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("starting the blob upload failed (%d): %s", resp.StatusCode, truncate(string(data), 300))
	}
	loc := resp.Header.Get("location")
	if loc == "" {
		return "", errors.New("the registry accepted the upload but returned no Location header")
	}
	return c.absoluteLocation(loc), nil
}

// PushBlob uploads one blob unless the registry already has it.
//
// A single PUT carrying the whole body (monolithic upload) is tried first; it
// is the shortest path and what Harbor, Docker Hub and the cloud registries
// implement. Registries that reject it fall back to PATCH-then-PUT, the chunked
// form every OCI distribution server understands.
func (c *OciClient) PushBlob(
	ctx context.Context,
	repo, digest string,
	size int64,
	open func() (io.ReadSeeker, error),
	progress func(transferred, total int64),
) error {
	if !digestPattern.MatchString(digest) {
		return fmt.Errorf("invalid blob digest %q", digest)
	}
	if c.BlobExists(ctx, repo, digest) {
		if progress != nil {
			progress(size, size)
		}
		return nil
	}
	scope := scopeFor(repo, "pull,push")

	// Monolithic attempt.
	loc, err := c.startUpload(ctx, repo)
	if err != nil {
		return err
	}
	resp, err := c.request(ctx, http.MethodPut, withDigest(loc, digest), func() (io.Reader, int64, error) {
		r, err := open()
		if err != nil {
			return nil, 0, err
		}
		if progress == nil {
			return r, size, nil
		}
		return &progressReader{r: r, total: size, report: progress}, size, nil
	}, "application/octet-stream", scope, nil)
	if err != nil {
		return err
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusCreated, http.StatusNoContent:
		if progress != nil {
			progress(size, size)
		}
		return nil
	case http.StatusAccepted:
		// The server kept the upload open; finish it against the Location it
		// returned (or the one we already had).
		finish := resp.Header.Get("location")
		if finish == "" {
			finish = loc
		}
		finish = c.absoluteLocation(finish)
		return c.finishUpload(ctx, withDigest(finish, digest), digest, scope)
	}
	firstErr := fmt.Errorf("uploading blob %s failed (%d): %s", digest, resp.StatusCode, truncate(string(data), 300))
	switch resp.StatusCode {
	case http.StatusBadRequest, http.StatusMethodNotAllowed, http.StatusRequestEntityTooLarge,
		http.StatusUnsupportedMediaType, http.StatusNotImplemented:
		// A registry that refuses a body on PUT; try the chunked form below.
	default:
		// Auth failures, missing repositories and server errors are not fixed by
		// repeating the body through another upload session.
		return firstErr
	}

	// Chunked fallback for registries that refuse a body on PUT.
	loc, err = c.startUpload(ctx, repo)
	if err != nil {
		return firstErr
	}
	resp, err = c.request(ctx, http.MethodPatch, loc, func() (io.Reader, int64, error) {
		r, err := open()
		if err != nil {
			return nil, 0, err
		}
		if progress == nil {
			return r, size, nil
		}
		return &progressReader{r: r, total: size, report: progress}, size, nil
	}, "application/octet-stream", scope, map[string]string{
		"content-range": fmt.Sprintf("0-%d", maxInt64(size-1, 0)),
	})
	if err != nil {
		return firstErr
	}
	patchData, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	patchCode := resp.StatusCode
	if next := resp.Header.Get("location"); next != "" {
		loc = c.absoluteLocation(next)
	}
	resp.Body.Close()
	if patchCode != http.StatusAccepted && patchCode != http.StatusNoContent {
		return fmt.Errorf("%v; the chunked fallback also failed (%d): %s", firstErr, patchCode, truncate(string(patchData), 200))
	}
	if err := c.finishUpload(ctx, withDigest(loc, digest), digest, scope); err != nil {
		return fmt.Errorf("%v; the chunked fallback also failed: %w", firstErr, err)
	}
	if progress != nil {
		progress(size, size)
	}
	return nil
}

func (c *OciClient) finishUpload(ctx context.Context, loc, digest, scope string) error {
	resp, err := c.request(ctx, http.MethodPut, loc, func() (io.Reader, int64, error) {
		return strings.NewReader(""), 0, nil
	}, "application/octet-stream", scope, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("completing blob %s failed (%d): %s", digest, resp.StatusCode, truncate(string(data), 300))
	}
	return nil
}

// PushManifest publishes a manifest under a tag or digest.
func (c *OciClient) PushManifest(ctx context.Context, repo, reference, mediaType string, body []byte) error {
	resp, err := c.request(ctx, http.MethodPut, c.base+"/v2/"+repo+"/manifests/"+reference,
		func() (io.Reader, int64, error) {
			return strings.NewReader(string(body)), int64(len(body)), nil
		}, mediaType, scopeFor(repo, "pull,push"), nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		return fmt.Errorf("pushing manifest %s failed (%d): %s", reference, resp.StatusCode, truncate(string(data), 300))
	}
	return nil
}

// OpenBlob starts a streaming read of a blob. The caller owns the response body.
func (c *OciClient) OpenBlob(ctx context.Context, repo, digest string) (*http.Response, error) {
	resp, err := c.request(ctx, http.MethodGet, c.base+"/v2/"+repo+"/blobs/"+digest,
		nil, "", scopeFor(repo, "pull"), nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		resp.Body.Close()
		return nil, fmt.Errorf("reading blob %s failed (%d): %s", digest, resp.StatusCode, truncate(string(data), 300))
	}
	return resp, nil
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// progressReader reports how many bytes of this blob have been handed to the
// transport. It is advisory only — the HTTP stack may buffer — but it is what
// turns a multi-gigabyte upload from a frozen dialog into a moving bar.
type progressReader struct {
	r        io.Reader
	total    int64
	read     int64
	report   func(transferred, total int64)
	reported int64
}

func (p *progressReader) Read(buf []byte) (int, error) {
	n, err := p.r.Read(buf)
	p.read += int64(n)
	if p.report != nil && p.read-p.reported >= 512<<10 {
		p.reported = p.read
		p.report(p.read, p.total)
	}
	return n, err
}

// Close forwards to the underlying reader. Without it net/http wraps this in
// NopCloser and the archive's file descriptor is never released.
func (p *progressReader) Close() error {
	if closer, ok := p.r.(io.Closer); ok {
		return closer.Close()
	}
	return nil
}
