package main

import (
	"context"
	"encoding/base64"
	"fmt"
)

// Credential is a resolved registry credential ready to be turned into
// an Authorization header.
type Credential struct {
	Scheme   string // "basic" or "bearer"
	Username string
	Password string
	Token    string
}

// Header renders the Authorization header value.
func (c *Credential) Header() string {
	if c == nil {
		return ""
	}
	if c.Scheme == "bearer" {
		return "Bearer " + c.Token
	}
	if c.Username != "" || c.Password != "" {
		return "Basic " + base64.StdEncoding.EncodeToString([]byte(c.Username+":"+c.Password))
	}
	return ""
}

// AuthProvider resolves a credential for a connection. Cloud-backed
// providers may perform a token exchange (network) inside Credential().
type AuthProvider interface {
	Credential(ctx context.Context) (*Credential, error)
}

// newAuthProvider builds the correct provider for the connection.
func newAuthProvider(conn *Connection) (AuthProvider, error) {
	switch conn.authType() {
	case "basic", "robot":
		user := conn.Username
		pass := conn.password()
		return &basicAuth{user: user, pass: pass}, nil
	case "token":
		return &bearerAuth{token: conn.secretStr("token")}, nil
	case "aws-ecr":
		return newAwsEcrAuth(conn)
	case "aliyun-aksk":
		return newAliyunAuth(conn)
	case "tencent-aksk":
		return newTencentAuth(conn)
	case "noauth", "none", "anonymous":
		return &noAuth{}, nil
	default:
		return nil, fmt.Errorf("unsupported auth_type: %q", conn.authType())
	}
}

// noAuth resolves to an empty credential: no Authorization header is ever sent,
// which is what a registry without authentication (or with anonymous pull)
// expects.
type noAuth struct{}

func (a *noAuth) Credential(_ context.Context) (*Credential, error) {
	return &Credential{}, nil
}

type basicAuth struct {
	user string
	pass string
}

func (a *basicAuth) Credential(_ context.Context) (*Credential, error) {
	return &Credential{Scheme: "basic", Username: a.user, Password: a.pass}, nil
}

type bearerAuth struct {
	token string
}

func (a *bearerAuth) Credential(_ context.Context) (*Credential, error) {
	if a.token == "" {
		return nil, fmt.Errorf("access token is empty")
	}
	return &Credential{Scheme: "bearer", Token: a.token}, nil
}
