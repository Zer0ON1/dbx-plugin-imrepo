#!/usr/bin/env python3
"""End-to-end test for private AWS ECR browsing and credential resolution.

ECR implements OCI Distribution for pull/push but not GET /v2/_catalog. The
sidecar therefore lists repositories through the ECR API's DescribeRepositories
(signed with the same credentials as GetAuthorizationToken) and keeps using
/v2/ for everything else. This test drives the packaged sidecar against a local
fixture for both surfaces and checks the credentials actually used.

Covered:
  A  explicit Access Key + Secret + session token → SigV4 headers, paginated
     DescribeRepositories, /v2/_catalog is never called
  B  AWS_ACCESS_KEY_ID / SECRET / SESSION_TOKEN environment credentials
  C  a named profile in the shared credentials/config files, including region
  D  ecr:DescribeRepositories denial → an actionable error
  E  no credentials anywhere → a clear connection failure

Run:  python tools/test-ecr-e2e.py        (exit 0 = all pass)
"""

from __future__ import annotations

import base64
import http.server
import json
import pathlib
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import _harness  # noqa: E402  (needs the path fix above)

_reporter = _harness.Reporter("ecr")
PORT = 5046
HOST = "127.0.0.1"

REPOS_PAGES = [
    ["team-alpha/app", "team-alpha/db", "team-beta/api", "shared/base"],
    ["team-beta/web", "single"],
]
CALLS = []
V2_PATHS = []
LOCK = threading.Lock()
DENY_DESCRIBE = False


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _send(self, code: int, obj) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/x-amz-json-1.1" if code == 200 else "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        with LOCK:
            V2_PATHS.append(path)
        if path == "/v2/":
            self._send(200, {})
            return
        if path.startswith("/api/v2.0/ping"):
            self._send(404, {})
            return
        if path == "/v2/_catalog":
            # The whole point: ECR answers this and the plugin must not call it.
            self._send(404, {"errors": [{"code": "NOT_FOUND"}]})
            return
        if path.endswith("/tags/list"):
            repo = path[len("/v2/"):].split("/tags/list", 1)[0]
            self._send(200, {"name": repo, "tags": ["v1", "v2"]})
            return
        self._send(404, {})

    def do_POST(self):  # noqa: N802
        target = self.headers.get("x-amz-target") or ""
        body = self._body()
        with LOCK:
            CALLS.append({
                "target": target,
                "authorization": self.headers.get("authorization") or "",
                "session": self.headers.get("x-amz-security-token") or "",
                "body": body.decode("utf-8", "replace"),
            })
        if target.endswith(".GetAuthorizationToken"):
            token = base64.b64encode(b"AWS:ecr-token").decode()
            self._send(200, {"authorizationData": [{
                "authorizationToken": token,
                "proxyEndpoint": f"http://{HOST}:{PORT}",
            }]})
            return
        if target.endswith(".DescribeRepositories"):
            if DENY_DESCRIBE:
                self._send(403, {"__type": "AccessDeniedException", "message": "not authorized"})
                return
            try:
                request = json.loads(body or b"{}")
            except json.JSONDecodeError:
                request = {}
            index = 1 if request.get("nextToken") else 0
            if index >= len(REPOS_PAGES):
                self._send(200, {"repositories": []})
                return
            response = {
                "repositories": [{"repositoryName": name} for name in REPOS_PAGES[index]],
            }
            if index + 1 < len(REPOS_PAGES):
                response["nextToken"] = f"page-{index + 2}"
            self._send(200, response)
            return
        self._send(400, {"__type": "UnknownOperationException"})

    def do_PUT(self):  # noqa: N802
        self._send(404, {})


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass


class Sidecar:
    def __init__(self, exe: pathlib.Path, env: dict | None = None):
        base = _harness.isolated_env()
        # Keep the developer's real AWS environment out of the credential
        # resolution unless a test deliberately supplies it.
        for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
                    "AWS_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE",
                    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
                    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                    "AWS_EC2_METADATA_SERVICE_ENDPOINT"):
            base.pop(key, None)
        base["AWS_EC2_METADATA_DISABLED"] = "true"
        base["IMREPO_ECR_TOKEN_ENDPOINT"] = f"http://{HOST}:{PORT}/"
        base["IMREPO_ECR_API_ENDPOINT"] = f"http://{HOST}:{PORT}/"
        base.update(env or {})
        self.proc = subprocess.Popen(
            [str(exe)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1,
            env=base,
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

    def ok(self, method: str, params: dict):
        reply = self.call(method, params)
        if "error" in reply:
            raise RuntimeError(f"{method}: {reply['error'].get('message')}")
        return reply.get("result")

    def connect(self, conn_id: str, auth_type: str = "aws-ecr", **config) -> dict:
        conn_config = {
            "registry_type": "aws-ecr", "auth_type": auth_type,
            "scheme": "http", "insecure": True, "region": "us-east-1",
        }
        conn_config.update(config)
        return self.call("connection/connect", {
            "connection": {
                "id": conn_id, "name": "ECR", "host": HOST, "port": PORT,
                "config": conn_config,
                "secret": {
                    k: v for k, v in {
                        "secret_access_key": conn_config.pop("secret_access_key", ""),
                        "session_token": conn_config.pop("session_token", ""),
                    }.items() if v
                },
            },
        })

    def stop(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def reset() -> None:
    with LOCK:
        CALLS.clear()
        V2_PATHS.clear()


def calls_with(target_suffix: str) -> list[dict]:
    with LOCK:
        return [c for c in CALLS if c["target"].endswith(target_suffix)]


def catalog_list(sc: Sidecar):  # noqa: ANN201
    return sc.ok("registry/catalog", {})


def main() -> int:
    global DENY_DESCRIBE
    exe, _manifest, workdir = _harness.extract_sidecar()
    srv = Server((HOST, PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    check = _reporter.check
    sidecars: list[Sidecar] = []

    try:
        print("\nA) explicit AK/SK + session token → ECR API catalog, not _catalog")
        reset()
        sc = Sidecar(exe)
        sidecars.append(sc)
        reply = sc.connect(
            "ecr-explicit", access_key_id="AKIDEXAMPLE",
            secret_access_key="secret-example", session_token="session-example",
        )
        check("connection succeeds with explicit AWS credentials", "result" in reply, reply)
        repos = catalog_list(sc)
        check("the catalog contains every ECR repository",
              repos == ["shared/base", "single", "team-alpha/app",
                        "team-alpha/db", "team-beta/api", "team-beta/web"], repos)
        check("both DescribeRepositories pages were read",
              len(calls_with(".DescribeRepositories")) == 2, calls_with(".DescribeRepositories"))
        check("the second page request carried nextToken",
              any("page-2" in c["body"] for c in calls_with(".DescribeRepositories")),
              [c["body"] for c in calls_with(".DescribeRepositories")])
        check("/v2/_catalog was never requested",
              "/v2/_catalog" not in V2_PATHS, V2_PATHS)
        token_calls = calls_with(".GetAuthorizationToken")
        check("the ECR token was requested", len(token_calls) == 1, token_calls)
        check("the token call was SigV4-signed with the explicit key",
              token_calls and "Credential=AKIDEXAMPLE/" in token_calls[0]["authorization"],
              token_calls)
        check("the token call carried the session token",
              token_calls and token_calls[0]["session"] == "session-example", token_calls)
        describe_calls = calls_with(".DescribeRepositories")
        check("DescribeRepositories was SigV4-signed",
              describe_calls and all("Credential=AKIDEXAMPLE/" in c["authorization"] for c in describe_calls),
              describe_calls)
        check("DescribeRepositories carried the session token",
              describe_calls and all(c["session"] == "session-example" for c in describe_calls),
              describe_calls)
        namespaces = sc.ok("registry/namespaces", {})
        check("ECR repository names group into namespaces",
              [n["name"] for n in namespaces] == ["shared", "single", "team-alpha", "team-beta"],
              namespaces)
        team = sc.ok("registry/repositories", {"namespace": "team-alpha"})
        check("a namespace lists its ECR repositories",
              [r["full_name"] for r in team] == ["team-alpha/app", "team-alpha/db"], team)

        print("\nB) environment credentials are used when the form has none")
        reset()
        env_sc = Sidecar(exe, env={
            "AWS_ACCESS_KEY_ID": "ENVKEY", "AWS_SECRET_ACCESS_KEY": "ENVSECRET",
            "AWS_SESSION_TOKEN": "ENVTOKEN",
        })
        sidecars.append(env_sc)
        reply = env_sc.connect("ecr-env")
        check("connection succeeds from AWS_ACCESS_KEY_ID",
              "result" in reply, reply)
        check("the token call used the environment key",
              any("Credential=ENVKEY/" in c["authorization"] for c in calls_with(".GetAuthorizationToken")),
              calls_with(".GetAuthorizationToken"))
        check("the environment session token was sent",
              any(c["session"] == "ENVTOKEN" for c in calls_with(".GetAuthorizationToken")),
              calls_with(".GetAuthorizationToken"))
        check("the environment path also lists repositories",
              len(catalog_list(env_sc)) == 6)

        print("\nC) a named shared-profile carries keys and region")
        reset()
        profile_dir = pathlib.Path(tempfile.mkdtemp(prefix="imrepo-aws-"))
        creds = profile_dir / "credentials"
        config = profile_dir / "config"
        creds.write_text(
            "[ecrprofile]\n"
            "aws_access_key_id = PROFILEKEY\n"
            "aws_secret_access_key = PROFILESECRET\n",
            encoding="utf-8",
        )
        config.write_text("[profile ecrprofile]\nregion = us-west-2\n", encoding="utf-8")
        profile_sc = Sidecar(exe, env={
            "AWS_SHARED_CREDENTIALS_FILE": str(creds),
            "AWS_CONFIG_FILE": str(config),
        })
        sidecars.append(profile_sc)
        reply = profile_sc.connect("ecr-profile", aws_profile="ecrprofile", region="")
        check("connection succeeds from a named profile", "result" in reply, reply)
        check("the profile key signed the ECR calls",
              any("Credential=PROFILEKEY/" in c["authorization"]
                  for c in calls_with(".GetAuthorizationToken")),
              calls_with(".GetAuthorizationToken"))
        check("no session token is sent for a long-lived profile key",
              all(c["session"] == "" for c in calls_with(".DescribeRepositories")),
              calls_with(".DescribeRepositories"))
        check("the profile's region carried the request", len(catalog_list(profile_sc)) == 6)

        print("\nD) a missing ecr:DescribeRepositories permission is explained")
        reset()
        DENY_DESCRIBE = True
        try:
            denied = Sidecar(exe)
            sidecars.append(denied)
            reply = denied.connect(
                "ecr-denied", access_key_id="AKIDDENIED",
                secret_access_key="secret", region="us-east-1",
            )
            check("the connection itself still works", "result" in reply, reply)
            reply = denied.call("registry/catalog", {})
            message = (reply.get("error") or {}).get("message", "")
            check("the catalog reports the missing ECR permission",
                  "ecr:DescribeRepositories" in message, reply)
            check("/v2/_catalog was still not attempted",
                  "/v2/_catalog" not in V2_PATHS, V2_PATHS)
        finally:
            DENY_DESCRIBE = False

        print("\nE) no credentials anywhere fails clearly")
        reset()
        empty = Sidecar(exe)
        sidecars.append(empty)
        reply = empty.connect("ecr-empty", region="us-east-1")
        message = (reply.get("error") or {}).get("message", "")
        check("the connection is refused", "error" in reply, reply)
        check("the error tells the operator what to supply",
              "no credentials found" in message.lower() or "access_key_id" in message, reply)
    finally:
        for sc in sidecars:
            sc.stop()
        srv.shutdown()
        shutil.rmtree(workdir, ignore_errors=True)

    return _reporter.report()


if __name__ == "__main__":
    raise SystemExit(main())
