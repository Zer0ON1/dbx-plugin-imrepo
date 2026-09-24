package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// httpClient builds an HTTP client honoring the insecure flag.
func httpClient(conn *Connection) *http.Client {
	tr := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: conn.configBool("insecure")},
		MaxIdleConns:        20,
		MaxIdleConnsPerHost: 5,
		IdleConnTimeout:     90 * time.Second,
	}
	return &http.Client{Transport: tr, Timeout: 60 * time.Second}
}

// baseURL resolves the registry base URL from the connection.
func baseURL(conn *Connection) string {
	endpoint := strings.TrimSpace(conn.Host)
	if endpoint == "" {
		endpoint = "127.0.0.1"
	}
	if !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
		// An explicit scheme selection wins; otherwise fall back to the insecure
		// flag (and finally https). This keeps a host that already carries a
		// scheme untouched while the form offers a plain http/https choice.
		scheme := strings.ToLower(conn.configStr("scheme"))
		if scheme != "http" && scheme != "https" {
			if conn.configBool("insecure") {
				scheme = "http"
			} else {
				scheme = "https"
			}
		}
		endpoint = scheme + "://" + endpoint
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return strings.TrimRight(endpoint, "/")
	}
	if conn.Port != 0 && u.Port() == "" {
		if !((conn.Port == 443 && u.Scheme == "https") || (conn.Port == 80 && u.Scheme == "http")) {
			u.Host = net.JoinHostPort(u.Hostname(), strconv.Itoa(conn.Port))
		}
	}
	return strings.TrimRight(u.String(), "/")
}

// ---------------------------------------------------------------------------
// OCI Registry v2 client
// ---------------------------------------------------------------------------

type OciClient struct {
	base   string
	cred   *Credential
	http   *http.Client
	tokens map[string]string // scope -> bearer token
	anonOK bool
}

func newOciClient(base string, cred *Credential, hc *http.Client) *OciClient {
	return &OciClient{base: base, cred: cred, http: hc, tokens: map[string]string{}}
}

// do performs a request with the Docker Registry v2 token-challenge flow.
// scope is the OCI scope string (e.g. "repository:foo/bar:pull").
func (c *OciClient) do(ctx context.Context, method, path string, body []byte, contentType, scope string) (*http.Response, error) {
	urlStr := c.base + path
	attempts := 0
	for {
		req, err := http.NewRequestWithContext(ctx, method, urlStr, nil)
		if err != nil {
			return nil, err
		}
		if body != nil {
			req.Body = io.NopCloser(strings.NewReader(string(body)))
			req.ContentLength = int64(len(body))
		}
		if contentType != "" {
			req.Header.Set("content-type", contentType)
		}
		req.Header.Set("accept", "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json, */*")

		// Prefer a cached bearer token for this scope.
		if tok := c.tokens[scope]; tok != "" {
			req.Header.Set("authorization", "Bearer "+tok)
		} else if c.cred != nil {
			req.Header.Set("authorization", c.cred.Header())
		}

		resp, err := c.http.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode == http.StatusUnauthorized && attempts == 0 {
			challenge := resp.Header.Get("www-authenticate")
			resp.Body.Close()
			if tok, ok := c.fetchToken(ctx, challenge, scope); ok {
				c.tokens[scope] = tok
				attempts++
				continue
			}
			// No bearer challenge to satisfy; return the 401.
			return c.replay(ctx, method, urlStr, body, contentType)
		}
		return resp, nil
	}
}

func (c *OciClient) replay(ctx context.Context, method, urlStr string, body []byte, contentType string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, urlStr, nil)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Body = io.NopCloser(strings.NewReader(string(body)))
		req.ContentLength = int64(len(body))
	}
	if contentType != "" {
		req.Header.Set("content-type", contentType)
	}
	if c.cred != nil {
		req.Header.Set("authorization", c.cred.Header())
	}
	return c.http.Do(req)
}

// fetchToken parses the WWW-Authenticate challenge and obtains a bearer token.
func (c *OciClient) fetchToken(ctx context.Context, challenge, scope string) (string, bool) {
	if challenge == "" || !strings.Contains(strings.ToLower(challenge), "bearer") {
		return "", false
	}
	realm, service := "", ""
	for _, part := range strings.Split(challenge, ",") {
		part = strings.TrimSpace(part)
		lower := strings.ToLower(part)
		switch {
		case strings.HasPrefix(lower, "bearer realm"):
			realm = unquote(strings.TrimSpace(part[len("bearer realm"):]))
		case strings.HasPrefix(lower, "service"):
			service = unquote(strings.TrimSpace(part[len("service"):]))
		}
	}
	if realm == "" {
		return "", false
	}
	u, err := url.Parse(realm)
	if err != nil {
		return "", false
	}
	q := u.Query()
	if service != "" {
		q.Set("service", service)
	}
	if scope != "" {
		q.Set("scope", scope)
	}
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", false
	}
	if c.cred != nil && c.cred.Header() != "" {
		req.Header.Set("authorization", c.cred.Header())
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", false
	}
	var out struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", false
	}
	tok := out.Token
	if tok == "" {
		tok = out.AccessToken
	}
	return tok, tok != ""
}

func unquote(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "=")
	s = strings.TrimSpace(s)
	s = strings.Trim(s, `"`)
	return s
}

func scopeFor(repo, verb string) string {
	if repo == "" {
		return "registry:catalog:*"
	}
	return "repository:" + repo + ":" + verb
}

// Catalog lists repository names (supports optional search filter).
func (c *OciClient) Catalog(ctx context.Context, search string) ([]string, error) {
	resp, err := c.do(ctx, http.MethodGet, "/v2/_catalog?n=1000", nil, "", "registry:catalog:*")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("catalog not available (%d): %s", resp.StatusCode, truncate(string(data), 200))
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("catalog failed (%d): %s", resp.StatusCode, truncate(string(data), 200))
	}
	var out struct {
		Repositories []string `json:"repositories"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	if search == "" {
		return out.Repositories, nil
	}
	var res []string
	for _, r := range out.Repositories {
		if strings.Contains(strings.ToLower(r), strings.ToLower(search)) {
			res = append(res, r)
		}
	}
	return res, nil
}

// Tags lists tags for a repository.
func (c *OciClient) Tags(ctx context.Context, repo string) ([]string, error) {
	resp, err := c.do(ctx, http.MethodGet, "/v2/"+repo+"/tags/list?n=1000", nil, "", scopeFor(repo, "pull"))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tags failed (%d): %s", resp.StatusCode, truncate(string(data), 200))
	}
	var out struct {
		Tags []string `json:"tags"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out.Tags, nil
}

// ManifestResult carries a manifest body and its digest.
type ManifestResult struct {
	Digest    string `json:"digest"`
	MediaType string `json:"mediaType"`
	Body      string `json:"body"`
}

// Manifest fetches a manifest by tag or digest.
func (c *OciClient) Manifest(ctx context.Context, repo, ref string) (*ManifestResult, error) {
	resp, err := c.do(ctx, http.MethodGet, "/v2/"+repo+"/manifests/"+ref, nil, "", scopeFor(repo, "pull"))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("manifest failed (%d): %s", resp.StatusCode, truncate(string(data), 300))
	}
	return &ManifestResult{
		Digest:    resp.Header.Get("docker-content-digest"),
		MediaType: resp.Header.Get("content-type"),
		Body:      string(data),
	}, nil
}

// Retag copies a manifest from sourceTag to targetTag without re-uploading layers.
func (c *OciClient) Retag(ctx context.Context, repo, sourceTag, targetTag string) error {
	src, err := c.Manifest(ctx, repo, sourceTag)
	if err != nil {
		return fmt.Errorf("reading source manifest: %w", err)
	}
	resp, err := c.do(ctx, http.MethodPut, "/v2/"+repo+"/manifests/"+targetTag, []byte(src.Body), src.MediaType, scopeFor(repo, "pull,push"))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("retag failed (%d): %s", resp.StatusCode, truncate(string(data), 300))
	}
	return nil
}

// manifestInfo resolves a tag (or digest) reference to the concrete image
// manifest and returns its digest plus the summed compressed layer sizes. A
// manifest list / index is followed to its first image manifest, skipping
// attestation entries that carry no layers. One request per reference.
func (c *OciClient) manifestInfo(ctx context.Context, repo, ref string) (string, int64, error) {
	mr, err := c.Manifest(ctx, repo, ref)
	if err != nil {
		return "", 0, err
	}
	digest := mr.Digest
	var doc map[string]any
	if err := json.Unmarshal([]byte(mr.Body), &doc); err != nil {
		return digest, 0, err
	}
	if entries, ok := doc["manifests"].([]any); ok {
		for _, e := range entries {
			em, _ := e.(map[string]any)
			dg, _ := em["digest"].(string)
			if dg == "" {
				continue
			}
			child, err := c.Manifest(ctx, repo, dg)
			if err != nil {
				continue
			}
			var cd map[string]any
			if json.Unmarshal([]byte(child.Body), &cd) != nil {
				continue
			}
			if _, has := cd["layers"].([]any); has {
				doc = cd
				digest = child.Digest
				break
			}
		}
	}
	layers, _ := doc["layers"].([]any)
	var total int64
	for _, l := range layers {
		lm, _ := l.(map[string]any)
		if sz, ok := lm["size"].(float64); ok {
			total += int64(sz)
		}
	}
	return digest, total, nil
}

// Blob fetches a blob (config or layer) by digest.
func (c *OciClient) Blob(ctx context.Context, repo, digest string) ([]byte, error) {
	resp, err := c.do(ctx, http.MethodGet, "/v2/"+repo+"/blobs/"+digest, nil, "", scopeFor(repo, "pull"))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("blob failed (%d): %s", resp.StatusCode, truncate(string(data), 200))
	}
	return data, nil
}

// Delete removes a manifest by digest (unbinds the tag).
func (c *OciClient) Delete(ctx context.Context, repo, digest string) error {
	resp, err := c.do(ctx, http.MethodDelete, "/v2/"+repo+"/manifests/"+digest, nil, "", scopeFor(repo, "*"))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("delete failed (%d): %s", resp.StatusCode, truncate(string(data), 300))
	}
	return nil
}
