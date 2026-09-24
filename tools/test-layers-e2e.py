#!/usr/bin/env python3
"""End-to-end regression test for `registry/layers` (per-layer size breakdown).

Runs the packaged sidecar against a fixture registry that serves the same shape
real images have — tag → index → child manifest → config blob — and asserts the
parsed per-layer sizes, commands and total.

Why the index cases matter: BuildKit pushes *attestation* entries next to the
images, declaring platform "unknown/unknown". Picking one yields an "image" whose
layer list is meaningless, which looks exactly like "the feature does not work".
`rankIndexEntries` must therefore prefer a real platform and skip entries that
turn out not to be images.

Covered:
  A  index with linux/amd64 + arm64            → amd64 image, exact sizes/total
  B  attestation entry listed FIRST            → still resolves the amd64 image
  C  arm64-only index, attestation first       → resolves arm64 (not the attestation)
  D  index entry that 404s                     → other entries still tried
  E  single manifest, no index                 → works
  F  manifest with no layers                   → empty list + 0 total, not an error

Run:  python tools/test-layers-e2e.py        (exit 0 = all pass)
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
_reporter = _harness.Reporter("layers")
PORT = 5022
REPO = "payments/ledger-api"

CFG = "sha256:" + "c" * 64
AMD = "sha256:" + "1" * 64
ARM = "sha256:" + "2" * 64
ATT = "sha256:" + "3" * 64
GONE = "sha256:" + "4" * 64
BARE = "sha256:" + "5" * 64

SIZES = [78_346_240, 43_127_808, 251_658_240, 4_096, 0]
DIGESTS = ["sha256:" + chr(ord("a") + i) * 64 for i in range(len(SIZES))]
CMDS = [
    "ADD ubuntu-jammy.tar.gz / # buildkit",
    "RUN /bin/sh -c apt-get update && apt-get install -y ca-certificates",
    "COPY /workspace/out/ledger-api /app/bin/app",
    "ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64",
    'ENTRYPOINT ["/app/bin/app"]',
]

CONFIG = {"architecture": "amd64", "os": "linux", "history": [{"created_by": c} for c in CMDS]}


def image_manifest() -> dict:
    return {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": CFG, "size": 900},
        "layers": [
            {"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": DIGESTS[i], "size": SIZES[i]}
            for i in range(len(SIZES))
        ],
    }


# An attestation: has a config and one tiny layer, so only the platform tells it apart.
ATTESTATION = {
    "schemaVersion": 2,
    "mediaType": "application/vnd.oci.image.manifest.v1+json",
    "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": CFG, "size": 167},
    "layers": [{"mediaType": "application/vnd.in-toto+json", "digest": "sha256:" + "e" * 64, "size": 1434}],
}


def entry(digest: str, os_name: str, arch: str) -> dict:
    return {
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "digest": digest,
        "size": 1234,
        "platform": {"os": os_name, "architecture": arch},
    }


SCENARIOS: dict[str, dict] = {
    "alpha": {
        "index": [entry(AMD, "linux", "amd64"), entry(ARM, "linux", "arm64")],
        "manifest": {AMD: image_manifest(), ARM: image_manifest()},
    },
    "bravo": {
        # attestation first — the classic BuildKit layout
        "index": [entry(ATT, "unknown", "unknown"), entry(AMD, "linux", "amd64"), entry(ARM, "linux", "arm64")],
        "manifest": {ATT: ATTESTATION, AMD: image_manifest(), ARM: image_manifest()},
    },
    "charlie": {
        # no amd64 at all: must fall back to a real platform, not the attestation
        "index": [entry(ATT, "unknown", "unknown"), entry(ARM, "linux", "arm64")],
        "manifest": {ATT: ATTESTATION, ARM: image_manifest()},
    },
    "delta": {
        # first (valid-looking) entry is missing from the registry
        "index": [entry(GONE, "linux", "amd64"), entry(ARM, "linux", "arm64")],
        "manifest": {ARM: image_manifest()},
    },
    "echo": {"direct": image_manifest()},          # tag points straight at a manifest
    "foxtrot": {
        "direct": {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                   "config": {"digest": CFG, "size": 2}, "layers": []},
    },
    "golf": {                                     # nothing resolvable at all
        "index": [entry(GONE, "linux", "amd64")],
        "manifest": {},
    },
}


class Handler(http.server.BaseHTTPRequestHandler):
    fixture = SCENARIOS["alpha"]

    def _send(self, obj, ctype="application/json", digest=None):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if digest:
            self.send_header("Docker-Content-Digest", digest)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        p = self.path
        if p.startswith("/v2/") and "/manifests/" in p:
            ref = p.rsplit("/manifests/", 1)[1]
            fx = Handler.fixture
            if fx.get("direct") is not None and ref == "tag":
                self._send(fx["direct"], "application/vnd.oci.image.manifest.v1+json", AMD)
            elif ref == "tag" and "index" in fx:
                self._send({"schemaVersion": 2,
                            "mediaType": "application/vnd.oci.image.index.v1+json",
                            "manifests": fx["index"]},
                           "application/vnd.oci.image.index.v1+json", "sha256:" + "0" * 64)
            elif ref in fx.get("manifest", {}):
                self._send(fx["manifest"][ref], "application/vnd.oci.image.manifest.v1+json", ref)
            else:
                self.send_response(404)
                self.end_headers()
        elif p.startswith("/v2/") and "/blobs/" in p:
            if CFG in p:
                self._send(CONFIG, "application/vnd.oci.image.config.v1+json")
            else:
                self.send_response(404)
                self.end_headers()
        elif p.startswith("/v2/"):
            self._send({})
        else:
            self.send_response(404)
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

    def call(self, method, params) -> dict:
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

    def layers(self, conn_id: str, ref: str = "tag") -> dict:
        return self.call("registry/layers", {"connectionId": conn_id, "repository": REPO, "reference": ref})


def main() -> int:
    exe, _manifest, work = _harness.extract_sidecar()
    check = _reporter.check

    srv = Server(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def run(name: str) -> tuple[dict, dict]:
        Handler.fixture = SCENARIOS[name]
        sc = Sidecar(exe)
        sc.connect("c1")
        r = sc.layers("c1")
        return r, r.get("result") or {}

    try:
        print("\nA) index with linux/amd64 + arm64 → amd64 image with exact sizes")
        r, res = run("alpha")
        check("resolved", "error" not in r, r)
        check("platform = linux/amd64", res.get("platform", {}).get("architecture") == "amd64", res.get("platform"))
        check("layer count = 5", len(res.get("layers") or []) == len(SIZES))
        check("per-layer sizes exact",
              [l.get("size") for l in res.get("layers") or []] == SIZES,
              [l.get("size") for l in res.get("layers") or []])
        check("totalSize exact", res.get("totalSize") == sum(SIZES), res.get("totalSize"))
        check("Dockerfile commands mapped in order",
              [l.get("command") for l in res.get("layers") or []] == CMDS)
        check("indexes are 1-based", [l.get("index") for l in res.get("layers") or []] == [1, 2, 3, 4, 5])
        for l in res.get("layers") or []:
            print(f"     #{l['index']}  {l['size']:>10,} B  {l['command'][:48]}")

        print("\nB) attestation entry FIRST → must still resolve the real amd64 image")
        r, res = run("bravo")
        check("resolved", "error" not in r, r)
        check("not the attestation (layer count = 5)", len(res.get("layers") or []) == len(SIZES),
              f"got {len(res.get('layers') or [])} layer(s)")
        check("platform = linux/amd64", res.get("platform", {}).get("architecture") == "amd64", res.get("platform"))
        check("totalSize exact", res.get("totalSize") == sum(SIZES), res.get("totalSize"))

        print("\nC) arm64-only index (attestation first) → falls back to a real platform")
        r, res = run("charlie")
        check("resolved", "error" not in r, r)
        check("not the attestation (layer count = 5)", len(res.get("layers") or []) == len(SIZES),
              f"got {len(res.get('layers') or [])} layer(s)")
        check("platform = linux/arm64", res.get("platform", {}).get("architecture") == "arm64", res.get("platform"))

        print("\nD) index entry that 404s → remaining entries still tried")
        r, res = run("delta")
        check("resolved from the working entry", "error" not in r and len(res.get("layers") or []) == len(SIZES), r)
        check("platform = linux/arm64", res.get("platform", {}).get("architecture") == "arm64", res.get("platform"))

        print("\nE) tag points straight at a manifest (no index)")
        r, res = run("echo")
        check("resolved", "error" not in r, r)
        check("layer count = 5", len(res.get("layers") or []) == len(SIZES))
        check("totalSize exact", res.get("totalSize") == sum(SIZES))

        print("\nF) manifest with no layers → empty breakdown, not an error")
        r, res = run("foxtrot")
        check("no error", "error" not in r, r)
        check("layers == []", res.get("layers") == [], res.get("layers"))
        check("totalSize == 0", res.get("totalSize") == 0, res.get("totalSize"))

        print("\nG) nothing resolvable → clear error (not a silent empty view)")
        r, res = run("golf")
        check("returned an error", "error" in r, r)
        if "error" in r:
            print("     message:", r["error"]["message"])
    finally:
        srv.shutdown()
        shutil.rmtree(work, ignore_errors=True)

    return _reporter.report()


if __name__ == "__main__":
    raise SystemExit(main())
