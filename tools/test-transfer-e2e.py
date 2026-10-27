#!/usr/bin/env python3
"""End-to-end test for image-archive upload and export (.tar / .tar.gz).

Runs the packaged sidecar against a throwaway OCI distribution server and drives
the same JSON-RPC methods the workbench uses:

    transfer/uploadBegin → uploadChunk* → uploadEnd → uploadStatus
    transfer/uploadPush → uploadStatus*
    transfer/exportPlan → exportBegin → exportStatus* → exportChunk* → exportClose

Covered:
  A  docker save archive (.tar)      → inspect, push config/layers/manifest
  B  docker save archive (.tar.gz)   → same, through the gzip path
  C  chunked upload fallback         → a registry that refuses monolithic PUT
  D  OCI image layout (multi-arch)   → child manifests pushed by digest, index by tag
  E  repository/tag validation       → rejected before any push
  F  docker export, platform choice  → correct config/layer, docker-load shape
  G  docker export, .tar.gz          → gzip wrapper is valid
  H  OCI export, all platforms       → layout/index/blobs are a complete OCI archive
  I  OCI export, one platform        → index points at the selected child only

Run:  python tools/test-transfer-e2e.py      (exit 0 = all pass)
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import http.server
import io
import json
import pathlib
import shutil
import socketserver
import subprocess
import sys
import tarfile
import threading
import time
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import _harness  # noqa: E402  (needs the path fix above)

_reporter = _harness.Reporter("transfer")
PORT = 5044
REGISTRY_HOST = "127.0.0.1"

BLOBS = {}
MANIFESTS = {}
UPLOADS = {}
LOG = []
LOCK = threading.Lock()
REQUIRE_AUTH = False


def sha(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def gz(data: bytes) -> bytes:
    """gzip.compress(mtime=...) is 3.8+; the verification box runs Python 3.7."""
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as fh:
        fh.write(data)
    return buf.getvalue()


def digest_hex(digest: str) -> str:
    return digest.split(":", 1)[1]


def tar_bytes(entries: list[tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for name, data in entries:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mtime = 0
            info.mode = 0o644
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def make_config(arch: str = "amd64", os_name: str = "linux", diff_id: str = "") -> bytes:
    return json.dumps({
        "architecture": arch,
        "os": os_name,
        "rootfs": {"type": "layers", "diff_ids": [diff_id]},
        "history": [{"created_by": "test"}],
    }, separators=(",", ":")).encode()


def docker_archive(arch: str = "amd64", compressed: bool = False) -> tuple[bytes, dict]:
    layer_tar = tar_bytes([("hello.txt", f"hello from {arch}\n".encode())])
    layer_blob = gz(layer_tar)
    diff_id = sha(layer_tar)
    config = make_config(arch, "linux", diff_id)
    cfg_digest = sha(config)
    layer_digest = sha(layer_blob)
    manifest = json.dumps([{
        "Config": f"{digest_hex(cfg_digest)}.json",
        "RepoTags": [f"source.example.com/archive/ledger-api:{arch}"],
        "Layers": [f"{digest_hex(layer_digest)}/layer.tar"],
    }], separators=(",", ":")).encode()
    archive = tar_bytes([
        ("manifest.json", manifest),
        (f"{digest_hex(cfg_digest)}.json", config),
        (f"{digest_hex(layer_digest)}/layer.tar", layer_blob),
    ])
    if compressed:
        archive = gz(archive)
    return archive, {
        "config": config, "config_digest": cfg_digest,
        "layer": layer_blob, "layer_digest": layer_digest,
        "layer_uncompressed": layer_tar,
    }


def oci_archive(multi: bool = True) -> tuple[bytes, dict]:
    """An OCI layout with one image manifest (or an index of two platforms)."""
    children = []
    fixtures = {}
    for arch in (("amd64", "arm64") if multi else ("amd64",)):
        layer = gz(tar_bytes([("arch.txt", arch.encode())]))
        layer_digest = sha(layer)
        config = make_config(arch, "linux", sha(tar_bytes([("arch.txt", arch.encode())])))
        cfg_digest = sha(config)
        manifest = json.dumps({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {"mediaType": "application/vnd.oci.image.config.v1+json",
                       "digest": cfg_digest, "size": len(config)},
            "layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                        "digest": layer_digest, "size": len(layer)}],
        }, separators=(",", ":")).encode()
        manifest_digest = sha(manifest)
        fixtures[arch] = {"manifest": manifest, "manifest_digest": manifest_digest,
                          "config": config, "config_digest": cfg_digest,
                          "layer": layer, "layer_digest": layer_digest}
        children.append({
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "digest": manifest_digest, "size": len(manifest),
            "platform": {"os": "linux", "architecture": arch},
        })

    if multi:
        top = json.dumps({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": children,
        }, separators=(",", ":")).encode()
        top_digest = sha(top)
        top_media_type = "application/vnd.oci.image.index.v1+json"
    else:
        top = fixtures["amd64"]["manifest"]
        top_digest = fixtures["amd64"]["manifest_digest"]
        top_media_type = "application/vnd.oci.image.manifest.v1+json"

    index = json.dumps({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [{
            "mediaType": top_media_type, "digest": top_digest, "size": len(top),
            "annotations": {"org.opencontainers.image.ref.name": "v1"},
        }],
    }, separators=(",", ":")).encode()

    entries = [("oci-layout", b'{"imageLayoutVersion":"1.0.0"}'), ("index.json", index)]
    blobs: dict[str, bytes] = {top_digest: top}
    for fx in fixtures.values():
        blobs[fx["manifest_digest"]] = fx["manifest"]
        blobs[fx["config_digest"]] = fx["config"]
        blobs[fx["layer_digest"]] = fx["layer"]
    for digest, data in blobs.items():
        entries.append((f"blobs/sha256/{digest_hex(digest)}", data))
    return tar_bytes(entries), {"fixtures": fixtures, "top": top,
                                "top_digest": top_digest, "top_media_type": top_media_type}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _record(self):
        with LOCK:
            LOG.append(f"{self.command} {self.path}")

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _auth_ok(self) -> bool:
        if not REQUIRE_AUTH or self.path.startswith("/token"):
            return True
        if self.headers.get("Authorization") == "Bearer test-token":
            return True
        challenge = f'Bearer realm="http://{REGISTRY_HOST}:{PORT}/token",service="fake"'
        self._send(401, b"unauthorized", {"WWW-Authenticate": challenge})
        return False

    def _send(self, code: int, body: bytes = b"", headers: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _split_repo(self, path: str, marker: str) -> tuple[str, str] | None:
        prefix = "/v2/"
        if not path.startswith(prefix) or marker not in path:
            return None
        rest = path[len(prefix):]
        repo, tail = rest.split(marker, 1)
        return repo, tail

    def do_GET(self):  # noqa: N802
        self._record()
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/token":
            self._send(200, json.dumps({"token": "test-token"}).encode(),
                       {"Content-Type": "application/json"})
            return
        if not self._auth_ok():
            return
        if parsed.path == "/v2/":
            self._send(200, b"{}", {"Content-Type": "application/json"})
            return
        if parsed.path.startswith("/api/v2.0/ping"):
            self._send(404)
            return
        blob = self._split_repo(parsed.path, "/blobs/")
        if blob:
            repo, digest = blob
            body = BLOBS.get(digest)
            if body is None:
                self._send(404, b"no such blob")
            else:
                self._send(200, body, {"Content-Type": "application/octet-stream",
                                       "Docker-Content-Digest": digest})
            return
        manifest = self._split_repo(parsed.path, "/manifests/")
        if manifest:
            repo, ref = manifest
            with LOCK:
                found = MANIFESTS.get((repo, ref))
            if found is None:
                with LOCK:
                    known = sorted(k[1] for k in MANIFESTS if k[0] == repo)
                self._send(404, ("no such manifest; known: " + ", ".join(known)).encode())
            else:
                body, media_type = found
                self._send(200, body, {"Content-Type": media_type,
                                       "Docker-Content-Digest": sha(body)})
            return
        self._send(404)

    def do_HEAD(self):  # noqa: N802
        self._record()
        if not self._auth_ok():
            return
        parsed = urllib.parse.urlparse(self.path)
        blob = self._split_repo(parsed.path, "/blobs/")
        if blob:
            _, digest = blob
            with LOCK:
                exists = digest in BLOBS
            self.send_response(200 if exists else 404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._send(404)

    def do_POST(self):  # noqa: N802
        self._record()
        if not self._auth_ok():
            return
        parsed = urllib.parse.urlparse(self.path)
        upload = self._split_repo(parsed.path, "/blobs/uploads/")
        if upload:
            repo, _ = upload
            token = f"u{len(UPLOADS) + 1}"
            with LOCK:
                UPLOADS[token] = {"repo": repo, "data": b""}
            self._send(202, b"", {"Location": f"/v2/{repo}/blobs/uploads/{token}"})
            return
        self._send(404)

    def do_PATCH(self):  # noqa: N802
        self._record()
        data = self._body()   # drain even on 401, so the retry can reuse the connection
        if not self._auth_ok():
            return
        parsed = urllib.parse.urlparse(self.path)
        upload = self._split_repo(parsed.path, "/blobs/uploads/")
        if not upload:
            self._send(404)
            return
        repo, token = upload
        with LOCK:
            session = UPLOADS.setdefault(token, {"repo": repo, "data": b""})
            session["data"] += data
        self._send(202, b"", {"Location": f"/v2/{repo}/blobs/uploads/{token}"})

    def do_PUT(self):  # noqa: N802
        self._record()
        body = self._body()
        if not self._auth_ok():
            return
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        upload = self._split_repo(parsed.path, "/blobs/uploads/")
        if upload:
            repo, token = upload
            data = body
            if data and "chunked" in repo:
                # A registry that refuses a body on PUT; the client must fall back
                # to PATCH-then-PUT.
                self._send(405, b"use chunked upload")
                return
            if "digest" not in query:
                self._send(400, b"digest is required")
                return
            digest = query["digest"][0]
            with LOCK:
                if not data:
                    data = UPLOADS.get(token, {}).get("data", b"")
                BLOBS[digest] = data
            if sha(data) != digest:
                self._send(400, b"digest mismatch")
                return
            self._send(201, b"", {"Docker-Content-Digest": digest})
            return
        manifest = self._split_repo(parsed.path, "/manifests/")
        if manifest:
            repo, ref = manifest
            media_type = self.headers.get("Content-Type") or "application/vnd.oci.image.manifest.v1+json"
            with LOCK:
                MANIFESTS[(repo, ref)] = (body, media_type)
                MANIFESTS[(repo, sha(body))] = (body, media_type)
            self._send(201, b"", {"Docker-Content-Digest": sha(body)})
            return
        self._send(404)

    def do_DELETE(self):  # noqa: N802
        self._record()
        if not self._auth_ok():
            return
        self._send(202)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        # The sidecar closes its keep-alive connections on shutdown; that reset
        # is expected and would otherwise spray tracebacks over the test output.
        pass


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
        self.proc.stdin.write(
            json.dumps({"jsonrpc": "2.0", "id": self.seq, "method": method, "params": params}) + "\n"
        )
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("sidecar closed the stream")
        return json.loads(line)

    def ok(self, method: str, params: dict) -> dict:
        reply = self.call(method, params)
        if "error" in reply:
            raise RuntimeError(f"{method}: {reply['error'].get('message')}")
        return reply.get("result", {})

    def connect(self, conn_id: str, registry_type: str = "docker-v2",
                auth_type: str = "noauth", username: str = "", password: str = "") -> None:
        self.ok("connection/connect", {
            "connection": {
                "id": conn_id, "name": "IMREPO", "host": REGISTRY_HOST, "port": PORT,
                "username": username,
                "config": {
                    "registry_type": registry_type, "auth_type": auth_type,
                    "scheme": "http", "insecure": True,
                },
                "secret": {"password": password} if password else {},
            },
        })

    def upload(self, data: bytes, name: str, chunk: int = 64 * 1024) -> tuple[str, dict]:
        begin = self.ok("transfer/uploadBegin", {"name": name, "size": len(data)})
        tid = begin["id"]
        offset = 0
        while offset < len(data):
            part = data[offset:offset + chunk]
            self.ok("transfer/uploadChunk", {
                "id": tid, "offset": offset,
                "data": base64.b64encode(part).decode("ascii"),
            })
            offset += len(part)
        self.ok("transfer/uploadEnd", {"id": tid})
        status = self.wait(tid, "transfer/uploadStatus", done=("ready", "error"))
        return tid, status

    def wait(self, tid: str, method: str, key: str = "state",
             done: tuple[str, ...] = ("done", "error"), timeout: float = 30.0) -> dict:
        deadline = time.time() + timeout
        last = {}
        while time.time() < deadline:
            last = self.ok(method, {"id": tid})
            state = last.get("push", {}).get("state", "") if method.endswith("uploadStatus") and key == "push" else last.get(key, "")
            if state in done:
                return last
            time.sleep(0.05)
        raise RuntimeError(f"{method} did not reach {done}: {last}")

    def export(self, repo: str, ref: str, **kwargs) -> tuple[bytes, dict, dict]:
        plan = self.ok("transfer/exportPlan", {"repository": repo, "reference": ref})
        begin = self.ok("transfer/exportBegin", {"repository": repo, "reference": ref, **kwargs})
        job = begin["id"]
        status = self.wait(job, "transfer/exportStatus", done=("ready", "error"))
        if status.get("state") == "error":
            self.ok("transfer/exportClose", {"id": job})
            with LOCK:
                recent = "\n".join(LOG[-40:])
            raise RuntimeError(f"{status.get('error', 'export failed')}\nrecent requests:\n{recent}")
        chunks = []
        offset = 0
        while True:
            part = self.ok("transfer/exportChunk", {"id": job, "offset": offset})
            chunks.append(base64.b64decode(part["data"]))
            offset += part["length"]
            if part["eof"]:
                break
        self.ok("transfer/exportClose", {"id": job})
        return b"".join(chunks), plan, status

    def stop(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def reset_registry() -> None:
    with LOCK:
        BLOBS.clear()
        MANIFESTS.clear()
        UPLOADS.clear()
        LOG.clear()


def log_has(fragment: str) -> bool:
    with LOCK:
        return any(fragment in line for line in LOG)


def manifest_json(body: bytes) -> dict:
    return json.loads(body.decode("utf-8"))


def assert_archive_contains(archive: bytes, wanted: list[str], check) -> None:
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:*") as tf:
        names = tf.getnames()
        for name in wanted:
            check(f"archive contains {name}", name in names, names)


def main() -> int:
    exe, _manifest, workdir = _harness.extract_sidecar()
    srv = Server((REGISTRY_HOST, PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    check = _reporter.check
    sidecars: list[Sidecar] = []

    def new_sidecar(conn_id: str, registry_type: str = "docker-v2") -> Sidecar:
        sc = Sidecar(exe)
        sc.connect(conn_id, registry_type)
        sidecars.append(sc)
        return sc

    try:
        docker_tar, docker_fx = docker_archive("amd64", compressed=False)

        print("\nA) docker save .tar → inspect and push")
        reset_registry()
        sc = new_sidecar("upload-a")
        probe = sc.ok("transfer/uploadBegin", {"name": "no-extension-at-all", "size": 1})
        check("the upload chunk fits the host bridge's 2 MiB JSON limit",
              probe.get("chunkBytes") == 1024 * 1024, probe)
        sc.ok("transfer/uploadClose", {"id": probe["id"]})
        tid, status = sc.upload(docker_tar, "ledger-api.tar")
        check("inspection finished", status.get("state") == "ready", status)
        archive = status.get("archive", {})
        check("format is docker", archive.get("format") == "docker", archive)
        images = archive.get("images") or []
        check("one image found", len(images) == 1, images)
        img = images[0] if images else {}
        check("repo tag preserved", img.get("refs") == ["source.example.com/archive/ledger-api:amd64"], img)
        check("registry host stripped from the suggestion",
              img.get("suggestedRepository") == "archive/ledger-api" and img.get("suggestedTag") == "amd64", img)
        check("platform is linux/amd64",
              img.get("platforms") == [{"os": "linux", "architecture": "amd64"}], img.get("platforms"))
        sc.ok("transfer/uploadPush", {
            "id": tid, "imageIndex": 0,
            "repository": "payments/ledger-api", "tag": "v2",
        })
        pushed = sc.wait(tid, "transfer/uploadStatus", key="push")
        check("push finished", pushed.get("push", {}).get("state") == "done", pushed.get("push"))
        check("config blob arrived", BLOBS.get(docker_fx["config_digest"]) == docker_fx["config"])
        check("layer blob arrived", BLOBS.get(docker_fx["layer_digest"]) == docker_fx["layer"])
        stored = MANIFESTS.get(("payments/ledger-api", "v2"))
        check("manifest was published under the requested tag", stored is not None)
        check("the source reference is only a suggestion (nothing published there)",
              MANIFESTS.get(("payments/ledger-api", "amd64")) is None
              and MANIFESTS.get(("archive/ledger-api", "amd64")) is None,
              sorted(k for k in MANIFESTS if k[0] in ("payments/ledger-api", "archive/ledger-api")))
        if stored:
            doc = manifest_json(stored[0])
            check("manifest is a docker v2 manifest",
                  doc.get("mediaType") == "application/vnd.docker.distribution.manifest.v2+json", doc)
            check("manifest points at the config", doc["config"]["digest"] == docker_fx["config_digest"], doc)
            check("manifest points at the gzip layer",
                  doc["layers"][0]["digest"] == docker_fx["layer_digest"]
                  and "gzip" in doc["layers"][0]["mediaType"], doc["layers"])
        sc.ok("transfer/uploadClose", {"id": tid})

        print("\nB) docker save .tar.gz → same path through gzip")
        reset_registry()
        gz_tar, gz_fx = docker_archive("amd64", compressed=True)
        sc = new_sidecar("upload-b")
        tid, status = sc.upload(gz_tar, "ledger-api.tar.gz")
        check("gzip archive is indexed", status.get("state") == "ready", status)
        check("compressed flag is reported", status.get("archive", {}).get("compressed") is True)
        sc.ok("transfer/uploadPush", {
            "id": tid, "imageIndex": 0, "repository": "payments/gz", "tag": "v1",
        })
        pushed = sc.wait(tid, "transfer/uploadStatus", key="push")
        check("gzip push finished", pushed.get("push", {}).get("state") == "done", pushed.get("push"))
        check("gzip layer arrived", BLOBS.get(gz_fx["layer_digest"]) == gz_fx["layer"])
        sc.ok("transfer/uploadClose", {"id": tid})

        print("\nC) registry that refuses monolithic PUT → chunked fallback")
        reset_registry()
        sc = new_sidecar("upload-c")
        tid, status = sc.upload(docker_tar, "ledger-api.tar")
        check("archive indexed", status.get("state") == "ready", status)
        sc.ok("transfer/uploadPush", {
            "id": tid, "imageIndex": 0, "repository": "chunked/ledger-api", "tag": "v1",
        })
        pushed = sc.wait(tid, "transfer/uploadStatus", key="push")
        check("chunked push finished", pushed.get("push", {}).get("state") == "done", pushed.get("push"))
        check("a PATCH upload was attempted", log_has(f"PATCH /v2/chunked/ledger-api/blobs/uploads/"))
        check("the layer still arrived", BLOBS.get(docker_fx["layer_digest"]) == docker_fx["layer"])
        sc.ok("transfer/uploadClose", {"id": tid})

        print("\nD) OCI image layout with two platforms → child manifests by digest")
        reset_registry()
        oci_tar, oci_fx = oci_archive(multi=True)
        sc = new_sidecar("upload-d")
        tid, status = sc.upload(oci_tar, "multi.tar")
        check("OCI archive indexed", status.get("state") == "ready", status)
        check("format is oci", status.get("archive", {}).get("format") == "oci", status.get("archive"))
        img = (status.get("archive", {}).get("images") or [{}])[0]
        check("both platforms are listed",
              [p.get("architecture") for p in img.get("platforms", [])] == ["amd64", "arm64"], img)
        check("tag annotation became the suggested tag", img.get("suggestedTag") == "v1", img)
        sc.ok("transfer/uploadPush", {
            "id": tid, "imageIndex": 0, "repository": "payments/multi", "tag": "v3",
        })
        pushed = sc.wait(tid, "transfer/uploadStatus", key="push")
        check("OCI push finished", pushed.get("push", {}).get("state") == "done", pushed.get("push"))
        for arch, fx in oci_fx["fixtures"].items():
            check(f"{arch} config arrived", BLOBS.get(fx["config_digest"]) == fx["config"])
            check(f"{arch} layer arrived", BLOBS.get(fx["layer_digest"]) == fx["layer"])
            check(f"{arch} child manifest was pushed by digest",
                  MANIFESTS.get(("payments/multi", fx["manifest_digest"])) is not None)
        stored = MANIFESTS.get(("payments/multi", "v3"))
        check("index was published under the tag", stored is not None)
        if stored:
            check("index bytes are preserved exactly", stored[0] == oci_fx["top"], stored[0][:200])

        print("\nD2) OCI archive + ARCH → only that platform is published")
        reset_registry()
        sc.ok("transfer/uploadPush", {
            "id": tid, "imageIndex": 0, "repository": "payments/arm", "tag": "v3-arm64",
            "platform": "linux/arm64",
        })
        pushed = sc.wait(tid, "transfer/uploadStatus", key="push")
        check("single-platform push finished",
              pushed.get("push", {}).get("state") == "done", pushed.get("push"))
        arm = oci_fx["fixtures"]["arm64"]
        amd = oci_fx["fixtures"]["amd64"]
        stored = MANIFESTS.get(("payments/arm", "v3-arm64"))
        check("the tag points at the arm64 child manifest, not the index",
              stored is not None and stored[0] == arm["manifest"], stored[0][:200] if stored else None)
        check("arm64 config and layer were uploaded",
              BLOBS.get(arm["config_digest"]) == arm["config"]
              and BLOBS.get(arm["layer_digest"]) == arm["layer"])
        check("amd64 blobs were not uploaded",
              amd["config_digest"] not in BLOBS and amd["layer_digest"] not in BLOBS)
        check("the multi-arch index itself was not published",
              MANIFESTS.get(("payments/arm", oci_fx["top_digest"])) is None)
        reply = sc.call("transfer/uploadPush", {
            "id": tid, "imageIndex": 0, "repository": "payments/arm", "tag": "v3",
            "platform": "not-a-platform",
        })
        check("a syntactically invalid platform is rejected before pushing",
              "error" in reply, reply)
        sc.ok("transfer/uploadPush", {
            "id": tid, "imageIndex": 0, "repository": "payments/arm", "tag": "v3",
            "platform": "linux/s390x",
        })
        failed = sc.wait(tid, "transfer/uploadStatus", key="push")
        check("a platform the archive does not contain is reported",
              failed.get("push", {}).get("state") == "error"
              and "s390x" in (failed.get("push", {}).get("error") or ""), failed.get("push"))
        sc.ok("transfer/uploadClose", {"id": tid})

        print("\nE) validation before any network write")
        sc = new_sidecar("upload-e")
        tid, status = sc.upload(docker_tar, "ledger-api.tar")
        check("archive indexed", status.get("state") == "ready", status)
        for label, repo, tag in [
            ("uppercase repository", "Payments/App", "v1"),
            ("tag with a space", "payments/app", "bad tag"),
            ("empty tag", "payments/app", ""),
        ]:
            reply = sc.call("transfer/uploadPush", {
                "id": tid, "imageIndex": 0, "repository": repo, "tag": tag,
            })
            check(f"rejects {label}", "error" in reply, reply)
        harbor = new_sidecar("upload-e-harbor", "harbor")
        tid2, status2 = harbor.upload(docker_tar, "ledger-api.tar")
        check("Harbor archive indexed", status2.get("state") == "ready", status2)
        reply = harbor.call("transfer/uploadPush", {
            "id": tid2, "imageIndex": 0, "repository": "ledger-api", "tag": "v1",
        })
        check("Harbor requires project/repository", "error" in reply, reply)
        harbor.ok("transfer/uploadPush", {
            "id": tid2, "imageIndex": 0, "repository": "proj/app", "tag": "v1",
        })
        harbor_pushed = harbor.wait(tid2, "transfer/uploadStatus", key="push")
        check("a project/repository target pushes over plain OCI",
              harbor_pushed.get("push", {}).get("state") == "done"
              and MANIFESTS.get(("proj/app", "v1")) is not None, harbor_pushed.get("push"))
        harbor.ok("transfer/uploadClose", {"id": tid2})
        tid3, status3 = sc.upload(docker_tar, "ledger-api.bin")
        check("a valid archive is accepted regardless of its extension",
              status3.get("state") == "ready", status3)
        sc.ok("transfer/uploadClose", {"id": tid3})
        tid4, status4 = sc.upload(b"this is not a tar file", "fake.tar")
        check("a garbage file named .tar is rejected by content",
              status4.get("state") == "error", status4)
        check("...with an error that says the bytes are not a tar",
              "tar" in (status4.get("error") or ""), status4)
        sc.ok("transfer/uploadClose", {"id": tid4})
        tid5, status5 = sc.upload(gz(b"also not a tar"), "fake.tar.gz")
        check("a gzip stream that is not a tar is rejected too",
              status5.get("state") == "error", status5)
        sc.ok("transfer/uploadClose", {"id": tid5})
        sc.ok("transfer/uploadClose", {"id": tid})

        print("\nF) docker export with an explicit platform")
        reset_registry()
        # Seed the registry with the multi-arch OCI layout from fixture D.
        for arch, fx in oci_fx["fixtures"].items():
            BLOBS[fx["config_digest"]] = fx["config"]
            BLOBS[fx["layer_digest"]] = fx["layer"]
            BLOBS[fx["manifest_digest"]] = fx["manifest"]
            MANIFESTS[("payments/multi", fx["manifest_digest"])] = (
                fx["manifest"], "application/vnd.oci.image.manifest.v1+json")
        BLOBS[oci_fx["top_digest"]] = oci_fx["top"]
        MANIFESTS[("payments/multi", "v3")] = (oci_fx["top"], oci_fx["top_media_type"])
        # A real registry indexes a pushed manifest by digest as well as by tag;
        # the OCI export walks the graph by digest, so the fixture must too.
        MANIFESTS[("payments/multi", oci_fx["top_digest"])] = (
            oci_fx["top"], oci_fx["top_media_type"])
        sc = new_sidecar("export-f")
        archive, plan, status = sc.export(
            "payments/multi", "v3", format="docker", gzip=False, platform="linux/arm64", tag="v3")
        check("plan reports an index", plan.get("isIndex") is True, plan)
        check("plan lists both platforms",
              [p.get("architecture") for p in plan.get("platforms", [])] == ["amd64", "arm64"], plan)
        check("export produced bytes", len(archive) > 0)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tf:
            names = tf.getnames()
            check("docker archive has manifest.json", "manifest.json" in names, names)
            doc = json.loads(tf.extractfile("manifest.json").read())
            check("RepoTags names the source repository", doc[0]["RepoTags"] == ["payments/multi:v3"], doc)
            arm = oci_fx["fixtures"]["arm64"]
            check("manifest points at the arm64 config",
                  doc[0]["Config"] == digest_hex(arm["config_digest"]) + ".json", doc[0])
            check("manifest points at one layer", len(doc[0]["Layers"]) == 1, doc[0])
            check("config bytes are the arm64 config",
                  tf.extractfile(doc[0]["Config"]).read() == arm["config"])
            check("layer bytes are the arm64 layer",
                  tf.extractfile(doc[0]["Layers"][0]).read() == arm["layer"])

        print("\nG) docker export as .tar.gz")
        gz_archive, _plan, _status = sc.export(
            "payments/multi", "v3", format="docker", gzip=True, platform="linux/amd64", tag="v3")
        check("output starts with the gzip magic", gz_archive[:2] == b"\x1f\x8b", gz_archive[:4])
        with tarfile.open(fileobj=io.BytesIO(gz_archive), mode="r:gz") as tf:
            check("gzip archive has manifest.json", "manifest.json" in tf.getnames())

        print("\nH) OCI export with every platform")
        archive, plan, _status = sc.export(
            "payments/multi", "v3", format="oci", gzip=False, tag="v3")
        check("OCI export of an index needs no platform", plan.get("isIndex") is True)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tf:
            names = tf.getnames()
            for required in ("oci-layout", "index.json"):
                check(f"OCI archive has {required}", required in names, names)
            index = json.loads(tf.extractfile("index.json").read())
            check("index.json names the tag",
                  index["manifests"][0]["annotations"]["org.opencontainers.image.ref.name"] == "v3", index)
            top_digest = index["manifests"][0]["digest"]
            check("index points at the original index digest", top_digest == oci_fx["top_digest"], index)
            top_path = "blobs/sha256/" + digest_hex(top_digest)
            check("the top index blob is present", top_path in names, names)
            check("the top index bytes are intact", tf.extractfile(top_path).read() == oci_fx["top"])
            for arch, fx in oci_fx["fixtures"].items():
                for digest in (fx["manifest_digest"], fx["config_digest"], fx["layer_digest"]):
                    path = "blobs/sha256/" + digest_hex(digest)
                    check(f"{arch} blob {digest[:19]}… is present", path in names, names)

        print("\nI) OCI export of one platform")
        archive, _plan, _status = sc.export(
            "payments/multi", "v3", format="oci", gzip=False, platform="linux/amd64", tag="v3")
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tf:
            names = tf.getnames()
            index = json.loads(tf.extractfile("index.json").read())
            amd = oci_fx["fixtures"]["amd64"]
            check("index.json points at the amd64 manifest",
                  index["manifests"][0]["digest"] == amd["manifest_digest"], index)
            check("amd64 manifest blob is present",
                  "blobs/sha256/" + digest_hex(amd["manifest_digest"]) in names, names)
            check("arm64 manifest blob is absent",
                  "blobs/sha256/" + digest_hex(oci_fx["fixtures"]["arm64"]["manifest_digest"]) not in names)

        print("\nJ) export errors are reported, not silently empty")
        reply = sc.call("transfer/exportBegin", {
            "repository": "payments/multi", "reference": "v3", "format": "docker",
            "platform": "linux/s390x", "tag": "v3",
        })
        check("a bad platform is accepted as a job (the error arrives on status)",
              "result" in reply, reply)
        if "result" in reply:
            job = reply["result"]["id"]
            st = sc.wait(job, "transfer/exportStatus", done=("ready", "error"))
            check("the job reports the missing platform", st.get("state") == "error"
                  and "s390x" in (st.get("error") or ""), st)
            sc.ok("transfer/exportClose", {"id": job})
        reply = sc.call("transfer/exportChunk", {"id": "does-not-exist", "offset": 0})
        check("an unknown export id is rejected", "error" in reply, reply)
        reply = sc.call("transfer/exportPlan", {
            "repository": "payments/multi", "reference": "../../etc/passwd",
        })
        check("a reference cannot escape the manifest URL", "error" in reply, reply)

        print("\nL) a non-image OCI artifact exports only as an OCI layout")
        layer = gz(tar_bytes([("Chart.yaml", b"name: demo\n")]))
        layer_digest = sha(layer)
        chart_config = json.dumps({"name": "demo", "version": "0.1.0"},
                                  separators=(",", ":")).encode()
        cfg_digest = sha(chart_config)
        chart_manifest = json.dumps({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {"mediaType": "application/vnd.cncf.helm.config.v1+json",
                       "digest": cfg_digest, "size": len(chart_config)},
            "layers": [{"mediaType": "application/vnd.cncf.helm.chart.content.v1.tar+gzip",
                        "digest": layer_digest, "size": len(layer)}],
        }, separators=(",", ":")).encode()
        chart_digest = sha(chart_manifest)
        BLOBS[cfg_digest] = chart_config
        BLOBS[layer_digest] = layer
        BLOBS[chart_digest] = chart_manifest
        MANIFESTS[("payments/chart", "1.0")] = (
            chart_manifest, "application/vnd.oci.image.manifest.v1+json")
        MANIFESTS[("payments/chart", chart_digest)] = (
            chart_manifest, "application/vnd.oci.image.manifest.v1+json")

        plan = sc.ok("transfer/exportPlan", {"repository": "payments/chart", "reference": "1.0"})
        check("the plan marks a Helm chart as not an image", plan.get("isImage") is False, plan)
        begin = sc.ok("transfer/exportBegin", {
            "repository": "payments/chart", "reference": "1.0",
            "format": "docker", "tag": "1.0",
        })
        st = sc.wait(begin["id"], "transfer/exportStatus", done=("ready", "error"))
        check("a Docker archive is refused for it",
              st.get("state") == "error" and "not a container image" in (st.get("error") or ""), st)
        sc.ok("transfer/exportClose", {"id": begin["id"]})
        chart_archive, _plan, _st = sc.export(
            "payments/chart", "1.0", format="oci", gzip=False, tag="1.0")
        with tarfile.open(fileobj=io.BytesIO(chart_archive), mode="r:") as tf:
            names = tf.getnames()
            check("an OCI layout still carries the chart blobs",
                  "blobs/sha256/" + digest_hex(cfg_digest) in names
                  and "blobs/sha256/" + digest_hex(layer_digest) in names, names)

        print("\nM) a registry behind a bearer token challenge")
        reset_registry()
        globals()["REQUIRE_AUTH"] = True
        try:
            sc = Sidecar(exe)
            sc.connect("auth", auth_type="basic", username="admin", password="secret")
            sidecars.append(sc)
            tid, status = sc.upload(docker_tar, "ledger-api.tar")
            check("archive indexed behind the challenge", status.get("state") == "ready", status)
            sc.ok("transfer/uploadPush", {
                "id": tid, "imageIndex": 0, "repository": "auth/app", "tag": "v1",
            })
            pushed = sc.wait(tid, "transfer/uploadStatus", key="push")
            check("push obtained a bearer token and completed",
                  pushed.get("push", {}).get("state") == "done", pushed.get("push"))
            check("blobs arrived through the authenticated session",
                  BLOBS.get(docker_fx["layer_digest"]) == docker_fx["layer"])
            exported, _plan, _st = sc.export(
                "auth/app", "v1", format="docker", gzip=False, platform="linux/amd64", tag="v1")
            with tarfile.open(fileobj=io.BytesIO(exported), mode="r:") as tf:
                check("export reads the blobs through the same challenge",
                      "manifest.json" in tf.getnames(), tf.getnames())
            sc.ok("transfer/uploadClose", {"id": tid})
        finally:
            globals()["REQUIRE_AUTH"] = False

        print("\nK) temp files are removed when a transfer is closed")
        # The plugin data directory is redirected into a temp dir by
        # _harness.isolated_env, so this asserts on the sidecar's own workspace.
        tid, status = sc.upload(docker_tar, "cleanup.tar")
        sc.ok("transfer/uploadClose", {"id": tid})
        reply = sc.call("transfer/uploadStatus", {"id": tid})
        check("a closed upload is gone", "error" in reply, reply)
    finally:
        for sc in sidecars:
            sc.stop()
        srv.shutdown()
        shutil.rmtree(workdir, ignore_errors=True)

    return _reporter.report()


if __name__ == "__main__":
    raise SystemExit(main())
