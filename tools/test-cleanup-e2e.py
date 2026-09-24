#!/usr/bin/env python3
"""End-to-end regression test for untagged-artifact cleanup (PRD 2.4).

Runs the packaged sidecar against a fixture Harbor API and asserts the scan
result, the deletion requests, and — most importantly — the safety rules around
a destructive bulk operation.

Covered:
  A  scan        — only artifacts with no tag are offered; tagged ones are not.
                   IMAGE and CHART count as content, exotic types do not.
  B  cleanup     — deletes exactly the confirmed targets, reports reclaimed bytes.
  C  re-verify   — an artifact that gained a tag between the scan and the
                   confirmation must be SKIPPED, never deleted. This is the whole
                   reason cleanup re-reads every target before deleting.
  D  vanished    — a target that disappeared meanwhile is skipped, not fatal.
  E  batch limit — an oversized request is refused outright.
  F  non-Harbor  — a plain OCI v2 registry gets a clear "needs the Harbor API"
                   error instead of a silent empty result.

Run:  python tools/test-cleanup-e2e.py      (exit 0 = all pass)
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

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import _harness  # noqa: E402  (needs the path fix above)

ROOT = _harness.ROOT
_reporter = _harness.Reporter("cleanup")
PORT = 5031
PROJECT = "payments"

IMG = "sha256:" + "1" * 8 + "_image"
CHART = "sha256:" + "2" * 8 + "_chart"
EXOTIC = "sha256:" + "3" * 8 + "_exotic"
TAGGED = "sha256:" + "4" * 8 + "_tagged"
RETAGGED = "sha256:" + "5" * 8 + "_retagged"
GONE = "sha256:" + "6" * 8 + "_gone"
MISSING = "sha256:" + "7" * 8 + "_never_existed"

# repository -> artifacts. `tags` is omitted where Harbor would omit it.
REPOS: dict[str, list[dict]] = {
    "ledger-api": [
        {"digest": IMG, "type": "IMAGE", "size": 812 * 1024 * 1024, "push_time": "2026-09-18T16:54:40Z"},
        {"digest": TAGGED, "type": "IMAGE", "size": 100, "push_time": "2026-09-18T16:54:40Z",
         "tags": [{"name": "v1.0.0"}]},
    ],
    "charts": [
        {"digest": CHART, "type": "CHART", "size": 2 * 1024 * 1024, "push_time": "2026-09-01T00:00:00Z"},
    ],
    "weird": [
        {"digest": EXOTIC, "type": "CNAB", "size": 5 * 1024 * 1024, "push_time": "2026-09-01T00:00:00Z"},
    ],
    "stale": [
        {"digest": RETAGGED, "type": "IMAGE", "size": 77 * 1024 * 1024, "push_time": "2026-09-02T00:00:00Z"},
        {"digest": GONE, "type": "IMAGE", "size": 9 * 1024 * 1024, "push_time": "2026-09-02T00:00:00Z"},
    ],
}

# Artifacts the fixture pretends to have deleted, and paths hit by DELETE.
DELETED: list[str] = []
DELETE_PATHS: list[str] = []


def artifact(repo: str, ref: str) -> dict | None:
    for a in REPOS.get(repo, []):
        if a["digest"] == ref or any(t["name"] == ref for t in a.get("tags", [])):
            return a
    return None


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, code=404, msg="not found"):
        self._send({"errors": [{"message": msg}]}, code)

    def do_GET(self):  # noqa: N802
        path = self.path
        # Harbor artifact lookup (re-verification before delete)
        if "/artifacts/" in path and "/repositories/" in path:
            repo = path.split("/repositories/", 1)[1].split("/artifacts/", 1)[0]
            ref = path.split("/artifacts/", 1)[1].split("?", 1)[0]
            a = artifact(repo, ref)
            if a is None or a["digest"] in DELETED:
                return self._fail(404, "artifact not found")
            return self._send(a)
        # Harbor artifact listing
        if "/artifacts" in path:
            repo = path.split("/repositories/", 1)[1].split("/artifacts", 1)[0]
            if repo == "stale":            # simulate an unreadable repository
                return self._fail(404, "repository not found")
            items = [a for a in REPOS.get(repo, []) if a["digest"] not in DELETED]
            return self._send(items)
        # Harbor repository listing
        if path.startswith(f"/api/v2.0/projects/{PROJECT}/repositories"):
            out = []
            for name in REPOS:
                out.append({"name": f"{PROJECT}/{name}", "artifact_count": len(REPOS[name]),
                            "pull_count": 3, "update_time": "2026-09-18T16:54:40Z"})
            return self._send(out)
        if path.startswith("/api/v2.0/ping"):
            # Deliberately NOT a Harbor: the ping stays 404 so the auto-detection
            # cannot upgrade a docker-v2 connection — the "plain OCI v2" scenarios
            # below test the real refusal path.
            self.send_response(404)
            self.end_headers()
            return
        if path.startswith("/v2/"):
            return self._send({})
        self._fail(404)

    def do_DELETE(self):  # noqa: N802
        DELETE_PATHS.append(self.path)
        path = self.path
        ref = path.split("/artifacts/", 1)[1].split("?", 1)[0] if "/artifacts/" in path else ""
        DELETED.append(ref)
        self.send_response(200)
        self.end_headers()

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

    def connect(self, conn_id: str, registry_type: str = "harbor") -> None:
        reply = self.call("connection/connect", {
            "connection": {
                "id": conn_id, "name": "IMREPO", "host": "127.0.0.1", "port": PORT,
                "config": {"registry_type": registry_type, "auth_type": "basic", "insecure": True},
                "secret": {},
            },
            "runtime": {"host": "127.0.0.1", "port": PORT},
        })
        assert "error" not in reply, reply


check = _reporter.check


def main() -> int:
    exe, _manifest, work = _harness.extract_sidecar()
    check = _reporter.check

    srv = Server(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    try:
        print("\nA) scan a project for dangling artifacts")
        sc = Sidecar(exe)
        sc.connect("h1")
        r = sc.call("harbor/untagged", {"connectionId": "h1", "project": PROJECT})
        scan = r.get("result") or {}
        items = scan.get("items") or []
        digests = [i["digest"] for i in items]
        print("   items:", json.dumps(items, ensure_ascii=False))
        check("scan succeeded", "error" not in r, r)
        check("untagged IMAGE offered", IMG in digests)
        check("untagged CHART offered", CHART in digests)
        check("tagged artifact NOT offered", TAGGED not in digests)
        check("exotic artifact type NOT offered", EXOTIC not in digests)
        check("scanned/total reported", scan.get("scannedRepositories", 0) >= 1 and scan.get("totalRepositories", 0) >= 1,
              (scan.get("scannedRepositories"), scan.get("totalRepositories")))
        check("reclaimable size summed", scan.get("totalSize") == sum(i["size"] for i in items),
              (scan.get("totalSize"), sum(i["size"] for i in items)))
        errs = scan.get("repositoryErrors") or []
        check("an unreadable repository is reported, not silently skipped",
              any("stale" in e for e in errs), errs)

        print("\nB) cleanup deletes the confirmed targets and reports reclaim")
        got = scan.get("totalSize") or 0
        targets = [{"repository": i["repository"], "reference": i["digest"], "size": i["size"]} for i in items]
        r2 = sc.call("harbor/cleanupUntagged", {"connectionId": "h1", "project": PROJECT, "targets": targets})
        res = r2.get("result") or {}
        print("   result:", json.dumps({k: res.get(k) for k in ("ok", "deletedCount", "reclaimedBytes", "skipped", "failed")}, ensure_ascii=False))
        check("ok", res.get("ok") is True, res)
        check("deleted everything offered", res.get("deletedCount") == len(targets), res.get("deletedCount"))
        check("reclaimedBytes matches", res.get("reclaimedBytes") == got, (res.get("reclaimedBytes"), got))
        check("a DELETE was sent per target", len(DELETE_PATHS) == len(targets), DELETE_PATHS)

        print("\nC) an artifact tagged while the dialog was open must be SKIPPED")
        DELETED.clear()
        DELETE_PATHS.clear()
        # It was dangling at scan time; now a tag points at it.
        for a in REPOS["ledger-api"]:
            if a["digest"] == IMG:
                a["tags"] = [{"name": "rescue"}]
        r3 = sc.call("harbor/cleanupUntagged", {
            "connectionId": "h1", "project": PROJECT,
            "targets": [{"repository": "ledger-api", "reference": IMG, "size": 812 * 1024 * 1024}],
        })
        res3 = r3.get("result") or {}
        print("   result:", json.dumps(res3, ensure_ascii=False))
        check("nothing deleted", res3.get("deletedCount") == 0, res3)
        check("reported as skipped, not failed", len(res3.get("skipped") or []) == 1 and not (res3.get("failed") or []))
        check("no DELETE was sent", DELETE_PATHS == [], DELETE_PATHS)

        print("\nD) a target that vanished meanwhile is skipped, not fatal")
        DELETED.clear()
        DELETE_PATHS.clear()
        r4 = sc.call("harbor/cleanupUntagged", {
            "connectionId": "h1", "project": PROJECT,
            "targets": [{"repository": "stale", "reference": MISSING, "size": 9 * 1024 * 1024},
                        {"repository": "charts", "reference": CHART, "size": 2 * 1024 * 1024}],
        })
        res4 = r4.get("result") or {}
        print("   result:", json.dumps({k: res4.get(k) for k in ("deletedCount", "skipped", "failed")}, ensure_ascii=False))
        check("the existing one was deleted", res4.get("deletedCount") == 1, res4)
        check("the missing one was skipped", len(res4.get("skipped") or []) == 1, res4)
        check("a 404 is not reported as a failure", not (res4.get("failed") or []), res4)

        print("\nE) an oversized batch is refused")
        r5 = sc.call("harbor/cleanupUntagged", {
            "connectionId": "h1", "project": PROJECT,
            "targets": [{"repository": "charts", "reference": CHART, "size": 1}] * 400,
        })
        check("refused with an error", "error" in r5, r5)
        if "error" in r5:
            print("   message:", r5["error"]["message"])

        print("\nF) a plain OCI v2 registry gets a clear error, not an empty result")
        sc2 = Sidecar(exe)
        sc2.connect("d1", "docker-v2")
        r6 = sc2.call("harbor/untagged", {"connectionId": "d1", "project": PROJECT})
        r7 = sc2.call("harbor/cleanupUntagged", {"connectionId": "d1", "project": PROJECT, "targets": []})
        check("scan refused with an explanation", "error" in r6 and "Harbor" in r6["error"]["message"], r6)
        check("cleanup refused too", "error" in r7 and "Harbor" in r7["error"]["message"], r7)
        if "error" in r6:
            print("   message:", r6["error"]["message"])
    finally:
        srv.shutdown()
        shutil.rmtree(work, ignore_errors=True)

    return _reporter.report()


if __name__ == "__main__":
    raise SystemExit(main())
