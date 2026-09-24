#!/usr/bin/env python3
"""End-to-end regression test for `registry/retag` (tag rename).

Runs the packaged sidecar against a throwaway registry that also implements
Harbor's tag-delete endpoint, and asserts on the HTTP requests the sidecar
actually emits — not merely on its response payload. The request sequence is the
whole point of the feature:

    GET  /v2/<repo>/manifests/<old>                     read the source manifest
    PUT  /v2/<repo>/manifests/<new>                     publish under the new tag
    DELETE /api/v2.0/.../artifacts/<new>/tags/<old>     (Harbor only) drop the old tag

Covered:
  A  Harbor  + deleteSource=true   → true rename, old tag dropped via the REST API
  B  OCI v2  + deleteSource=true   → copy only, response carries an honest warning
  C  OCI v2  + deleteSource=false  → copy only, no warning
  D  invalid / empty / identical tags → rejected before any network call

Run:  python tools/test-retag-e2e.py        (exit 0 = all pass)
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
_reporter = _harness.Reporter("retag")
PORT = 5013
REPO = "payments/ledger-api"
OLD, NEW = "2026-09-22_141718", "v1.0.1"

MANIFEST_BODY = json.dumps(
    {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json"}
).encode()


def newest_package() -> pathlib.Path:
    return _harness.find_package()


class Handler(http.server.BaseHTTPRequestHandler):
    log_path: pathlib.Path

    def _record(self) -> None:
        with open(self.log_path, "a", encoding="utf-8") as fh:
            fh.write(f"{self.command} {self.path}\n")

    def do_GET(self):  # noqa: N802
        self._record()
        if self.path.startswith("/v2/") and "/manifests/" in self.path:
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.oci.image.manifest.v1+json")
            self.send_header("Docker-Content-Digest", "sha256:8f2c41ab90de")
            self.end_headers()
            self.wfile.write(MANIFEST_BODY)
        elif self.path.startswith("/v2/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}")
        elif self.path.startswith("/api/v2.0/ping"):
            # Deliberately NOT a Harbor: ping stays 404 so the auto-detection
            # cannot upgrade a docker-v2 connection — the plain-OCI scenarios
            # below test the real copy-only path.
            self.send_response(404)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_PUT(self):  # noqa: N802
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self._record()
        self.send_response(201)
        self.send_header("Docker-Content-Digest", "sha256:8f2c41ab90de")
        self.end_headers()

    def do_DELETE(self):  # noqa: N802
        self._record()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):  # silence the default stderr access log
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class Sidecar:
    """One stdio-jsonl sidecar process; `call` writes a request and reads its reply."""

    def __init__(self, exe: pathlib.Path):
        self.proc = subprocess.Popen(
            [str(exe)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1,
            env=_harness.isolated_env(),
        )
        self.seq = 0

    def call(self, method: str, params: dict) -> dict:
        self.seq += 1
        self.proc.stdin.write(
            json.dumps({"jsonrpc": "2.0", "id": self.seq, "method": method, "params": params}) + "\n"
        )
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("sidecar closed the stream")
        return json.loads(line)

    def connect(self, conn_id: str, registry_type: str) -> None:
        reply = self.call("connection/connect", {
            "connection": {
                "id": conn_id, "name": "IMREPO", "host": "127.0.0.1", "port": PORT,
                "config": {"registry_type": registry_type, "auth_type": "basic", "insecure": True},
                "secret": {},
            },
            "runtime": {"host": "127.0.0.1", "port": PORT},
        })
        assert "error" not in reply, reply

    def retag(self, conn_id, repo, source, target, delete_source) -> dict:
        return self.call("registry/retag", {
            "connectionId": conn_id, "repository": repo,
            "sourceTag": source, "targetTag": target, "deleteSource": delete_source,
        })


def main() -> int:
    exe, _manifest, workdir = _harness.extract_sidecar()
    log_path = workdir / "requests.log"
    Handler.log_path = log_path

    srv = Server(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    check = _reporter.check

    def mark() -> int:
        return len(log_path.read_text(encoding="utf-8").splitlines()) if log_path.exists() else 0

    def since(m: int) -> list[str]:
        lines = log_path.read_text(encoding="utf-8").splitlines() if log_path.exists() else []
        return [ln.strip() for ln in lines[m:]]

    try:
        print("\nA) Harbor + deleteSource=true  → real rename (old tag dropped via REST API)")
        sc = Sidecar(exe)
        sc.connect("h1", "harbor")
        m = mark()
        r = sc.retag("h1", REPO, OLD, NEW, True)
        reqs = since(m)
        print("   response:", json.dumps(r.get("result", r.get("error")), ensure_ascii=False))
        check("ok == true", r.get("result", {}).get("ok") is True)
        check("sourceRemoved == true", r.get("result", {}).get("sourceRemoved") is True)
        check("no warning", "warning" not in r.get("result", {}))
        check(f"read source manifest (GET .../manifests/{OLD})",
              any(f"GET /v2/{REPO}/manifests/{OLD}" in q for q in reqs), reqs)
        check(f"wrote new tag (PUT .../manifests/{NEW})",
              any(f"PUT /v2/{REPO}/manifests/{NEW}" in q for q in reqs), reqs)
        check("dropped old tag through the Harbor API",
              any(f"/api/v2.0/projects/payments/repositories/ledger-api/artifacts/{NEW}/tags/{OLD}" in q
                  for q in reqs), reqs)
        print("   requests:", *[f"\n     {q}" for q in reqs])

        print("\nB) plain OCI v2 + deleteSource=true → old tag kept, reported honestly")
        sc = Sidecar(exe)
        sc.connect("d1", "docker-v2")
        m = mark()
        r = sc.retag("d1", "library/nginx", "1.25", "1.25-pinned", True)
        reqs = since(m)
        print("   response:", json.dumps(r.get("result", r.get("error")), ensure_ascii=False))
        check("new tag written", any("PUT /v2/library/nginx/manifests/1.25-pinned" in q for q in reqs), reqs)
        check("no Harbor tag delete attempted", not any("/api/v2.0/" in q for q in reqs), reqs)
        check("warning says the old tag was kept", "kept" in (r.get("result", {}).get("warning") or ""))

        print("\nC) plain OCI v2 + deleteSource=false → copy only, no warning")
        sc = Sidecar(exe)
        sc.connect("d2", "docker-v2")
        r = sc.retag("d2", "library/redis", "7.2", "7.2-backup", False)
        print("   response:", json.dumps(r.get("result", r.get("error")), ensure_ascii=False))
        check("ok == true", r.get("result", {}).get("ok") is True)
        check("sourceRemoved == false", r.get("result", {}).get("sourceRemoved") is False)
        check("no warning", "warning" not in r.get("result", {}))

        print("\nD) input validation (no registry round-trip expected)")
        for label, source, target in [
            ("invalid tag (space)", "7.2", "bad tag"),
            ("tag starting with '.'", "7.2", ".hidden"),
            ("tag longer than 128 chars", "7.2", "a" * 129),
            ("target equals source", "7.2", "7.2"),
            ("empty target", "7.2", ""),
        ]:
            sc = Sidecar(exe)
            sc.connect("v1", "docker-v2")
            r = sc.retag("v1", "library/redis", source, target, False)
            print(f"   {label}: {json.dumps(r.get('error') or r.get('result'), ensure_ascii=False)[:120]}")
            check(label, "error" in r)
    finally:
        srv.shutdown()
        shutil.rmtree(workdir, ignore_errors=True)

    return _reporter.report()


if __name__ == "__main__":
    raise SystemExit(main())
