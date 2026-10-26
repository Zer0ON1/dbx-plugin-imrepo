#!/usr/bin/env python3
"""End-to-end regression test for the audit-log date filter.

The workbench sends calendar days; the sidecar has to turn them into the range
form Harbor's q language understands — op_time=[min~max] — so filtering (and
the X-Total-Count that drives the pager) stays server-side. The picker means a
local day, while Harbor stores op_time in UTC; the sidecar converts.

The fixture runs the sidecar with TZ=UTC so the expected timestamps do not
depend on the machine running the test.

Covered:
  A  project + operation — unchanged q when no dates are given.
  B  both dates          — op_time=[from 00:00:00~to 23:59:59].
  C  from only           — open-ended upper bound.
  D  to only             — open-ended lower bound.
  E  invalid date        — refused with a message naming the field.
  F  from after to       — refused instead of silently returning nothing.
  G  passthrough         — rows and X-Total-Count reach the UI unchanged.

Run:  python tools/test-logs-e2e.py      (exit 0 = all pass)
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

PORT = 5034
PROJECT = "payments"
PROJECT_ID = 7

LOGS = [
    {
        "op_time": "2026-10-20T08:00:00Z",
        "operation": "pull",
        "resource": "payments/ledger-api:v1.0.0",
        "username": "ci-robot",
    },
    {
        "op_time": "2026-10-21T09:30:00Z",
        "operation": "push",
        "resource": "payments/audit-api:v2.1.0",
        "username": "admin",
    },
]

# What the sidecar asked Harbor for, decoded.
LAST: dict = {}


class Handler(http.server.BaseHTTPRequestHandler):
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
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        if route == "/api/v2.0/ping":
            return self._send({})
        if route == f"/api/v2.0/projects/{PROJECT}":
            return self._send({"project_id": PROJECT_ID, "name": PROJECT, "public": True})
        if route == "/api/v2.0/audit-logs":
            query = urllib.parse.parse_qs(parsed.query)
            LAST["q"] = query.get("q", [""])[0]
            LAST["page"] = query.get("page", [""])[0]
            LAST["pageSize"] = query.get("page_size", [""])[0]
            return self._send(LOGS, total=len(LOGS))
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
        # TZ=UTC makes the sidecar's local-day → UTC conversion deterministic.
        env = dict(_harness.isolated_env(), TZ="UTC")
        self.proc = subprocess.Popen(
            [str(exe)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1,
            env=env,
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
    reporter = _harness.Reporter("logs")
    check = reporter.check

    srv = Server(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    try:
        sc = Sidecar(exe)
        sc.connect("h1")
        base = {"connectionId": "h1", "project": PROJECT, "operation": "pull"}

        print("\nA) no dates keeps the existing filters untouched")
        r = sc.call("harbor/logs", dict(base))
        check("the call succeeds", "error" not in r, r)
        check("q is project + operation only",
              LAST.get("q") == f"project_id={PROJECT_ID},operation=pull", LAST.get("q"))

        print("\nB) both dates become an op_time range")
        r = sc.call("harbor/logs", dict(base, **{"from": "2026-10-01", "to": "2026-10-26"}))
        check("the call succeeds", "error" not in r, r)
        check("q carries the inclusive day range",
              LAST.get("q") == (f"project_id={PROJECT_ID},operation=pull,"
                                "op_time=[2026-10-01 00:00:00~2026-10-26 23:59:59]"),
              LAST.get("q"))

        print("\nC) a start date alone opens the upper bound")
        r = sc.call("harbor/logs", dict(base, **{"from": "2026-10-01"}))
        check("the call succeeds", "error" not in r, r)
        check("q opens the upper bound",
              LAST.get("q", "").endswith("op_time=[2026-10-01 00:00:00~2999-12-31 23:59:59]"),
              LAST.get("q"))

        print("\nD) an end date alone opens the lower bound")
        r = sc.call("harbor/logs", dict(base, **{"to": "2026-10-26"}))
        check("the call succeeds", "error" not in r, r)
        check("q opens the lower bound",
              LAST.get("q", "").endswith("op_time=[1970-01-01 00:00:00~2026-10-26 23:59:59]"),
              LAST.get("q"))

        print("\nE) an invalid date is refused")
        r = sc.call("harbor/logs", dict(base, **{"from": "10/01/2026"}))
        check("the call fails", "error" in r, r)
        check("the message names the field",
              "from" in str((r.get("error") or {}).get("message", "")),
              r.get("error"))

        print("\nF) a reversed range is refused")
        r = sc.call("harbor/logs", dict(base, **{"from": "2026-10-26", "to": "2026-10-01"}))
        check("the call fails", "error" in r, r)
        check("the message explains the order",
              "after" in str((r.get("error") or {}).get("message", "")),
              r.get("error"))

        print("\nG) rows, total and paging pass through")
        r = sc.call("harbor/logs", dict(base, page=2, pageSize=20))
        out = r.get("result") or {}
        check("the call succeeds", "error" not in r, r)
        check("every row reaches the UI", len(out.get("logs") or []) == len(LOGS),
              out.get("logs"))
        check("Harbor's X-Total-Count is the total", out.get("total") == len(LOGS),
              out.get("total"))
        check("the page and size are echoed", out.get("page") == 2 and out.get("pageSize") == 20,
              (out.get("page"), out.get("pageSize")))
        check("the request carried the page parameters",
              LAST.get("page") == "2" and LAST.get("pageSize") == "20",
              (LAST.get("page"), LAST.get("pageSize")))
    finally:
        srv.shutdown()

    return reporter.report()


if __name__ == "__main__":
    sys.exit(main())
