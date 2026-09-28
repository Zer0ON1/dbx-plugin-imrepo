package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
)

// Connection lifecycle: parsing what the host sends, verifying it, and keeping the
// resulting session addressable by connection id.

func settingsConnID(params map[string]any) string {
	if id := strings.TrimSpace(strParam(params, "connectionId")); id != "" {
		return id
	}
	if s, err := resolveSession(params); err == nil && s != nil {
		return s.Conn.ID
	}
	return "default"
}

func handleConnect(ctx context.Context, params map[string]any, testOnly bool) (any, error) {
	conn, err := parseConnection(params)
	if err != nil {
		return nil, err
	}
	s, err := buildSession(conn)
	if err != nil {
		return nil, err
	}
	if err := s.verify(ctx); err != nil {
		return nil, err
	}
	upgraded := detectHarbor(ctx, s)
	if !testOnly {
		storeSession(s)
	}
	kind := s.RegistryType
	if upgraded {
		kind += " — detected, was configured as docker-v2"
	}
	return map[string]any{
		"success":      true,
		"message":      "Connected to " + s.BaseURL + " (" + kind + ")",
		"registryType": s.RegistryType,
		"endpoint":     s.BaseURL,
	}, nil
}

// detectHarbor upgrades a connection declared as a generic OCI v2 registry when
// the server actually answers Harbor's API. Picking "Docker Registry v2" for a
// real Harbor is the most common misconfiguration: the generic endpoints work,
// so the sidebar happily shows a project tree, but every Harbor-only operation
// is refused — a state that contradicts itself. A 200 on /api/v2.0/ping is
// proof the server runs Harbor, so the session quietly becomes one and the
// connect message says so.

func detectHarbor(ctx context.Context, s *Session) bool {
	if s.RegistryType != "docker-v2" {
		return false
	}
	data, code, err := s.Harbor.do(ctx, http.MethodGet, "/api/v2.0/ping")
	if err != nil || code != http.StatusOK {
		return false
	}
	// A 200 is not evidence of Harbor: reverse proxies, single-page apps and
	// registries with catch-all routes answer 200 to unknown paths, and reducing
	// it to the status code put a plain v2 registry into Harbor mode — the badge
	// read "harbor" while the project tree stayed empty, because the calls that
	// need the real API then failed.
	//
	// Harbor's endpoint answers the literal string "Pong" (verified against a
	// running Harbor 2.x); some deployments front it with a JSON body naming a
	// harbor component, so accept either shape.
	body := strings.ToLower(strings.TrimSpace(string(data)))
	if !strings.Contains(body, "pong") && !strings.Contains(body, "harbor") {
		return false
	}
	s.RegistryType = registryTypeHarbor
	return true
}

func handleAction(ctx context.Context, params map[string]any) (any, error) {
	id := ""
	if action, ok := params["action"].(map[string]any); ok {
		id, _ = action["id"].(string)
	}
	switch id {
	case "refresh":
		conn, err := parseConnection(params)
		if err != nil {
			return nil, err
		}
		s, err := buildSession(conn)
		if err != nil {
			return nil, err
		}
		if err := s.verify(ctx); err != nil {
			return nil, err
		}
		detectHarbor(ctx, s)
		storeSession(s)
		return map[string]any{
			"success":      true,
			"message":      "Refreshed " + s.BaseURL + " (" + s.RegistryType + ")",
			"registryType": s.RegistryType,
			"endpoint":     s.BaseURL,
		}, nil
	default:
		return map[string]any{"success": true, "message": "OK"}, nil
	}
}

func parseConnection(params map[string]any) (*Connection, error) {
	raw, ok := params["connection"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("missing connection object")
	}
	b, _ := json.Marshal(raw)
	var conn Connection
	if err := json.Unmarshal(b, &conn); err != nil {
		return nil, fmt.Errorf("invalid connection: %w", err)
	}
	// Some hosts deliver the secret at the TOP LEVEL of the lifecycle request
	// (params.secret) instead of inside the connection object. Merge every
	// shape we know of; never overwrite a value already present.
	if sec, ok := params["secret"].(map[string]any); ok {
		if conn.Secret == nil {
			conn.Secret = map[string]string{}
		}
		for k, v := range sec {
			if conn.Secret[k] == "" {
				conn.Secret[k] = fmt.Sprintf("%v", v)
			}
		}
	}
	if conn.ID == "" {
		conn.ID = "imrepo-connection"
	}
	return &conn, nil
}

// registryTypeHarbor is the only preset whose REST API can delete a single tag.

const registryTypeHarbor = "harbor"

const (
	// A project with hundreds of repositories would turn one click into hundreds
	// of requests; scan a bounded prefix and say so.
	maxUntaggedScanRepos = 100
	// Upper bound on one cleanup call, so a bug in the client cannot turn a
	// confirmation into an unbounded delete loop.
	maxCleanupBatch = 300
)

// requireHarbor guards operations that only Harbor's REST API can perform.

func requireHarbor(s *Session) error {
	if s.RegistryType != registryTypeHarbor {
		return fmt.Errorf(
			"this operation needs the Harbor API (this connection is configured as a plain OCI v2 registry). If the server actually runs Harbor, reconnect or hit refresh — Harbor features are then enabled automatically")
	}
	return nil
}

// cleanupUntagged deletes dangling artifacts, re-verifying every one of them
// immediately before deletion.
//
// The scan a user confirms can be minutes old, and a digest that was dangling
// then may carry a tag now. Deleting it anyway would destroy a live image, so a
// target that has since been tagged is reported as skipped, never deleted.

func (s *Session) verify(ctx context.Context) error {
	var causes []string

	if resp, err := s.Oci.do(ctx, http.MethodGet, "/v2/", nil, "", "registry:catalog:*"); err == nil {
		resp.Body.Close()
		// 401/403 still proves the endpoint speaks the registry protocol.
		if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return nil
		}
		causes = append(causes, fmt.Sprintf("GET %s/v2/ -> HTTP %d", s.BaseURL, resp.StatusCode))
	} else {
		cause := fmt.Sprintf("GET %s/v2/ -> %v", s.BaseURL, err)
		// A transport-level failure (refused / unknown host / bad TLS) already
		// explains everything; pinging Harbor would only repeat the same text.
		if isTransportFailure(err) {
			return fmt.Errorf("cannot reach registry: %s%s", cause, connectionHint)
		}
		causes = append(causes, cause)
	}

	if _, code, err := s.Harbor.do(ctx, http.MethodGet, "/api/v2.0/ping"); err == nil && code == http.StatusOK {
		return nil
	} else if err != nil {
		causes = append(causes, fmt.Sprintf("GET %s/api/v2.0/ping -> %v", s.BaseURL, err))
	} else {
		causes = append(causes, fmt.Sprintf("GET %s/api/v2.0/ping -> HTTP %d", s.BaseURL, code))
	}

	return fmt.Errorf("cannot reach registry: %s%s", strings.Join(causes, " | "), connectionHint)
}

const connectionHint = " (check host/port, network reachability, TLS trust, and the \"insecure / self-signed\" option)"

// isTransportFailure reports whether err means we never completed an HTTP
// exchange, so retrying another endpoint on the same host is pointless.

func isTransportFailure(err error) bool {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return true
	}
	var certErr *tls.CertificateVerificationError
	if errors.As(err, &certErr) {
		return true
	}
	var opErr *net.OpError
	return errors.As(err, &opErr)
}

// rankIndexEntries orders a manifest list so a real image comes first.
//
// BuildKit pushes attestation entries next to the images; those declare platform
// "unknown/unknown" and contain no layers. Selecting one yields "0 layers",
// which reads as a broken feature rather than a wrong pick.
