#!/usr/bin/env python3
"""End-to-end regression test for the settings feature.

Runs the packaged sidecar against a fixture Harbor API and asserts that every
setting actually changes behaviour — not that a form saves a number.

Covered:
  A  identity   — settings/get defaults, app/info reports the packaged identity
                  and a settings path inside the (isolated) config dir.
  B  persistence— save → read back → RELAUNCH the process → still there. Plus
                  per-connection scoping and reset.
  C  validation — out-of-range numbers, unknown enums and broken glob patterns
                  are rejected, and nothing is written.
  D  cleanup    — the rules decide what a scan proposes: excluded repository,
                  minimum age, "keep the newest N", and an undateable artifact.
                  Nothing is deleted by a scan.
  E  enforcement— the delete path re-decides each target against the rules, so a
                  rule added after the scan still blocks it (no DELETE sent).
  F  retention  — a protected tag cannot be deleted, and cannot be dropped by a
                  rename either; a rename that only ADDS a tag is still allowed.
  G  scanner    — severity threshold, report cache TTL, cache bypass and the
                  "scanning off" switch, all against the real RPC responses.
  H  harbor-side— scanners/project policy are read from Harbor; applying writes
                  only the differences and preserves unrelated metadata keys.
  Q  v1.5.0     — project creation, per-project storage quotas, audit logs
                  (global + per project, filtered), the registry-wide overview
                  (projects/repos/images/size + 1/3/7-day pull counts + recent
                  & most-pulled projects), and the per-project scanner policy
                  overriding the connection default.
  R  v1.7.0     — the sidecar remembers the last password per connection, the
                  top-level params.secret is honoured, and the REAL host payload
                  shape (external_config + connection_secrets) resolves config
                  and secrets correctly.

The config directory is redirected into a temp dir, so the test never touches
the user's real settings and always starts from defaults.

Run:  python tools/test-settings-e2e.py      (exit 0 = all pass)
"""

from __future__ import annotations

import http.server
import json
import os
import pathlib
import socketserver
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import _harness  # noqa: E402  (needs the path fix above)

ROOT = _harness.ROOT
PORT = 5037
PROJECT = "payments"
CONN = "settings-conn"

LEGACY = "sha256:" + "a" * 8 + "_legacy"
OLD = "sha256:" + "b" * 8 + "_old"
MID = "sha256:" + "c" * 8 + "_mid"
NEW = "sha256:" + "d" * 8 + "_new"
HOT_OLD = "sha256:" + "e" * 8 + "_hot_old"
HOT_MID = "sha256:" + "f" * 8 + "_hot_mid"
HOT_NEW = "sha256:" + "0" * 8 + "_hot_new"
NODATE = "sha256:" + "1" * 8 + "_nodate"
TAGGED = "sha256:" + "2" * 8 + "_tagged"


def ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


REPOS: dict[str, list[dict]] = {
    "legacy-svc": [{"digest": LEGACY, "type": "IMAGE", "size": 10, "push_time": ago(60)}],
    "app-ms": [
        {"digest": OLD, "type": "IMAGE", "size": 100, "push_time": ago(30)},
        {"digest": MID, "type": "IMAGE", "size": 200, "push_time": ago(20)},
        {"digest": NEW, "type": "IMAGE", "size": 300, "push_time": ago(1)},
    ],
    "hot-ms": [
        {"digest": HOT_OLD, "type": "IMAGE", "size": 1, "push_time": ago(30)},
        {"digest": HOT_MID, "type": "IMAGE", "size": 2, "push_time": ago(20)},
        {"digest": HOT_NEW, "type": "IMAGE", "size": 3, "push_time": ago(10)},
    ],
    "nodate": [{"digest": NODATE, "type": "IMAGE", "size": 4, "push_time": ""}],
    "tagged": [{"digest": TAGGED, "type": "IMAGE", "size": 5, "push_time": ago(5),
                "tags": [{"name": "latest"}, {"name": "release-1.2"}],
                # A multi-arch index. The backend turns these references into the
                # `arches` the tag table renders; without them this fixture, like
                # the backend, could not exercise that field at all.
                "references": [
                    {"child_digest": "sha256:" + "aa" * 8, "platform": {"architecture": "amd64", "os": "linux"}},
                    {"child_digest": "sha256:" + "bb" * 8, "platform": {"architecture": "arm64", "os": "linux"}},
                ]}],
}

REPORT = {
    "generated_at": "2026-09-23T09:00:00Z",
    "scanner": {"name": "Trivy", "version": "0.50.0"},
    "severity": "High",
    "vulnerabilities": [
        {"id": "CVE-1", "severity": "High", "package": "openssl", "version": "1.1"},
        {"id": "CVE-2", "severity": "Low", "package": "zlib", "version": "1.2"},
        {"id": "CVE-3", "severity": "Medium", "package": "curl", "version": "7.8"},
    ],
}

# Observable effects, so assertions can be about real traffic.
REQUESTS: list[tuple[str, str]] = []
DELETES: list[str] = []
PUTS: list[tuple[str, dict]] = []
POSTS: list[str] = []
REPORT_HITS = 0

SCANNERS = [{"uuid": "uuid-trivy", "name": "Trivy", "is_default": True},
            {"uuid": "uuid-anchore", "name": "Anchore", "is_default": False}]
PROJECT_METADATA = {"auto_scan": "false", "prevent_vul": "false", "severity": "low",
                    "reuse_sys_cve_allowlist": "true", "retention_id": "12", "public": "false"}
MEMBERS = [
    {"id": 11, "entity_name": "admin", "entity_type": "u", "role_id": 1, "role_name": "projectAdmin"},
    {"id": 12, "entity_name": "developer1", "entity_type": "u", "role_id": 2, "role_name": "developer"},
]
USERS = [
    {"user_id": 1, "username": "admin", "email": "admin@example.com", "sysadmin_flag": True},
    {"user_id": 2, "username": "developer1", "email": "dev1@example.com", "sysadmin_flag": False},
]
RETENTION = {"id": 12, "algorithm": "or",
             "rules": [{"id": 1, "template": "latestPushedK", "params": {"latestPushedK": 10},
                        "tag_selectors": [{"kind": "doublestar", "decoration": "matches", "pattern": "**"}],
                        "scope_selectors": {"repository": [{"kind": "doublestar", "decoration": "repoMatches", "pattern": "**"}]}}],
             "trigger": {"kind": "Schedule", "settings": {"cron": "0 0 2 * * *"}},
             "scope": {"level": "project", "ref": 1}}
V2_AUTH: list[str] = []
PROJECT_SCANNER = {"uuid": ""}
QUOTA_HARD = {"storage": -1}
AUDIT_LOGS = [
    {"id": 4, "op_time": ago(0), "operation": "pull", "resource": "payments/auth-api:v1.4.2", "username": "admin"},
    {"id": 3, "op_time": ago(2), "operation": "pull", "resource": "payments/gateway:2026-09-21", "username": "ci-robot"},
    {"id": 2, "op_time": ago(5), "operation": "push", "resource": "payments/auth-api:2026-09-18", "username": "ci-robot"},
    {"id": 1, "op_time": ago(10), "operation": "delete", "resource": "payments/docs-api@sha256:44aa", "username": "developer1"},
]
PROJECTS_CREATED: list[dict] = []

# --- Docker Registry v2 fixtures (namespace grouping / overview) ---
V2_CATALOG = ["team-alpha/app", "team-alpha/db", "team-beta/web", "nginx"]
V2_DIGEST = "sha256:" + "ab" * 32
V2_LAYER1, V2_LAYER2 = 1048576, 2097152  # 1 MiB + 2 MiB
V2_MANIFEST = {
    "schemaVersion": 2,
    "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
    "config": {"mediaType": "application/vnd.docker.container.image.v1+json",
               "size": 1024, "digest": "sha256:" + "cf" * 32},
    "layers": [
        {"mediaType": "application/vnd.docker.image.rootfs.diff.tar.gzip",
         "size": V2_LAYER1, "digest": "sha256:" + "a1" * 32},
        {"mediaType": "application/vnd.docker.image.rootfs.diff.tar.gzip",
         "size": V2_LAYER2, "digest": "sha256:" + "b2" * 32},
    ],
}



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

    def _body(self) -> dict:
        n = int(self.headers.get("content-length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode() or "{}")
        except Exception:
            return {}

    def do_GET(self):  # noqa: N802
        global REPORT_HITS
        path, _, query = self.path.partition("?")
        REQUESTS.append(("GET", self.path))
        if path.startswith("/service/token"):
            return self._send({"token": "fixture-token", "expires_in": 1800})
        if path.startswith("/api/v2.0/audit-logs"):
            qs = urllib.parse.parse_qs(query)
            op = (qs.get("operation") or [""])[0]
            return self._send([l for l in AUDIT_LOGS if not op or l["operation"] == op])
        if path.startswith("/api/v2.0/quotas"):
            return self._send([{"id": 7, "hard": QUOTA_HARD, "used": {"storage": 214643506}}])
        if path.startswith("/api/v2.0/scanners"):
            if os.environ.get("FIXTURE_SCANNERS_403"):
                return self._fail(403, "forbidden")
            return self._send(SCANNERS)
        if path.startswith(f"/api/v2.0/projects/{PROJECT}/scanner"):
            return self._send(PROJECT_SCANNER)
        if "/additions/vulnerabilities" in path:
            REPORT_HITS += 1
            return self._send({"application/vnd.security.vulnerability.report; version=1.1": REPORT})
        if path.startswith(f"/api/v2.0/projects/{PROJECT}/repositories"):
            rest = path[len(f"/api/v2.0/projects/{PROJECT}/repositories"):]
            if "/artifacts/" in rest:
                repo = rest[1:].split("/artifacts/", 1)[0]
                ref = rest.split("/artifacts/", 1)[1].split("?", 1)[0]
                for a in REPOS.get(repo, []):
                    if a["digest"] == ref or any(t["name"] == ref for t in a.get("tags", [])):
                        return self._send(a)
                return self._fail(404, "artifact not found")
            if "/artifacts" in rest:
                repo = rest[1:].split("/artifacts", 1)[0]
                return self._send(REPOS.get(repo, []))
            # bare repository listing
            return self._send([
                {"name": f"{PROJECT}/{name}", "artifact_count": len(items),
                 "pull_count": 3, "update_time": "2026-09-18T16:54:40Z"}
                for name, items in REPOS.items()
            ])
        if path == f"/api/v2.0/projects/{PROJECT}":
            return self._send({"project_id": 1, "name": PROJECT, "metadata": PROJECT_METADATA})
        if path.rstrip("/") == "/api/v2.0/projects":
            # bare project listing (used by the registry-wide overview)
            return self._send([{"project_id": 1, "name": PROJECT, "repo_count": 5, "public": True}])
        if path.startswith("/api/v2.0/ping"):
            if os.environ.get("FIXTURE_PING_404"):
                return self._fail(404, "harbor api not found")
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"Pong")
            return
        if path.startswith("/api/v2.0/projects/%s/members" % PROJECT):
            return self._send(MEMBERS)
        if path.startswith("/api/v2.0/users/current"):
            return self._send({"user_id": 1, "username": "admin", "email": "admin@example.com",
                               "sysadmin_flag": os.environ.get("FIXTURE_CURRENT_NONADMIN") != "1"})
        if path.startswith("/api/v2.0/users"):
            return self._send(USERS)
        if path.startswith("/api/v2.0/retentions/"):
            return self._send(RETENTION)
        if path == "/v2/_catalog":
            V2_AUTH.append(self.headers.get("authorization") or "")
            return self._send({"repositories": V2_CATALOG})
        if "/tags/list" in path:
            V2_AUTH.append(self.headers.get("authorization") or "")
            repo = path[len("/v2/"):].split("/tags/list", 1)[0]
            return self._send({"name": repo, "tags": ["v1", "v2"]})
        if "/manifests/" in path:
            V2_AUTH.append(self.headers.get("authorization") or "")
            body = json.dumps(V2_MANIFEST).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.docker.distribution.manifest.v2+json")
            self.send_header("Docker-Content-Digest", V2_DIGEST)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if "/blobs/" in path:
            # Image config blob: carries the architecture for single-arch manifests.
            return self._send({"architecture": "amd64", "os": "linux"})
        if path.startswith("/v2/"):
            V2_AUTH.append(self.headers.get("authorization") or "")
            return self._send({})
        return self._fail(404)

    def do_PUT(self):  # noqa: N802
        path = self.path
        body = self._body()
        REQUESTS.append(("PUT", path))
        PUTS.append((path, body))
        if path.startswith("/v2/"):
            # OCI manifest write (retag / tag creation)
            return self._send({}, 201)
        if path.startswith("/api/v2.0/quotas/"):
            QUOTA_HARD.update(body.get("hard") or {})
            return self._send({})
        if path.endswith("/scanner"):
            PROJECT_SCANNER["uuid"] = body.get("uuid", "")
            return self._send({})
        if path == f"/api/v2.0/projects/{PROJECT}":
            PROJECT_METADATA.update(body.get("metadata") or {})
            return self._send({})
        if "/members/" in path or path.endswith("/password") or path.endswith("/sysadmin"):
            return self._send({})
        if path.startswith("/api/v2.0/retentions/"):
            return self._send({})
        return self._fail(404)

    def do_POST(self):  # noqa: N802
        REQUESTS.append(("POST", self.path))
        POSTS.append(self.path)
        if self.path == "/c/login":
            return self._send({}, 200)
        if self.path == "/api/v2.0/projects":
            PROJECTS_CREATED.append(self._body())
            return self._send({}, 201)
        if self.path.endswith("/scan"):
            return self._send({}, 202)
        if self.path.endswith("/members") or self.path == "/api/v2.0/users" or self.path == "/api/v2.0/retentions":
            return self._send({}, 201)
        return self._fail(404)

    def do_DELETE(self):  # noqa: N802
        REQUESTS.append(("DELETE", self.path))
        DELETES.append(self.path)
        self.send_response(200)
        self.end_headers()

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class Sidecar:
    """One sidecar process. Relaunching it is how persistence is proved."""

    def __init__(self, exe: pathlib.Path, cfg: pathlib.Path):
        # cfg is the config dir the sidecar must use; _harness sets every env var
        # Go's os.UserConfigDir() consults, on Windows and elsewhere.
        env = dict(_harness.isolated_env(), XDG_CONFIG_HOME=str(cfg), APPDATA=str(cfg),
                   LOCALAPPDATA=str(cfg), USERPROFILE=str(cfg), HOME=str(cfg))
        self.proc = subprocess.Popen(
            [str(exe)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1, env=env,
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

    def connect(self, conn_id: str = CONN, registry_type: str = "harbor",
                auth_type: str = "basic", scheme: str = "", username: str = "") -> None:
        config = {"registry_type": registry_type, "auth_type": auth_type, "insecure": True}
        if scheme:
            config["scheme"] = scheme
        secret = {"password": "fixture-pass"} if username else {}
        reply = self.call("connection/connect", {
            "connection": {
                "id": conn_id, "name": "IMREPO", "host": "127.0.0.1", "port": PORT,
                "username": username,
                "config": config,
                "secret": secret,
            },
            "runtime": {"host": "127.0.0.1", "port": PORT},
        })
        if "error" in reply:
            raise AssertionError(f"connect failed: {reply['error']}")

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


_reporter = _harness.Reporter("settings")
check = _reporter.check


def settings_payload(**over) -> dict:
    base = {
        "cleanup": {"keepUntagged": 0, "minAgeDays": 0, "excludeRepos": [], "maxReposPerScan": 100},
        "retention": {"keepTagged": 0, "protectTags": ["latest"]},
        "scanner": {"source": "harbor", "threshold": "high", "cacheSeconds": 300},
    }
    for k, v in over.items():
        base[k].update(v)
    return base


def main() -> int:
    exe, manifest, work = _harness.extract_sidecar()
    cfg = work / "cfg"
    cfg.mkdir()

    print("\nP) package layout (the manifest must point at a file that ships)")
    layout_errors = _harness.package_layout_errors(_harness.find_package())
    check("packaged manifest points at the packaged sidecar", not layout_errors, layout_errors)
    check("packaged manifest keeps the repository identity",
          manifest["id"] == json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["id"], manifest["id"])

    srv = Server(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    try:
        print("\nA) defaults, identity and the settings file location")
        sc = Sidecar(exe, cfg)
        sc.connect()
        got = sc.result("settings/get", {"connectionId": CONN})
        s0 = got.get("settings") or {}
        check("a fresh connection runs on defaults", got.get("isDefault") is True, got.get("isDefault"))
        check("defaults are permissive (nothing pre-protected)",
              s0["cleanup"]["keepUntagged"] == 0 and s0["cleanup"]["minAgeDays"] == 0
              and s0["cleanup"]["maxReposPerScan"] == 100, s0)
        check("default retention protects only 'latest'",
              s0["retention"]["protectTags"] == ["latest"], s0["retention"])
        check("default scanner is Harbor with a 'high' threshold",
              s0["scanner"]["source"] == "harbor" and s0["scanner"]["threshold"] == "high", s0["scanner"])

        info = sc.result("app/info", {})
        print("   app/info:", json.dumps(info, ensure_ascii=False))
        check("About reports the packaged identity",
              info.get("pluginId") == manifest["id"] and info.get("version") == manifest["version"], info)
        check("About links to the project repository",
              str(info.get("github", "")).startswith("https://github.com/"), info.get("github"))
        check("settings path lives inside the isolated config dir",
              str(cfg) in (info.get("settingsPath") or ""), info.get("settingsPath"))

        print("\nB) saving, scoping, persistence across a restart, reset")
        payload = settings_payload(
            cleanup={"keepUntagged": 1, "minAgeDays": 7, "excludeRepos": ["legacy-*", " legacy-* "], "maxReposPerScan": 42},
            retention={"keepTagged": 2, "protectTags": ["latest", "release-*"]},
            scanner={"source": "harbor", "threshold": "critical", "cacheSeconds": 60},
        )
        saved = sc.result("settings/set", {"connectionId": CONN, "settings": payload})
        s1 = saved["settings"]
        check("save echoes normalised values", s1["cleanup"]["keepUntagged"] == 1 and s1["cleanup"]["maxReposPerScan"] == 42, s1)
        check("duplicate/blank patterns are cleaned up", s1["cleanup"]["excludeRepos"] == ["legacy-*"], s1["cleanup"]["excludeRepos"])
        check("threshold saved", s1["scanner"]["threshold"] == "critical", s1["scanner"])

        other = sc.result("settings/get", {"connectionId": "another-conn"})
        check("a different connection keeps its own (default) settings", other.get("isDefault") is True, other.get("isDefault"))

        path = pathlib.Path(saved["path"])
        on_disk = json.loads(path.read_text(encoding="utf-8"))
        check("settings are written as JSON on disk", CONN in (on_disk.get("connections") or {}), list((on_disk.get("connections") or {}).keys()))
        sc.close()

        sc = Sidecar(exe, cfg)
        sc.connect()
        again = sc.result("settings/get", {"connectionId": CONN})
        check("settings survive a process restart",
              again["settings"]["cleanup"]["minAgeDays"] == 7
              and again["settings"]["retention"]["keepTagged"] == 2
              and again["settings"]["scanner"]["cacheSeconds"] == 60, again["settings"])
        check("and are no longer flagged as defaults", again.get("isDefault") is False, again.get("isDefault"))

        print("\nC) validation rejects nonsense without writing anything")
        cases = [
            ("negative keep count", settings_payload(cleanup={"keepUntagged": -1})),
            ("scan limit out of range", settings_payload(cleanup={"maxReposPerScan": 0})),
            ("broken glob pattern", settings_payload(cleanup={"excludeRepos": ["bad-["]})),
            ("broken protect pattern", settings_payload(retention={"protectTags": ["rel[ease"]})),
            ("unknown threshold", settings_payload(scanner={"threshold": "blorp"})),
            ("unknown source", settings_payload(scanner={"source": "snyk"})),
            ("cache seconds out of range", settings_payload(scanner={"cacheSeconds": 99999})),
        ]
        for label, body in cases:
            reply = sc.call("settings/set", {"connectionId": CONN, "settings": body})
            msg = (reply.get("error") or {}).get("message", "")
            check(f"{label} is refused", "error" in reply and "invalid settings" in msg, reply)
        still = sc.result("settings/get", {"connectionId": CONN})
        check("the rejected saves left the stored settings untouched",
              still["settings"]["cleanup"]["minAgeDays"] == 7 and still["settings"]["scanner"]["threshold"] == "critical",
              still["settings"])

        print("\nD) cleanup rules decide what a scan proposes")
        # Phase 1: exclusion + minimum age.
        sc.result("settings/set", {"connectionId": CONN, "settings": settings_payload(
            cleanup={"keepUntagged": 0, "minAgeDays": 7, "excludeRepos": ["legacy-*"]})})
        scan = sc.result("harbor/untagged", {"connectionId": CONN, "project": PROJECT})
        items = {i["digest"]: i for i in scan["items"]}
        print("   rules echoed:", json.dumps(scan.get("rules"), ensure_ascii=False))
        check("scan reports the rules it applied", (scan.get("rules") or {}).get("minAgeDays") == 7, scan.get("rules"))
        check("excluded repository is protected", items.get(LEGACY, {}).get("protected") is True
              and "excluded" in items.get(LEGACY, {}).get("protectedReason", ""), items.get(LEGACY))
        check("artifact younger than the minimum age is protected", items.get(NEW, {}).get("protected") is True
              and "minimum age" in items.get(NEW, {}).get("protectedReason", ""), items.get(NEW))
        check("older artifacts stay eligible", items.get(OLD, {}).get("protected") in (None, False)
              and items.get(MID, {}).get("protected") in (None, False), (items.get(OLD), items.get(MID)))
        check("counters agree with the flags",
              scan.get("protectedCount") == sum(1 for i in scan["items"] if i.get("protected"))
              and scan.get("eligibleCount") == sum(1 for i in scan["items"] if not i.get("protected")),
              (scan.get("protectedCount"), scan.get("eligibleCount")))
        check("a scan never deletes anything", DELETES == [], DELETES)

        # Phase 2: keep the newest N.
        sc.result("settings/set", {"connectionId": CONN, "settings": settings_payload(
            cleanup={"keepUntagged": 2, "minAgeDays": 0, "excludeRepos": []})})
        scan2 = sc.result("harbor/untagged", {"connectionId": CONN, "project": PROJECT})
        items2 = {i["digest"]: i for i in scan2["items"]}
        check("the newest N are reserved (hot-ms)", items2.get(HOT_NEW, {}).get("protected") is True
              and items2.get(HOT_MID, {}).get("protected") is True, {k: v.get("protectedReason") for k, v in items2.items()})
        check("the oldest falls outside the reservation", items2.get(HOT_OLD, {}).get("protected") in (None, False), items2.get(HOT_OLD))
        check("reservation reason is explicit", "newest" in items2.get(HOT_NEW, {}).get("protectedReason", ""),
              items2.get(HOT_NEW, {}).get("protectedReason"))
        check("the exclusion no longer applies (its reason changed)",
              "excluded" not in items2.get(LEGACY, {}).get("protectedReason", ""), items2.get(LEGACY))

        # Phase 3: an artifact whose push time cannot be read is never assumed safe.
        check("an undateable artifact is protected while age rules are active",
              items2.get(NODATE, {}).get("protected") is True
              and "unparsable" in items2.get(NODATE, {}).get("protectedReason", ""), items2.get(NODATE))

        print("\nE) the delete path re-decides against the rules")
        DELETES.clear()
        sc.result("settings/set", {"connectionId": CONN, "settings": settings_payload(
            cleanup={"keepUntagged": 0, "minAgeDays": 0, "excludeRepos": ["legacy-*"]})})
        r = sc.result("harbor/cleanupUntagged", {"connectionId": CONN, "project": PROJECT, "targets": [
            {"repository": "legacy-svc", "reference": LEGACY, "size": 10},
            {"repository": "app-ms", "reference": OLD, "size": 100},
        ]})
        print("   result:", json.dumps({k: r.get(k) for k in ("deletedCount", "skipped")}, ensure_ascii=False))
        check("the rule-protected target was skipped", len(r.get("skipped") or []) == 1
              and "excluded" in (r["skipped"][0].get("reason") or ""), r.get("skipped"))
        check("only the eligible target was deleted", r.get("deletedCount") == 1, r.get("deletedCount"))
        check("exactly one DELETE went out", len(DELETES) == 1 and OLD in DELETES[0], DELETES)

        print("\nF) a protected tag cannot be deleted or renamed away")
        sc.result("settings/set", {"connectionId": CONN, "settings": settings_payload(
            retention={"keepTagged": 0, "protectTags": ["latest", "release-*"]})})
        PUTS.clear()
        DELETES.clear()
        check("protecting a tag is remembered by the backend",
              sc.result("settings/get", {"connectionId": CONN})["settings"]["retention"]["protectTags"] == ["latest", "release-*"])

        reply = sc.call("harbor/deleteTag", {"connectionId": CONN, "project": PROJECT,
                                             "repository": "tagged", "reference": TAGGED, "tag": "latest"})
        check("deleting a protected tag is refused", "error" in reply
              and "protected" in reply["error"]["message"], reply)
        check("and no request was sent to the registry", DELETES == [], DELETES)

        reply = sc.call("harbor/deleteTag", {"connectionId": CONN, "project": PROJECT,
                                             "repository": "tagged", "reference": TAGGED, "tag": "release-1.2"})
        check("a glob-protected tag (release-*) is refused too", "error" in reply
              and "release-*" in reply["error"]["message"], reply)
        check("still nothing was sent", DELETES == [], DELETES)

        reply = sc.call("registry/delete", {"connectionId": CONN, "repository": PROJECT + "/tagged",
                                            "digest": TAGGED, "tag": "latest"})
        check("the generic OCI delete honours the policy as well", "error" in reply, reply)

        reply = sc.call("registry/retag", {"connectionId": CONN, "repository": PROJECT + "/tagged",
                                           "sourceTag": "latest", "targetTag": "v9", "deleteSource": True})
        check("a rename that would drop a protected tag is refused", "error" in reply, reply)
        check("nothing was half-written (no manifest PUT)", PUTS == [], PUTS)

        r2 = sc.call("registry/retag", {"connectionId": CONN, "repository": PROJECT + "/tagged",
                                        "sourceTag": "latest", "targetTag": "v9", "deleteSource": False})
        check("adding a tag is still allowed (nothing is lost)", "error" not in r2, r2)

        print("\nG) the scanner threshold, its cache, and the off switch")
        sc.result("settings/set", {"connectionId": CONN, "settings": settings_payload(
            scanner={"source": "harbor", "threshold": "critical", "cacheSeconds": 300})})
        rep = sc.result("harbor/vulnerabilities", {"connectionId": CONN, "project": PROJECT,
                                                   "repository": "tagged", "reference": TAGGED})
        print("   report:", json.dumps({k: rep.get(k) for k in ("threshold", "highest", "exceedsThreshold", "counts", "scanner")}, ensure_ascii=False))
        check("threshold is echoed", rep.get("threshold") == "critical")
        check("the worst finding is classified", rep.get("highest") == "High", rep.get("highest"))
        check("High does not exceed a Critical threshold", rep.get("exceedsThreshold") is False, rep)
        check("severity counts are computed", rep.get("counts") == {"Critical": 0, "High": 1, "Medium": 1, "Low": 1}, rep.get("counts"))
        check("the scanner name is reported", rep.get("scanner") == "Trivy", rep.get("scanner"))

        sc.result("settings/set", {"connectionId": CONN, "settings": settings_payload(
            scanner={"source": "harbor", "threshold": "medium", "cacheSeconds": 300})})
        rep2 = sc.result("harbor/vulnerabilities", {"connectionId": CONN, "project": PROJECT,
                                                    "repository": "tagged", "reference": TAGGED})
        # The cached part is Harbor's payload; the verdict is policy, so it must be
        # recomputed on read rather than replayed from the cache.
        check("a lower threshold flips the verdict WITHOUT a refetch",
              rep2.get("exceedsThreshold") is True, rep2)
        check("...and that call really was a cache hit", rep2.get("cached") is True, rep2.get("cached"))
        check("the cached payload still carries the new threshold", rep2.get("threshold") == "medium", rep2.get("threshold"))
        before = REPORT_HITS
        rep3 = sc.result("harbor/vulnerabilities", {"connectionId": CONN, "project": PROJECT,
                                                    "repository": "tagged", "reference": TAGGED, "force": True})
        check("force bypasses the cache", REPORT_HITS == before + 1, (before, REPORT_HITS))
        check("a forced read is not flagged as cached", rep3.get("cached") is False, rep3.get("cached"))

        sc.result("settings/set", {"connectionId": CONN, "settings": settings_payload(
            scanner={"source": "harbor", "threshold": "medium", "cacheSeconds": 0})})
        before = REPORT_HITS
        sc.result("harbor/vulnerabilities", {"connectionId": CONN, "project": PROJECT,
                                            "repository": "tagged", "reference": TAGGED})
        check("cacheSeconds = 0 always refetches", REPORT_HITS == before + 1, (before, REPORT_HITS))

        sc.result("settings/set", {"connectionId": CONN, "settings": settings_payload(
            scanner={"source": "off", "threshold": "high", "cacheSeconds": 300})})
        before = REPORT_HITS
        rep4 = sc.result("harbor/vulnerabilities", {"connectionId": CONN, "project": PROJECT,
                                                    "repository": "tagged", "reference": TAGGED})
        check("turning scanning off short-circuits the panel", rep4.get("disabled") is True and rep4.get("reason"), rep4)
        check("and no scanner traffic is generated", REPORT_HITS == before, (before, REPORT_HITS))

        print("\nH) Harbor-side scanner configuration")
        sc.result("settings/set", {"connectionId": CONN, "settings": settings_payload(
            scanner={"source": "harbor", "threshold": "high", "cacheSeconds": 300})})
        PROJECT_METADATA.update({"auto_scan": "false", "prevent_vul": "false", "severity": "low"})
        PROJECT_SCANNER["uuid"] = ""
        sinfo = sc.result("harbor/scannerInfo", {"connectionId": CONN, "project": PROJECT})
        print("   scannerInfo:", json.dumps(sinfo, ensure_ascii=False))
        check("available scanners are listed", [x["uuid"] for x in sinfo.get("scanners") or []] == ["uuid-trivy", "uuid-anchore"], sinfo.get("scanners"))
        check("the project policy is read from Harbor",
              sinfo["project"]["autoScan"] is False and sinfo["project"]["severity"] == "low", sinfo.get("project"))

        applied = sc.result("harbor/applyScanner", {"connectionId": CONN, "project": PROJECT, "autoScan": True})
        print("   applied:", json.dumps(applied, ensure_ascii=False))
        check("applying reports what it wrote", applied.get("applied") == ["auto_scan=true"], applied)
        check("Harbor metadata was updated", PROJECT_METADATA["auto_scan"] == "true", PROJECT_METADATA)
        check("unrelated metadata keys survive the write",
              PROJECT_METADATA.get("reuse_sys_cve_allowlist") == "true", PROJECT_METADATA)
        check("and nothing else was touched", PROJECT_METADATA["prevent_vul"] == "false", PROJECT_METADATA)

        sc.result("harbor/applyScanner", {"connectionId": CONN, "project": PROJECT,
                                          "preventVul": True, "severity": "high"})
        check("prevent_vul and severity are written together",
              PROJECT_METADATA["prevent_vul"] == "true" and PROJECT_METADATA["severity"] == "high", PROJECT_METADATA)

        sc.result("harbor/applyScanner", {"connectionId": CONN, "project": PROJECT, "scannerUuid": "uuid-anchore"})
        check("the project scanner is pinned", PROJECT_SCANNER["uuid"] == "uuid-anchore", PROJECT_SCANNER)

        reply = sc.call("harbor/applyScanner", {"connectionId": CONN, "project": PROJECT})
        check("applying nothing is an error, not a silent no-op", "error" in reply, reply)

        os.environ["FIXTURE_SCANNERS_403"] = "1"
        try:
            limited = sc.result("harbor/scannerInfo", {"connectionId": CONN, "project": PROJECT})
            check("a 403 on the scanner list is reported as a note, not a failure",
                  any("403" in note for note in limited.get("notes") or []), limited.get("notes"))
            check("the rest of the panel still works for a read-only account",
                  (limited.get("project") or {}).get("severity") == "high", limited.get("project"))
        finally:
            os.environ.pop("FIXTURE_SCANNERS_403", None)

        POSTS.clear()
        sc.result("harbor/scan", {"connectionId": CONN, "project": PROJECT, "repository": "tagged", "reference": TAGGED})
        check("a scan can be triggered", len(POSTS) == 1 and POSTS[0].endswith("/scan"), POSTS)

        print("\nI) a genuinely non-Harbor registry says so instead of pretending")
        # FIXTURE_PING_404 makes the server not answer Harbor's API, so the
        # auto-detection cannot upgrade this connection — the refusal is real.
        os.environ["FIXTURE_PING_404"] = "1"
        try:
            sc.connect("plain-conn", registry_type="docker-v2")
            reply = sc.call("harbor/scannerInfo", {"connectionId": "plain-conn", "project": PROJECT})
            check("scanner info is refused for a plain OCI v2 registry", "error" in reply, reply)
            reply = sc.call("harbor/scan", {"connectionId": "plain-conn", "project": PROJECT,
                                            "repository": "plain", "reference": "latest"})
            check("triggering a scan is refused too", "error" in reply, reply)
        finally:
            os.environ.pop("FIXTURE_PING_404", None)

        print("\nJ) the project-wide image overview")
        imgs = sc.result("harbor/images", {"connectionId": CONN, "project": PROJECT})
        check("repository count matches the fixture", imgs.get("repositoryCount") == 5, imgs.get("repositoryCount"))
        check("image count is every artifact across every repository", imgs.get("imageCount") == 9, imgs.get("imageCount"))
        check("tag count counts tags, not images", imgs.get("tagCount") == 2, imgs.get("tagCount"))
        check("total size sums every image", imgs.get("totalSize") == 625, imgs.get("totalSize"))
        rows = imgs.get("images") or []
        check("one row per image", len(rows) == 9, len(rows))
        check("newest image first", rows and rows[0]["digest"] == NEW, rows[0] if rows else None)
        check("an image without a push date sorts last", rows and rows[-1]["digest"] == NODATE,
              rows[-1] if rows else None)
        by_digest = {r["digest"]: r for r in rows}
        check("each row knows its repository", by_digest.get(NEW, {}).get("repository") == "app-ms",
              by_digest.get(NEW))
        check("tags ride along for pull/retag (but are not the row)",
              by_digest.get(TAGGED, {}).get("tags") == ["latest", "release-1.2"], by_digest.get(TAGGED))
        check("a plain registry is refused the overview too",
              "error" in sc.call("harbor/images", {"connectionId": "plain-conn", "project": PROJECT}))

        print("\nK) project members and the retention policy")
        admin = sc.result("harbor/projectAdmin", {"connectionId": CONN, "project": PROJECT})
        check("members are listed", len(admin.get("members") or []) == 2, admin.get("members"))
        check("the bound retention policy rides along", (admin.get("retention") or {}).get("id") == 12,
              admin.get("retention"))
        check("users are listed for the member picker", len(admin.get("users") or []) == 2, admin.get("users"))
        POSTS.clear()
        sc.result("harbor/memberAdd", {"connectionId": CONN, "project": PROJECT, "roleId": 3, "username": "qa-guest"})
        check("adding a member POSTs to the members endpoint",
              any(p.endswith(f"/projects/{PROJECT}/members") for p in POSTS), POSTS)
        PUTS.clear()
        sc.result("harbor/memberRole", {"connectionId": CONN, "project": PROJECT, "memberId": 12, "roleId": 4})
        check("a role change PUTs the member resource",
              any("/members/12" in p for p, _ in PUTS), PUTS)
        n_del = len(DELETES)
        sc.result("harbor/memberRemove", {"connectionId": CONN, "project": PROJECT, "memberId": 12})
        check("removal DELETEs the member", len(DELETES) == n_del + 1 and "/members/12" in DELETES[-1], DELETES[-1])
        pol = json.loads(json.dumps(RETENTION))
        pol["rules"] = pol["rules"] + [{
            "template": "nDaysSinceLastPush", "params": {"nDaysSinceLastPush": 30},
            "tag_selectors": RETENTION["rules"][0]["tag_selectors"],
            "scope_selectors": RETENTION["rules"][0]["scope_selectors"]}]
        PUTS.clear()
        sc.result("harbor/retentionSave", {"connectionId": CONN, "project": PROJECT, "projectId": 1, "policy": pol})
        check("an existing policy is PUT back whole (no blind create)",
              any(p.startswith("/api/v2.0/retentions/") for p, _ in PUTS), PUTS)

        print("\nL) user management")
        users = sc.result("harbor/users", {"connectionId": CONN})
        check("users are listed", len(users) == 2, users)
        me = sc.result("harbor/currentUser", {"connectionId": CONN})
        check("the current user is identified as an admin", me.get("admin") is True
              and me["user"]["username"] == "admin", me)
        os.environ["FIXTURE_CURRENT_NONADMIN"] = "1"
        try:
            me = sc.result("harbor/currentUser", {"connectionId": CONN})
            check("a non-admin current user reports admin=false",
                  me.get("admin") is False and me["user"]["sysadmin_flag"] is False, me)
        finally:
            os.environ.pop("FIXTURE_CURRENT_NONADMIN", None)
        POSTS.clear()
        sc.result("harbor/userCreate", {"connectionId": CONN, "username": "new-user",
                                        "email": "n@example.com", "realname": "New User", "password": "Secret123!"})
        check("creating a user POSTs to /users", "/api/v2.0/users" in POSTS, POSTS)
        PUTS.clear()
        sc.result("harbor/userPassword", {"connectionId": CONN, "userId": 2, "newPassword": "Fresh456!"})
        check("a password reset PUTs the password resource",
              any(p.endswith("/users/2/password") for p, _ in PUTS), PUTS)
        sc.result("harbor/userAdmin", {"connectionId": CONN, "userId": 2, "admin": True})
        check("granting admin PUTs the sysadmin flag",
              any(p.endswith("/users/2/sysadmin") for p, _ in PUTS), PUTS)
        n_del = len(DELETES)
        sc.result("harbor/userDelete", {"connectionId": CONN, "userId": 2})
        check("deleting a user DELETEs the user resource",
              len(DELETES) == n_del + 1 and DELETES[-1].endswith("/users/2"), DELETES[-1])

        print("\nM) NoAuth and an explicit http scheme")
        sc.connect("anon-conn", registry_type="docker-v2", auth_type="noauth", scheme="http")
        info = sc.result("registry/info", {"connectionId": "anon-conn"})
        check("the http scheme is honoured", info.get("endpoint", "").startswith("http://"),
              info.get("endpoint"))
        before = len(V2_AUTH)
        sc.result("registry/catalog", {"connectionId": "anon-conn"})
        check("NoAuth sends no Authorization header at all",
              len(V2_AUTH) > before and V2_AUTH[-1] == "", V2_AUTH[-1:])

        print("\nN) a docker-v2 connection to a real Harbor upgrades itself")
        check("the session becomes harbor when Harbor's API answers",
              sc.result("registry/info", {"connectionId": "anon-conn"}).get("registryType") == "harbor",
              "registry/info still reports docker-v2")
        imgs = sc.result("harbor/images", {"connectionId": "anon-conn", "project": PROJECT})
        check("Harbor operations work without reconfiguring the connection",
              imgs.get("imageCount") == 9, imgs.get("imageCount"))

        print("\nO) toggling a project public / private")
        detail = sc.result("harbor/projectAdmin", {"connectionId": CONN, "project": PROJECT})
        check("the current visibility is read", (detail.get("project") or {}).get("public") is False,
              detail.get("project"))
        sc.result("harbor/projectSetPublic", {"connectionId": CONN, "project": PROJECT, "public": True})
        check("making a project public writes metadata.public", PROJECT_METADATA.get("public") == "true",
              PROJECT_METADATA)
        sc.result("harbor/projectSetPublic", {"connectionId": CONN, "project": PROJECT, "public": False})
        check("switching back to private writes it too", PROJECT_METADATA.get("public") == "false",
              PROJECT_METADATA)

        print("\nP) credential persistence across a secret-less reconnect")
        import base64 as _b64
        sc.connect(username="admin")   # the host delivers the password once
        check("the connect carried a Basic header with the password",
              V2_AUTH and V2_AUTH[-1] == "Basic " + _b64.b64encode(b"admin:fixture-pass").decode(),
              V2_AUTH[-1:] if V2_AUTH else None)
        # Reconnect the SAME connection with a username but WITHOUT the secret —
        # exactly what the host does when it drops the secret from a later
        # connect. The sidecar must fall back to the remembered password.
        before = len(V2_AUTH)
        sc.seq += 1
        sc.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": sc.seq, "method": "connection/connect",
            "params": {"connection": {"id": CONN, "name": "IMREPO", "host": "127.0.0.1", "port": PORT,
                                       "username": "admin",
                                       "config": {"registry_type": "harbor", "auth_type": "basic", "insecure": True}},
                       "runtime": {"host": "127.0.0.1", "port": PORT}}}) + "\n")
        sc.proc.stdin.flush()
        reply = json.loads(sc.proc.stdout.readline())
        check("the secret-less reconnect succeeds", "error" not in reply, reply)
        check("the session reuses the last-known password",
              len(V2_AUTH) > before
              and V2_AUTH[-1] == "Basic " + _b64.b64encode(b"admin:fixture-pass").decode(),
              V2_AUTH[-1:] if len(V2_AUTH) > before else None)
        # Ask the sidecar where its config lives rather than rebuilding the path
        # here: os.UserConfigDir() is %AppData% on Windows, but
        # $HOME/Library/Application Support on macOS and $XDG_CONFIG_HOME (or
        # ~/.config) elsewhere. Hardcoding one layout is right on at most two of
        # the three platforms — this check failed on macOS for exactly that
        # reason, while the settings-path check above passed because it only
        # looks for the temp dir as a substring.
        app_info = sc.result("app/info", {})
        settings_path = app_info.get("settingsPath") or ""
        check("the sidecar reports a settings file to derive the config dir from",
              settings_path.endswith("settings.json"), settings_path)
        credFile = pathlib.Path(settings_path).parent / "credentials.json"
        check("the credential file exists in the isolated config dir",
              credFile.exists() and str(cfg) in str(credFile), credFile)
        on_disk = json.loads(credFile.read_text(encoding="utf-8")) if credFile.exists() else {}
        check("it stores the base64-encoded password per connection",
              (on_disk.get("secrets") or {}).get(CONN) == _b64.b64encode(b"fixture-pass").decode(),
              (on_disk.get("secrets") or {}).get(CONN))

        print("\nR) a top-level params.secret is honoured too")
        before = len(V2_AUTH)
        sc.seq += 1
        sc.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": sc.seq, "method": "connection/connect",
            "params": {"connection": {"id": "toplevel-conn", "name": "IMREPO", "host": "127.0.0.1",
                                       "port": PORT, "username": "admin",
                                       "config": {"registry_type": "harbor", "auth_type": "basic", "insecure": True}},
                       "secret": {"password": "top-secret"},
                       "runtime": {"host": "127.0.0.1", "port": PORT}}}) + "\n")
        sc.proc.stdin.flush()
        reply = json.loads(sc.proc.stdout.readline())
        check("a top-level secret connects cleanly", "error" not in reply, reply)
        check("the top-level secret reaches the credential",
              len(V2_AUTH) > before and V2_AUTH[-1] == "Basic " + _b64.b64encode(b"admin:top-secret").decode(),
              V2_AUTH[-1:] if len(V2_AUTH) > before else None)

        print("\nS) the REAL host payload shape: external_config + connection_secrets")
        before = len(V2_AUTH)
        sc.seq += 1
        sc.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": sc.seq, "method": "connection/connect",
            "params": {"provider": {"id": "com.leavingrain.imrepo.connection", "databaseType": "imrepo-registry"},
                       "connection": {"id": "hostshape-conn", "db_type": "plugin",
                                      "plugin_id": "com.leavingrain.imrepo",
                                      "plugin_connection_provider": "com.leavingrain.imrepo.connection",
                                      "plugin_connection_type": "imrepo-registry",
                                      "name": "IMREPO", "host": "127.0.0.1", "port": PORT,
                                      "username": "admin",
                                      "external_config": {"registry_type": "harbor", "auth_type": "basic",
                                                          "scheme": "http", "insecure": True},
                                      "connection_secrets": {"password": "host-secret"},
                                      "read_only": False, "query_timeout_secs": 60, "idle_timeout_secs": 60},
                       "runtime": None}}) + "\n")
        sc.proc.stdin.flush()
        reply = json.loads(sc.proc.stdout.readline())
        check("a host-shape connect succeeds", "error" not in reply, reply)
        info = sc.result("registry/info", {"connectionId": "hostshape-conn"})
        check("external_config is honoured (scheme http, type harbor)",
              info.get("endpoint", "").startswith("http://") and info.get("registryType") == "harbor", info)
        check("connection_secrets.password reaches the credential",
              len(V2_AUTH) > before and V2_AUTH[-1] == "Basic " + _b64.b64encode(b"admin:host-secret").decode(),
              V2_AUTH[-1:] if len(V2_AUTH) > before else None)

        print("\nQ) project creation, quotas, audit logs, overview, per-project scanner")
        reply = sc.call("harbor/projectCreate", {"connectionId": CONN, "name": "Bad_Name!"})
        check("an invalid project name is refused", "error" in reply, reply)
        POSTS.clear()
        created = sc.result("harbor/projectCreate", {"connectionId": CONN, "name": "New-Proj", "public": True})
        check("a valid project is created via POST /projects",
              created.get("ok") is True and any(p.endswith("/api/v2.0/projects") for p in POSTS), POSTS)
        check("the create body carries the name and the public flag",
              PROJECTS_CREATED and PROJECTS_CREATED[-1]["project_name"] == "new-proj"
              and PROJECTS_CREATED[-1]["metadata"]["public"] == "true", PROJECTS_CREATED)

        quota = sc.result("harbor/quotaGet", {"connectionId": CONN, "project": PROJECT})
        check("the quota reads unlimited by default", quota.get("hardBytes") == -1
              and quota.get("quotaId") == 7, quota)
        check("used storage comes from the quota entry", quota.get("usedBytes") == 214643506, quota)
        sc.result("harbor/quotaSet", {"connectionId": CONN, "project": PROJECT, "hardBytes": 5 * 1024 ** 3})
        check("setting a quota PUTs the hard limit in bytes", QUOTA_HARD["storage"] == 5 * 1024 ** 3, QUOTA_HARD)
        quota = sc.result("harbor/quotaGet", {"connectionId": CONN, "project": PROJECT})
        check("the new limit is read back", quota.get("hardBytes") == 5 * 1024 ** 3, quota)
        reply = sc.call("harbor/quotaSet", {"connectionId": CONN, "project": PROJECT, "hardBytes": 0})
        check("a 0-byte quota is refused (use -1 for unlimited)", "error" in reply, reply)

        logs = sc.result("harbor/logs", {"connectionId": CONN, "project": PROJECT})
        check("the project's audit logs are listed", len(logs.get("logs") or []) == 4, logs)
        check("log rows carry time/operation/resource/username",
              all(k in (logs["logs"][0]) for k in ("time", "operation", "resource", "username")), logs["logs"][0])
        check("a project filter resolves the project id",
              any("project_id=1" in p for _, p in REQUESTS if "audit-logs" in p),
              [p for _, p in REQUESTS if "audit-logs" in p])
        logs = sc.result("harbor/logs", {"connectionId": CONN, "operation": "delete"})
        check("an operation filter is applied server-side",
              len(logs.get("logs") or []) == 1 and logs["logs"][0]["operation"] == "delete", logs)

        ov = sc.result("harbor/overview", {"connectionId": CONN})
        print("   overview:", json.dumps(ov, ensure_ascii=False))
        check("the overview counts the fixture's single project", ov.get("projectCount") == 1, ov.get("projectCount"))
        check("the overview walks every repository and image",
              ov.get("repoCount") == 5 and ov.get("imageCount") == 9, (ov.get("repoCount"), ov.get("imageCount")))
        check("total storage matches the artifact sizes", ov.get("totalSize") == 625, ov.get("totalSize"))
        pulls = ov.get("pullCounts") or {}
        check("pull counts cover the 1/3/7-day windows from the audit log",
              pulls.get("1") == 1 and pulls.get("3") == 2 and pulls.get("7") == 2, pulls)
        check("the overview lists recently created projects",
              [p["name"] for p in (ov.get("recentProjects") or [])] == [PROJECT], ov.get("recentProjects"))
        check("the overview ranks the most-pulled projects",
              (ov.get("topPulled") or [{}])[0].get("name") == PROJECT
              and (ov.get("topPulled") or [{}])[0].get("pulls") == 2, ov.get("topPulled"))

        ps = sc.result("settings/getProject", {"connectionId": CONN, "project": PROJECT})
        check("a project without its own scanner falls back to the connection",
              ps.get("isDefault") is True and ps["scanner"]["threshold"] == "high", ps)
        sc.result("settings/setProject", {"connectionId": CONN, "project": PROJECT,
                                          "scanner": {"source": "harbor", "threshold": "critical", "cacheSeconds": 60}})
        ps = sc.result("settings/getProject", {"connectionId": CONN, "project": PROJECT})
        check("the project override is stored", ps.get("isDefault") is False
              and ps["scanner"]["threshold"] == "critical", ps)
        rep = sc.result("harbor/vulnerabilities", {"connectionId": CONN, "project": PROJECT,
                                                   "repository": "tagged", "reference": TAGGED})
        check("the CVE panel honours the project-level threshold", rep.get("threshold") == "critical", rep)
        sc.result("settings/setProject", {"connectionId": CONN, "project": PROJECT,
                                          "scanner": {"source": "off", "threshold": "high", "cacheSeconds": 60}})
        rep = sc.result("harbor/vulnerabilities", {"connectionId": CONN, "project": PROJECT,
                                                   "repository": "tagged", "reference": TAGGED})
        check("a project can turn scanning off for itself",
              rep.get("disabled") is True and rep.get("threshold") == "high", rep)
        sc.result("settings/setProject", {"connectionId": CONN, "project": PROJECT,
                                          "scanner": {"source": "harbor", "threshold": "critical", "cacheSeconds": 60}})

        print("\nS) Docker Registry v2 project (namespace) view")
        sc.connect("v2-conn", registry_type="docker-v2", auth_type="noauth", scheme="http")
        ns = sc.result("registry/namespaces", {"connectionId": "v2-conn"})
        check("the catalog groups repositories into namespaces",
              sorted(x["name"] for x in ns) == ["nginx", "team-alpha", "team-beta"], ns)
        repos = sc.result("registry/repositories", {"connectionId": "v2-conn", "namespace": "team-alpha"})
        check("repos under a namespace carry full names",
              [r["full_name"] for r in repos] == ["team-alpha/app", "team-alpha/db"], repos)
        ov = sc.result("registry/images", {"connectionId": "v2-conn", "namespace": "team-alpha"})
        check("the namespace overview dedupes tags into images and sums size",
              ov.get("repoCount") == 2 and ov.get("imageCount") == 2
              and ov.get("tagCount") == 4
              and ov.get("totalSize") == 2 * (V2_LAYER1 + V2_LAYER2), ov)
        rov = sc.result("registry/overview", {"connectionId": "v2-conn"})
        check("the v2 overview counts namespaces/repos and ranks storage",
              rov.get("namespaceCount") == 3 and rov.get("repoCount") == 4
              and (rov.get("sizeByNamespace") or [{}])[0].get("name") == "team-alpha", rov)
        check("the v2 overview image/tag totals are deduped per repo",
              rov.get("imageCount") == 4 and rov.get("tagCount") == 8, rov)
        arches = sc.result("registry/arches", {"connectionId": "v2-conn",
                                               "repository": "team-alpha/app", "reference": "v1"})
        check("a single-arch manifest answers from its config blob",
              arches.get("arches") == ["amd64"], arches)
        # The same read answers the digest, which a v2 tags/list does not carry —
        # this is what lets the tag table show a sha256 per row for no extra cost.
        check("the same read reports the manifest digest",
              arches.get("digest") == V2_DIGEST, arches.get("digest"))

        print("\nT) harbor artifacts carry the architectures the tag table renders")
        # The backend computes `arches` from platform/references and the table
        # reads it. It used to send only the parts, so the table rendered badges
        # from a field that never arrived — invisible to the tests, because the
        # fixture (like the backend) did not have it either.
        multi = sc.result("harbor/artifacts", {"connectionId": CONN, "project": PROJECT, "repository": "tagged"})
        multi_arches = [a.get("arches") for a in multi if a.get("digest") == TAGGED]
        check("a multi-arch artifact reports both architectures",
              multi_arches == [["amd64", "arm64"]], multi_arches)
        single = sc.result("harbor/artifacts", {"connectionId": CONN, "project": PROJECT, "repository": "legacy-svc"})
        check("an artifact with no platform information reports none, not a guess",
              (single[0].get("arches") or []) == [], single[0].get("arches"))

        sc.close()
    finally:
        srv.shutdown()

    return _reporter.report()


if __name__ == "__main__":
    sys.exit(main())
