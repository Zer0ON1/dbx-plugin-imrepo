package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// MCP tools: the surface DBX's assistant calls in Agent mode.
//
// Two methods, per the plugin docs:
//
//	mcp/tools  {connectionId}                  -> {"tools": [{name, description, inputSchema, annotations?}]}
//	mcp/call   {tool, arguments, lifecycle}    -> {"content": [{"type":"text","text":"..."}], "isError": false}
//
// The design decision that matters most is not in this file's shape but in what
// the handlers call: every tool drives the *same* backend function the workbench
// UI uses. A second implementation would quietly bypass the retention policy,
// the cleanup rules and the re-check before a delete — the host's confirmation
// prompt guards against a model acting by mistake, and the docs are explicit
// that it "cannot replace the plugin's own safety rules".
//
// The `lifecycle` payload is the same one connection/connect receives, so
// credentials arrive from the host and never travel through tool arguments.

// mcpTool is one entry in the declaration list. InputSchema is the portable
// subset the host accepts across model providers: object/string/integer/boolean,
// properties, required, and string enums. Parameter names are [A-Za-z0-9_].
type mcpTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations,omitempty"`
}

// mcpReadOnly is the annotation that lets a tool run without a confirmation
// prompt. It is applied to tools that only read, and to nothing else.
func mcpReadOnly() map[string]any { return map[string]any{"readOnlyHint": true} }

// schema builds an object schema; helpers keep the declarations readable.
func schema(props map[string]any, required ...string) map[string]any {
	s := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func strProp(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}

func intProp(desc string, min, max int) map[string]any {
	return map[string]any{"type": "integer", "description": desc, "minimum": min, "maximum": max}
}

func boolProp(desc string) map[string]any {
	return map[string]any{"type": "boolean", "description": desc}
}

// mcpTools returns the declaration list. Order is the order the host presents,
// so reads come first.
var mcpTools = []mcpTool{
	{
		Name:        "list_projects",
		Description: "List the projects (Harbor) or namespaces (plain OCI v2 registry) this registry exposes, with their repository counts. Start here: the names it returns are what every other tool takes as `project`.",
		InputSchema: schema(map[string]any{}),
		Annotations: mcpReadOnly(),
	},
	{
		Name:        "list_repositories",
		Description: "List the repositories inside one project, with artifact and pull counts.",
		InputSchema: schema(map[string]any{
			"project": strProp("Project name, as returned by list_projects."),
		}, "project"),
		Annotations: mcpReadOnly(),
	},
	{
		Name:        "list_tags",
		Description: "List the tags of one repository, newest first, with each tag's digest, compressed size, push time and CPU architectures (amd64, arm64, ...).",
		InputSchema: schema(map[string]any{
			"project":    strProp("Project name."),
			"repository": strProp("Repository name, without the project prefix."),
			"limit":      intProp("Maximum tags to return, newest first. Defaults to 50; the registry may hold many more.", 1, 200),
		}, "project", "repository"),
		Annotations: mcpReadOnly(),
	},
	{
		Name:        "image_info",
		Description: "Describe one image: manifest digest, total compressed size, platform(s), layer count and push time. Use `reference` for a tag or a digest.",
		InputSchema: schema(map[string]any{
			"project":    strProp("Project name."),
			"repository": strProp("Repository name, without the project prefix."),
			"reference":  strProp("Tag or manifest digest."),
		}, "project", "repository", "reference"),
		Annotations: mcpReadOnly(),
	},
	{
		Name:        "vulnerabilities",
		Description: "Vulnerability report for one image: counts by severity, the identifiers found, and whether the registry's configured threshold is reached. Harbor only — a plain OCI v2 registry has no scanner API and this reports that rather than an empty result.",
		InputSchema: schema(map[string]any{
			"project":    strProp("Project name."),
			"repository": strProp("Repository name, without the project prefix."),
			"reference":  strProp("Tag or manifest digest."),
		}, "project", "repository", "reference"),
		Annotations: mcpReadOnly(),
	},
	{
		Name:        "create_project",
		Description: "Create a new Harbor project. Refused if the project already exists. Harbor only — on a plain OCI v2 registry the first path segment of a repository name is its namespace and there is nothing to create.",
		InputSchema: schema(map[string]any{
			"project": strProp("Project name."),
			"public":  boolProp("Whether the project is readable without authentication. Defaults to private."),
		}, "project"),
	},
	{
		Name:        "set_project_public",
		Description: "Change whether a Harbor project is public (readable without authentication) or private. Harbor only.",
		InputSchema: schema(map[string]any{
			"project": strProp("Project name."),
			"public":  boolProp("True for public, false for private."),
		}, "project", "public"),
	},
	{
		Name:        "retag",
		Description: "Rename a tag: writes the manifest under `target_tag`. On Harbor the old tag is then removed (pass delete_source=false to keep it); on a plain OCI v2 registry the write is all that is possible, the old tag stays and the result says so. Refused if the source tag is protected by the retention policy.",
		InputSchema: schema(map[string]any{
			"project":       strProp("Project name."),
			"repository":    strProp("Repository name, without the project prefix."),
			"source_tag":    strProp("Tag to read."),
			"target_tag":    strProp("Tag to write."),
			"delete_source": boolProp("Harbor only: remove the source tag afterwards. Defaults to true."),
		}, "project", "repository", "source_tag", "target_tag"),
	},
	{
		Name:        "delete_tag",
		Description: "Delete one tag. Refused when the retention policy protects it — that refusal comes from the plugin, not from this prompt, and stands even if the call is approved. Deleting a tag only unlinks the image; the registry reclaims the space later through garbage collection.",
		InputSchema: schema(map[string]any{
			"project":    strProp("Project name."),
			"repository": strProp("Repository name, without the project prefix."),
			"tag":        strProp("Tag to delete."),
		}, "project", "repository", "tag"),
	},
}

func toolByName(name string) *mcpTool {
	// The host prefixes tool names when it exposes them (<prefix>__<name>).
	// Stripping it here means the lookup works whether the host hands back the
	// bare name or the prefixed one — cheaper than guessing which.
	bare := name
	if i := strings.LastIndex(name, "__"); i >= 0 {
		bare = name[i+2:]
	}
	for i := range mcpTools {
		if mcpTools[i].Name == bare {
			return &mcpTools[i]
		}
	}
	return nil
}

// textResult is the MCP CallToolResult shape the docs specify.
func textResult(text string) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
		"isError": false,
	}
}

func errorResult(text string) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
		"isError": true,
	}
}

// jsonResult renders a payload for the model. Facts, not instructions: the
// assistant treats tool output as untrusted data, so a registry-supplied name
// must never read like a directive.
func jsonResult(v any) (map[string]any, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("could not render the result: %w", err)
	}
	return textResult(string(b)), nil
}

// mcpSession builds the session a tool call runs against.
//
// The lifecycle payload is shaped like connection/connect, so this is the same
// path the workbench uses — including the credential fallback, which matters
// because a long-lived assistant session may outlive the host's willingness to
// keep re-sending the secret.
func mcpSession(ctx context.Context, params map[string]any) (*Session, error) {
	lifecycle, ok := params["lifecycle"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("this tool call carried no connection: open the registry connection in DBX first")
	}
	conn, err := parseConnection(lifecycle)
	if err != nil {
		return nil, err
	}
	s, err := buildSession(conn)
	if err != nil {
		return nil, err
	}
	// The same upgrade connection/connect performs. Without it a connection
	// configured as docker-v2 against a server that is really Harbor keeps that
	// label here — and the guards that ask "is this Harbor?" (the retention
	// window, the scanner, project creation) all answer no, while the Harbor
	// client works regardless. A delete that should have been refused then goes
	// through.
	detectHarbor(ctx, s)
	storeSession(s)
	return s, nil
}

// handleMCPTools answers mcp/tools.
func handleMCPTools(_ context.Context, params map[string]any) (any, error) {
	// The host passes the connection being bound. Today every tool works against
	// whatever connection is open, so the value is not needed to filter the list
	// — but it is the hook the docs describe for hiding write tools on a
	// read-only connection, so the parameter is accepted and ignored on purpose.
	_ = strParam(params, "connectionId")
	return map[string]any{"tools": mcpTools}, nil
}

// handleMCPCall answers mcp/call.
func handleMCPCall(ctx context.Context, params map[string]any) (any, error) {
	name := strings.TrimSpace(strParam(params, "tool"))
	if name == "" {
		return errorResult("no tool name was given"), nil
	}
	tool := toolByName(name)
	if tool == nil {
		known := make([]string, 0, len(mcpTools))
		for _, t := range mcpTools {
			known = append(known, t.Name)
		}
		sort.Strings(known)
		return errorResult("unknown tool " + name + "; available: " + strings.Join(known, ", ")), nil
	}

	args, _ := params["arguments"].(map[string]any)
	if args == nil {
		args = map[string]any{}
	}
	// Tool arguments arrive flat; the handlers read through the same param
	// helpers the RPC methods use.
	s, err := mcpSession(ctx, params)
	if err != nil {
		return errorResult(err.Error()), nil
	}

	// A tool failure is reported as an isError result rather than a JSON-RPC
	// error: the model should see what went wrong and be able to try something
	// else, which an RPC-level failure would not let it do.
	res, err := runMCPTool(ctx, s, tool.Name, args)
	if err != nil {
		return errorResult(err.Error()), nil
	}
	return res, nil
}

func runMCPTool(ctx context.Context, s *Session, name string, args map[string]any) (map[string]any, error) {
	switch name {
	case "list_projects":
		return mcpListProjects(ctx, s)
	case "list_repositories":
		return mcpListRepositories(ctx, s, args)
	case "list_tags":
		return mcpListTags(ctx, s, args)
	case "image_info":
		return mcpImageInfo(ctx, s, args)
	case "vulnerabilities":
		return mcpVulnerabilities(ctx, s, args)
	case "create_project":
		return mcpCreateProject(ctx, s, args)
	case "set_project_public":
		return mcpSetProjectPublic(ctx, s, args)
	case "retag":
		return mcpRetag(ctx, s, args)
	case "delete_tag":
		return mcpDeleteTag(ctx, s, args)
	}
	return nil, fmt.Errorf("unknown tool %q", name)
}

// projectArg reads the project every scoped tool needs.
func projectArg(args map[string]any) (string, error) {
	p := strings.TrimSpace(strParam(args, "project"))
	if p == "" {
		return "", fmt.Errorf("`project` is required — call list_projects to see the available names")
	}
	return p, nil
}

func repoArg(args map[string]any) (string, error) {
	r := strings.TrimSpace(strParam(args, "repository"))
	if r == "" {
		return "", fmt.Errorf("`repository` is required — call list_repositories to see the available names")
	}
	// Tolerate a fully-qualified name: the UI passes short names to Harbor's API
	// and full names to /v2/, and a model will produce either.
	if i := strings.LastIndex(r, "/"); i >= 0 {
		r = r[i+1:]
	}
	return r, nil
}
