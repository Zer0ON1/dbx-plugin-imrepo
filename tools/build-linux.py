#!/usr/bin/env python3
"""
Build Linux .dbxp packages (amd64 + arm64) with a STATICALLY LINKED Go sidecar.

The official `dbx-plugin package` CLI refuses to cross-compile ("run on the
target platform"), so the Linux packages are assembled here by hand, mirroring
the exact layout the CLI produces:

    assets/...  ui/...  manifest.json  bin/<target>/imrepo-sidecar  checksums.json

Static linking (CGO_ENABLED=0) makes the sidecar independent of the host libc,
which is what lets it run on older distros such as Kylin V10 (low glibc).

Usage:
    python tools/build-linux.py [--version 1.6.0]

Requirements:
    - Go toolchain on PATH
    - The DBX plugin SDK at <project>/../node_modules/@dbx-app/plugin-cli/sdk-root
      (or set DBX_PLUGIN_SDK_ROOT)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
DIST = ROOT / "dist"

TARGETS = {"linux-x64": "amd64", "linux-arm64": "arm64"}


def sdk_root() -> pathlib.Path:
    env = os.environ.get("DBX_PLUGIN_SDK_ROOT")
    if env:
        return pathlib.Path(env)
    candidate = ROOT.parent / "node_modules" / "@dbx-app" / "plugin-cli" / "sdk-root" / "plugins" / "sdk" / "go" / "dbx-plugin-sdk"
    if candidate.exists():
        return candidate
    sys.exit("SDK not found; set DBX_PLUGIN_SDK_ROOT")


def manifest() -> dict:
    return json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))


def build_sidecar(goarch: str, dest: pathlib.Path, sdk: pathlib.Path) -> None:
    modfile = BACKEND / "build-linux.mod"
    modfile.write_text(
        "module github.com/dbx/imrepo-dbx-plugin/backend\n\n"
        "go 1.22\n\n"
        "require github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk v0.1.0\n\n"
        f"replace github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk => {sdk.as_posix()}\n",
        encoding="utf-8",
    )
    env = dict(os.environ, CGO_ENABLED="0", GOOS="linux", GOARCH=goarch)
    # Low-memory Windows boxes: force single-package builds so the linker does
    # not exhaust the page file during cross-compilation.
    env.setdefault("GOFLAGS", "-p=1")
    subprocess.run(
        ["go", "build", "-modfile", "build-linux.mod", "-o", str(dest), "."],
        cwd=str(BACKEND), env=env, check=True,
    )
    modfile.unlink(missing_ok=True)


def file_sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def collect_files(binary: pathlib.Path, target: str) -> list[tuple[str, pathlib.Path]]:
    files: list[tuple[str, pathlib.Path]] = []
    files.append(("manifest.json", ROOT / "manifest.json"))
    for p in sorted((ROOT / "assets").iterdir()):
        if p.is_file():
            files.append((f"assets/{p.name}", p))
    # ui/: index.html, styles.css, app.js, and ui/assets/*
    for base in (ROOT / "ui").rglob("*"):
        if base.is_file():
            files.append((f"ui/{base.relative_to(ROOT / 'ui').as_posix()}", base))
    files.append((f"bin/{target}/imrepo-sidecar", binary))
    return files


def package(target: str, goarch: str, version: str, sdk: pathlib.Path) -> None:
    DIST.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        binary = tmp / "imrepo-sidecar"
        build_sidecar(goarch, binary, sdk)

        files = collect_files(binary, target)
        checksums = {"algorithm": "sha256", "files": {}}
        out = DIST / f"com.dbx.plugin.imrepo-{version}-{target}.dbxp"
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for arcname, path in files:
                z.write(path, arcname)
                checksums["files"][arcname] = file_sha256(path)
            z.writestr("checksums.json", json.dumps(checksums, indent=2))

        size = out.stat().st_size
        artifact = DIST / f"com.dbx.plugin.imrepo-{version}-{target}.artifact.json"
        artifact.write_text(json.dumps({
            "target": target,
            "url": out.name,
            "sha256": file_sha256(out),
            "size": size,
        }, indent=2) + "\n", encoding="utf-8")
        print(f"built {out.name} ({size} bytes)")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default=None)
    args = parser.parse_args()

    version = args.version or manifest()["version"]
    sdk = sdk_root()
    print(f"sdk: {sdk}")
    for target, goarch in TARGETS.items():
        package(target, goarch, version, sdk)
    return 0


if __name__ == "__main__":
    sys.exit(main())
