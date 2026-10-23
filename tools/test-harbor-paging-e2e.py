#!/usr/bin/env python3
"""End-to-end regression test for Harbor list pagination (issue #3).

Harbor caps `page_size` at 100 and rejects anything larger with 422, so every
list endpoint answers at most 100 rows per request. A client that asks for
`page=1&page_size=100` and stops therefore sees a truncated list, while the
project object's `repo_count` (server-side aggregate) keeps the real number —
which is how the sidebar showed 133 repositories and the overview showed 100.

The fixture reproduces that shape: one project whose `repo_count` is 133 and a
repositories endpoint that pages 100 at a time. A client that follows the pages
must report 133 everywhere the count is shown.

Covered:
  A  repositories — the project listing returns all 133 rows, first to last,
                    not page 1 repeated or silently cut at 100.
  B  project images — repositoryCount is the complete 133 even though the
                    artifact walk stays bounded (truncated).
  C  overview      — the registry-wide repoCount is 133, not 100.
  D  projects      — a 150-project registry lists all of them, not the first
                   100-row page.

Run:  python tools/test-harbor-paging-e2e.py      (exit 0 = all pass)
"""

from __future__ import annotations

import http.server
import json
import pathlib
import socketserver
import subprocess
import sys
import threading
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import _harness  # noqa: E402  (needs the path fix above)

PORT = 5033
PROJECT = "big"
REPO_TOTAL = 133
PAGE_SIZE_CAP = 100

REPOS = [
    {
        "name": f"{PROJECT}/repo-{i:03d}",
        "artifact_count": 0,
        "pull_count": 0,
        "update_time": "2026-09-18T16:54:40Z",
    }
    for i in range(REPO_TOTAL)
]

PROJECT_OBJECT = {
    "project_id": 1,
    "name": PROJECT,
    "public": True,
    "repo_count": REPO_TOTAL,
    "creation_time": "2026-09-01T00:00:00Z",
}

# Scenario D: more projects than one page, each with one repository.
MANY_PROJECTS_TOTAL = 150
MANY_PROJECTS = [
    {
        "project_id": i + 1,
        "name": f"p{i:03d}",
        "public": True,
        "repo_count": 1,
        "creation_time": "2026-09-01T00:00:00Z",
    }
    for i in range(MANY_PROJECTS_TOTAL)
]


def page_of(items: list, path: str) -> tuple[list, int]:
    """Slice `items` the way Harbor does: page starts at 1, size caps at 100."""
    query = urllib.parse.parse_qs(urllib.parse.urlparse(path).query)
    page = max(1, int(query.get("page", ["1"])[0]))
    size = min(PAGE_SIZE_CAP, max(1, int(query.get("page_size", ["100"])[0])))
    start = (page - 1) * size
    return items[start:start + size], len(items)


class Handler(http.server.BaseHTTPRequestHandler):
    # Scenario D flips this to serve a project list longer than one page.
    many_projects = False

    def _send(self, obj, code=200, total=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if total is not None:
            self.send_header("X-Total-Count", str(total))
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, code=404, msg="not found"):
        self._send({"errors": [{"message": msg}]}, code)

    def do_GET(self):  # noqa: N802
        route = urllib.parse.urlparse(self.path).path
        if route == "/api/v2.0/ping":
            return self._send({})
        if route == "/api/v2.0/projects":
            projects = MANY_PROJECTS if self.many_projects else [PROJECT_OBJECT]
            rows, total = page_of(projects, self.path)
            return self._send(rows, total=total)
        if route == f"/api/v2.0/projects/{PROJECT}/repositories":
            rows, total = page_of(REPOS, self.path)
            return self._send(rows, total=total)
        if "/repositories/" in route and route.endswith("/artifacts"):
            # Empty artifact pages keep the overview walk fast; the repository
            # count is what this test asserts.
            return self._send([], total=0)
        if route == "/api/v2.0/audit-logs":
            return self._send([], total=0)
        if route.startswith("/v2/"):
            return self._send({})
        self._fail(404)

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
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.seq, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("sidecar closed the stream")
        return json.loads(line)

    def connect(self, conn_id: str) -> None:
        reply = self.call("connection/connect", {
            "connection": {
                "id": conn_id, "name": "IMREPO", "host": "127.0.0.1", "port": PORT,
                "config": {"registry_type": "harbor", "auth_type": "basic", "insecure": True},
                "secret": {},
            },
            "runtime": {"host": "127.0.0.1", "port": PORT},
        })
        assert "error" not in reply, reply


def main() -> int:
    exe, _manifest, _work = _harness.extract_sidecar()
    reporter = _harness.Reporter("harbor-paging")
    check = reporter.check

    srv = Server(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    try:
        sc = Sidecar(exe)
        sc.connect("h1")

        print("\nA) a 133-repository project lists all of them")
        r = sc.call("harbor/repositories", {"connectionId": "h1", "project": PROJECT})
        repos = r.get("result") or []
        check("the repository listing succeeds", "error" not in r, r)
        check("all 133 repositories are returned", len(repos) == REPO_TOTAL,
              f"got {len(repos)}")
        check("the first repository is big/repo-000",
              bool(repos) and repos[0]["full_name"] == f"{PROJECT}/repo-000",
              repos[:1])
        check("the last repository is big/repo-132",
              bool(repos) and repos[-1]["full_name"] == f"{PROJECT}/repo-132",
              repos[-1:])

        print("\nB) the project image overview counts all 133")
        r = sc.call("harbor/images", {"connectionId": "h1", "project": PROJECT})
        imgs = r.get("result") or {}
        check("the project overview succeeds", "error" not in r, r)
        check("repositoryCount is the complete count, not the page size",
              imgs.get("repositoryCount") == REPO_TOTAL,
              f"got {imgs.get('repositoryCount')}")

        print("\nC) the registry-wide overview counts all 133")
        r = sc.call("harbor/overview", {"connectionId": "h1"})
        ov = r.get("result") or {}
        check("the registry overview succeeds", "error" not in r, r)
        check("repoCount is 133, not the 100-row page",
              ov.get("repoCount") == REPO_TOTAL,
              f"got {ov.get('repoCount')}")
        check("projectCount is 1", ov.get("projectCount") == 1,
              f"got {ov.get('projectCount')}")

        print("\nD) a project list longer than one page is complete too")
        Handler.many_projects = True
        r = sc.call("harbor/projects", {"connectionId": "h1"})
        projects = r.get("result") or []
        check("the project listing succeeds", "error" not in r, r)
        check("all 150 projects are returned", len(projects) == MANY_PROJECTS_TOTAL,
              f"got {len(projects)}")
        check("the first project is p000",
              bool(projects) and projects[0]["name"] == "p000", projects[:1])
        check("the last project is p149",
              bool(projects) and projects[-1]["name"] == "p149", projects[-1:])
    finally:
        srv.shutdown()

    return reporter.report()


if __name__ == "__main__":
    sys.exit(main())
