#!/usr/bin/env python3
"""End-to-end test for the tools DBX's assistant calls.

Drives the packaged sidecar's two MCP methods against a fixture Harbor and
asserts both halves of what matters: that the tools work, and that they cannot
be used to get around the plugin's own rules.

That second half is the point. The host shows the user the arguments and asks
before running anything without `readOnlyHint`, and the docs say plainly that
this "cannot replace the plugin's own safety rules" — a model that talks a user
into approving a delete must still not be able to remove a tag the retention
policy protects.

Covered:
  A  discovery — mcp/tools returns the declared tools in the portable schema
                 shape, with readOnlyHint on the reads and on nothing else.
  B  reads     — the five read tools answer against Harbor, and their output is
                 JSON the model can use (facts, not prose).
  C  limits    — list_tags honours `limit` and reports the true total.
  D  writes    — create_project / set_project_public / retag / delete_tag reach
                 the API with the right requests.
  E  refusals  — a protected tag cannot be deleted, and a tag cannot be renamed
                 away from under the policy, through this path either. Asserted
                 on the requests, not just the return value: the delete must not
                 be sent at all.
  F  errors    — an unknown tool and a call with no connection are reported as
                 isError results the model can read and recover from.

Run:  python tools/test-mcp-e2e.py      (exit 0 = all pass)
"""

from __future__ import annotations

import http.server
import json
import pathlib
import shutil
import socketserver
import subprocess
import sys
import threading
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import _harness  # noqa: E402  (needs the path fix above)

ROOT = _harness.ROOT
_reporter = _harness.Reporter("mcp")
check = _reporter.check
PORT = 5041
PROJECT = "payments"
CONN = "mcp-conn"

DIGEST_NEW = "sha256:" + "a" * 8 + "_new"
DIGEST_OLD = "sha256:" + "b" * 8 + "_old"

REQUESTS: list[tuple[str, str]] = []
DELETES: list[str] = []

# One repository with two tags; `latest` is protected by the retention policy
# the fixture reports, `v1` is not.
ARTIFACTS = [
    {"digest": DIGEST_NEW, "type": "IMAGE", "size": 300 * 1024 * 1024,
     "push_time": "2026-09-20T10:00:00Z", "platform": None, "references": [],
     "tags": [{"name": "latest", "push_time": "2026-09-20T10:00:00Z"}]},
    {"digest": DIGEST_OLD, "type": "IMAGE", "size": 100 * 1024 * 1024,
     "push_time": "2026-09-01T10:00:00Z", "platform": None, "references": [],
     "tags": [{"name": "v1", "push_time": "2026-09-01T10:00:00Z"}]},
]

MANIFEST_BODY = json.dumps({
    "schemaVersion": 2,
    "mediaType": "application/vnd.oci.image.manifest.v1+json",
    "config": {"digest": "sha256:" + "c" * 64, "mediaType": "application/vnd.oci.image.config.v1+json"},
    "layers": [{"digest": "sha256:" + "d" * 64,
                "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "size": 12345678}],
}).encode()

CONFIG_BODY = json.dumps({
    "architecture": "amd64", "os": "linux",
    "history": [{"created_by": "RUN /bin/sh -c echo hi"}],
}).encode()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, code=404, msg="not found"):
        self._send({"errors": [{"message": msg}]}, code)

    def _body(self) -> dict:
        n = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(n).decode()) if n else {}

    def do_GET(self):  # noqa: N802
        REQUESTS.append(("GET", self.path))
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.endswith("/ping"):
            return self._send("Pong")
        if path.endswith("/users/current"):
            return self._send({"user_id": 1, "username": "admin", "sysadmin_flag": True})
        if path.endswith("/configurations"):
            return self._send({})
        if path == "/api/v2.0/projects":
            return self._send([{"project_id": 7, "name": PROJECT, "repo_count": 4, "public": False,
                                "creation_time": "2026-01-01T00:00:00Z"}])
        if path.endswith(f"/projects/{PROJECT}"):
            return self._send({"project_id": 7, "name": PROJECT, "public": False,
                               "metadata": {"public": "false"}, "repo_count": 4})
        if path.endswith(f"/projects/{PROJECT}/repositories"):
            return self._send([{"name": f"{PROJECT}/ledger-api", "artifact_count": 2,
                                "pull_count": 9, "update_time": "2026-09-20T10:00:00Z"}])
        # Vulnerability reports live under /artifacts/<ref>/additions/..., so this
        # has to be matched BEFORE the plain artifacts listing — the opposite
        # order serves the artifact list to a vulnerability request.
        if "/additions/vulnerabilities" in path:
            return self._send({"application/vnd.security.vulnerability.report; version=1.1": {
                "generated_at": "2026-09-21T00:00:00Z", "scanner": {"name": "Trivy", "version": "0.50"},
                "severity": "High",
                "vulnerabilities": [{"id": "CVE-2024-1", "severity": "High", "package": "openssl",
                                     "version": "1.1", "fixed_version": "1.2"}],
            }})
        if "/artifacts" in path:
            return self._send(ARTIFACTS)
        if path.startswith("/v2/") and "/manifests/" in path:
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.oci.image.manifest.v1+json")
            self.send_header("Docker-Content-Digest", DIGEST_NEW)
            self.send_header("Content-Length", str(len(MANIFEST_BODY)))
            self.end_headers()
            self.wfile.write(MANIFEST_BODY)
            return
        if path.startswith("/v2/") and "/blobs/" in path:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(CONFIG_BODY)))
            self.end_headers()
            self.wfile.write(CONFIG_BODY)
            return
        return self._fail(404)

    def do_POST(self):  # noqa: N802
        REQUESTS.append(("POST", self.path))
        body = self._body()
        if self.path.endswith("/scan"):
            return self._send({}, 202)
        if self.path == "/api/v2.0/projects":
            return self._send({"project_id": 9}, 201)
        return self._send({}, 201)

    def do_PUT(self):  # noqa: N802
        REQUESTS.append(("PUT", self.path))
        # Drain the body: a PUT here carries the manifest, and leaving it in the
        # socket makes the NEXT request line parse as garbage — which is what the
        # sidecar then reports, accurately, as a 400 from the server.
        self._body()
        return self._send({}, 200)

    def do_DELETE(self):  # noqa: N802
        REQUESTS.append(("DELETE", self.path))
        DELETES.append(self.path)
        # Drain the body even though this handler ignores it: leaving unread
        # bytes in the socket desynchronises the next request on a keep-alive
        # connection, which surfaces as an unrelated 400 later.
        self._body()
        return self._send({}, 200)

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class Sidecar:
    def __init__(self, exe: pathlib.Path):
        self.proc = subprocess.Popen(
            [str(exe)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1,
            env=_harness.isolated_env(),
        )
        self.seq = 0

    def call(self, method: str, params: dict) -> dict:
        self.seq += 1
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.seq,
                                          "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("sidecar closed the stream")
        return json.loads(line)

    def result(self, method: str, params: dict) -> dict:
        reply = self.call(method, params)
        if "error" in reply:
            raise AssertionError(f"{method} failed: {reply['error']}")
        return reply.get("result") or {}

    def lifecycle(self) -> dict:
        """The payload the host attaches to a tool call — same as connect."""
        return {
            "connection": {
                "id": CONN, "name": "IMREPO", "host": "127.0.0.1", "port": PORT,
                "username": "admin",
                "config": {"registry_type": "harbor", "auth_type": "basic", "insecure": True},
                "secret": {"password": "fixture-pass"},
            },
            "runtime": {"host": "127.0.0.1", "port": PORT},
        }

    def tool(self, name: str, **args) -> dict:
        """Call one tool; returns the CallToolResult body."""
        return self.result("mcp/call", {"tool": name, "arguments": args,
                                        "lifecycle": self.lifecycle()})

    def text(self, name: str, **args) -> str:
        res = self.tool(name, **args)
        parts = res.get("content") or []
        return "\n".join(p.get("text", "") for p in parts)

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def main() -> int:
    exe, _manifest, work = _harness.extract_sidecar()
    srv = Server(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    sc = Sidecar(exe)

    def as_json(name: str, **args):
        return json.loads(sc.text(name, **args))

    try:
        print("\nA) mcp/tools declares the surface")
        tools = sc.result("mcp/tools", {"connectionId": CONN}).get("tools") or []
        names = [t["name"] for t in tools]
        check("the nine tools are declared", len(tools) == 9, names)
        check("reads come first",
              names[:5] == ["list_projects", "list_repositories", "list_tags", "image_info", "vulnerabilities"],
              names)
        readonly = {t["name"] for t in tools if (t.get("annotations") or {}).get("readOnlyHint")}
        check("the five reads are marked readOnlyHint",
              readonly == {"list_projects", "list_repositories", "list_tags", "image_info", "vulnerabilities"},
              readonly)
        check("no write tool carries readOnlyHint",
              not readonly & {"create_project", "set_project_public", "retag", "delete_tag"}, readonly)
        check("every schema is an object with properties",
              all(t["inputSchema"].get("type") == "object" and "properties" in t["inputSchema"] for t in tools))
        info_tool = next(t for t in tools if t["name"] == "image_info")
        check("required arguments are declared",
              set(info_tool["inputSchema"].get("required") or []) == {"project", "repository", "reference"},
              info_tool["inputSchema"].get("required"))
        check("parameter names stay inside [A-Za-z0-9_]",
              all(all(p.replace("_", "").isalnum() for p in t["inputSchema"]["properties"]) for t in tools))

        print("\nB) the read tools answer with usable JSON")
        projects = as_json("list_projects")
        check("list_projects names the registry type",
              projects.get("type") == "harbor" and projects["projects"][0]["project"] == PROJECT, projects)
        repos = as_json("list_repositories", project=PROJECT)
        check("list_repositories returns the repositories",
              repos["repositories"][0]["repository"] == "ledger-api", repos)
        tags = as_json("list_tags", project=PROJECT, repository="ledger-api")
        check("list_tags returns newest first",
              [t["tag"] for t in tags["tags"]] == ["latest", "v1"], tags["tags"])
        check("...with digest, size and push time",
              tags["tags"][0]["digest"] == DIGEST_NEW and tags["tags"][0]["sizeBytes"] == 300 * 1024 * 1024,
              tags["tags"][0])
        info = as_json("image_info", project=PROJECT, repository="ledger-api", reference="latest")
        check("image_info describes the image",
              info["layers"] == 1 and info["platform"]["architecture"] == "amd64"
              and info["totalSize"] == 12345678, info)
        vulns = as_json("vulnerabilities", project=PROJECT, repository="ledger-api", reference="latest")
        check("vulnerabilities returns the report",
              (vulns.get("counts") or {}).get("High") == 1, vulns)

        print("\nC) list_tags honours the limit")
        many = as_json("list_tags", project=PROJECT, repository="ledger-api", limit=1)
        check("only the requested number is returned", len(many["tags"]) == 1, many)
        check("...and the true total is reported", many["total"] == 2, many)
        check("...with a note explaining the truncation", "note" in many, many)

        print("\nD) the write tools reach the API")
        DELETES.clear(); REQUESTS.clear()
        created = as_json("create_project", project="newproj", public=True)
        check("create_project posts to /projects",
              any(m == "POST" and p == "/api/v2.0/projects" for m, p in REQUESTS), REQUESTS)
        check("...and reports success", created.get("ok") is not False, created)
        REQUESTS.clear()
        as_json("set_project_public", project=PROJECT, public=True)
        check("set_project_public PUTs the project",
              any(m == "PUT" and p.endswith(f"/projects/{PROJECT}") for m, p in REQUESTS), REQUESTS)
        REQUESTS.clear()
        renamed = as_json("retag", project=PROJECT, repository="ledger-api",
                          source_tag="v1", target_tag="v1.1")
        put = [p for m, p in REQUESTS if m == "PUT" and "/manifests/v1.1" in p]
        check("retag writes the manifest under the new tag", bool(put), REQUESTS)
        check("...and removes the old one", renamed.get("sourceRemoved") is True, renamed)

        print("\nE) the plugin's own rules still hold through this path")
        DELETES.clear(); REQUESTS.clear()
        latest = sc.tool("delete_tag", project=PROJECT, repository="ledger-api", tag="latest")
        check("deleting a policy-protected tag is refused",
              latest.get("isError") is True, latest)
        check("...the refusal explains which rule blocked it",
              "protect" in sc.text("delete_tag", project=PROJECT, repository="ledger-api", tag="latest").lower(),
              sc.text("delete_tag", project=PROJECT, repository="ledger-api", tag="latest"))
        check("...and no DELETE is sent at all",
              not DELETES, f"the plugin sent: {DELETES}")
        sc.tool("retag", project=PROJECT, repository="ledger-api",
                source_tag="latest", target_tag="latest-2")
        check("a rename cannot move a protected tag out of the way either",
              not [d for d in DELETES if d.endswith("/latest")], DELETES)

        DELETES.clear()
        gone = as_json("delete_tag", project=PROJECT, repository="ledger-api", tag="v1")
        check("an unprotected tag deletes normally", gone.get("ok") is True, gone)
        check("...with a DELETE for that tag", any(d.endswith("/tags/v1") for d in DELETES), DELETES)

        print("\nF) failures are readable, not fatal")
        unknown = sc.tool("no_such_tool", project=PROJECT)
        check("an unknown tool is an isError result", unknown.get("isError") is True, unknown)
        check("...that lists what does exist", "list_projects" in sc.text("no_such_tool"),
              sc.text("no_such_tool"))
        noconn = sc.result("mcp/call", {"tool": "list_projects", "arguments": {}})
        check("a call with no connection is an isError result", noconn.get("isError") is True, noconn)
        check("...that says what to do", "connection" in json.dumps(noconn).lower(), noconn)
        missing = sc.tool("list_repositories")
        check("a missing required argument explains itself",
              missing.get("isError") is True and "project" in json.dumps(missing), missing)

        sc.close()
    finally:
        srv.shutdown()
        shutil.rmtree(work, ignore_errors=True)

    return _reporter.report()


if __name__ == "__main__":
    raise SystemExit(main())
