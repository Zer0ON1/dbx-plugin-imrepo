package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"

	dbxpluginsdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

// methodNotFoundError marks requests the sidecar does not implement, so the
// RPC layer can answer with the JSON-RPC -32601 code instead of a generic error.
type methodNotFoundError struct{ method string }

func (e *methodNotFoundError) Error() string { return "method not found: " + e.method }

// Fallbacks, used only when the packaged manifest cannot be located (e.g. a
// sidecar launched straight out of a build directory).
const (
	pluginID      = "com.leavingrain.imrepo"
	pluginVersion = "0.1.0"
)

// githubURL is the project page shown in Settings → About.
const githubURL = "https://github.com/Zer0ON1/dbx-plugin-imrepo"

// identity resolved at startup (manifest wins), so both the handshake and the
// About panel report the same thing.
var (
	resolvedPluginID      = pluginID
	resolvedPluginVersion = pluginVersion
)

func pluginIdentity() (string, string) { return resolvedPluginID, resolvedPluginVersion }

// manifestIdentity resolves the id/version the host will compare us against.
//
// The host rejects the plugin when the sidecar's advertised identity differs
// from manifest.json — "Plugin backend identity 'x/1.2.0' does not match
// manifest 'x/1.2.1'". Hard-coding the version here means every release must
// remember to bump two files, and forgetting once bricks the plugin at runtime.
// Reading it from the manifest the binary actually ships inside makes that
// class of drift impossible.
//
// The binary lives at <plugin>/bin/<target>/<name>[.exe], so we walk up a few
// levels looking for manifest.json; in `dbx-plugin dev` the same walk finds the
// project manifest.
func manifestIdentity() (id, version string) {
	exe, err := os.Executable()
	if err != nil {
		return "", ""
	}
	dir := filepath.Dir(exe)
	for depth := 0; depth < 5; depth++ {
		raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
		if err == nil {
			var m struct {
				ID      string `json:"id"`
				Version string `json:"version"`
			}
			if json.Unmarshal(raw, &m) == nil && m.ID != "" && m.Version != "" {
				return strings.TrimSpace(m.ID), strings.TrimSpace(m.Version)
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", ""
}

type plugin struct{}

func (p *plugin) Handle(_ dbxpluginsdk.RequestContext, method string, params json.RawMessage, _ *dbxpluginsdk.Emitter) (any, *dbxpluginsdk.PluginError) {
	values := map[string]any{}
	if len(params) > 0 && string(params) != "null" {
		if err := json.Unmarshal(params, &values); err != nil {
			return nil, dbxpluginsdk.NewError(-32602, "Invalid request parameters")
		}
	}
	result, err := handle(context.Background(), method, values)
	if err != nil {
		var mnf *methodNotFoundError
		if errors.As(err, &mnf) {
			return nil, dbxpluginsdk.MethodNotFound(mnf.method)
		}
		return nil, dbxpluginsdk.NewError(-32000, err.Error())
	}
	return result, nil
}

func main() {
	id, version := pluginID, pluginVersion
	if mid, mver := manifestIdentity(); mid != "" {
		id, version = mid, mver
	} else {
		log.Printf("imrepo: manifest.json not found next to binary, using built-in identity %s/%s", id, version)
	}
	resolvedPluginID, resolvedPluginVersion = id, version

	metadata := dbxpluginsdk.Metadata{
		ID:           id,
		Version:      version,
		Capabilities: []string{"connections"},
	}
	server := dbxpluginsdk.NewServer(metadata, &plugin{})
	if err := server.Serve(); err != nil {
		log.Fatal(err)
	}
}
