#!/usr/bin/env python3
"""Build .dbxp candidate packages for every supported platform from one machine.

Why this exists
---------------
`dbx-plugin package .` refuses to cross-compile (it only ever emits a package
for the host it runs on), so a Windows-only package was the norm and the Linux
ones were hand-assembled. Go cross-compiles trivially with CGO_ENABLED=0, so
this script builds all six targets from any host and mirrors the layout the
official CLI produces:

    manifest.json  assets/...  ui/...  bin/<target>/<sidecar>  checksums.json

Two things the official CLI does that a naive zip does NOT, and that matter:

  1. `entrypoints.backend.executable` is REWRITTEN per target. The source
     manifest points at `bin/imrepo-sidecar`; an installed package must point
     at `bin/<target>/imrepo-sidecar[.exe]`. Miss this and the package installs
     but the host has no executable to launch. (The sidecar e2e tests never
     catch it: they extract the binary themselves. `_harness.package_layout_errors`
     is the regression guard.)
  2. `checksums.json` must cover the bytes actually written, so it is computed
     while packaging rather than from the source tree.

Also emitted: one `<package>.artifact.json` per target and a combined
`release-candidates.json` — the manifest dbx-store's auto-update workflow reads
from a GitHub Release.

Usage:
    python tools/build-packages.py                  # all six targets
    python tools/build-packages.py -t linux-x64     # one target
    python tools/build-packages.py --skip-missing-go
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

# target -> (GOOS, GOARCH). Every target ships a statically linked sidecar
# (CGO_ENABLED=0) so it does not depend on the host's libc — that is what lets
# a binary run on older distros such as Kylin V10 (low glibc).
TARGETS: dict[str, tuple[str, str]] = {
    "windows-x64": ("windows", "amd64"),
    "windows-arm64": ("windows", "arm64"),
    "linux-x64": ("linux", "amd64"),
    "linux-arm64": ("linux", "arm64"),
    "darwin-x64": ("darwin", "amd64"),
    "darwin-arm64": ("darwin", "arm64"),
}

SIDECAR = "imrepo-sidecar"


def manifest() -> dict:
    return json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))


def sdk_root() -> pathlib.Path:
    """Locate the bundled Go SDK (shipped inside the plugin CLI npm package)."""
    candidates = []
    if os.environ.get("DBX_PLUGIN_SDK_ROOT"):
        candidates.append(pathlib.Path(os.environ["DBX_PLUGIN_SDK_ROOT"]))
    rel = pathlib.Path("node_modules/@dbx-app/plugin-cli/sdk-root/plugins/sdk/go/dbx-plugin-sdk")
    # repo-local install first (what a fresh clone gets), then the legacy layout
    # used while the plugin lived in a subdirectory of a larger workspace.
    candidates += [ROOT / rel, ROOT.parent / rel]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    sys.exit(
        "Go SDK not found. Run `npm install` in the repository root (it installs\n"
        "@dbx-app/plugin-cli, which bundles the SDK), or set DBX_PLUGIN_SDK_ROOT."
    )


def sidecar_filename(target: str) -> str:
    return f"{SIDECAR}.exe" if target.startswith("windows") else SIDECAR


def packaged_manifest(target: str) -> bytes:
    """The manifest as it must appear inside the package for this target."""
    data = manifest()
    data["entrypoints"]["backend"]["executable"] = f"bin/{target}/{sidecar_filename(target)}"
    return (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def build_sidecar(goos: str, goarch: str, dest: pathlib.Path, sdk: pathlib.Path) -> None:
    # The SDK is resolved through a generated -modfile so the checked-in go.mod
    # keeps its upstream module path (no go.sum churn, no network access).
    modfile = BACKEND / "build-packages.mod"
    modfile.write_text(
        "module github.com/dbx/imrepo-dbx-plugin/backend\n\n"
        "go 1.22\n\n"
        "require github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk v0.1.0\n\n"
        f"replace github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk => {sdk.as_posix()}\n",
        encoding="utf-8",
    )
    env = dict(os.environ, CGO_ENABLED="0", GOOS=goos, GOARCH=goarch,
               GOFLAGS=os.environ.get("GOFLAGS", "-p=1"), GOPROXY="off")
    try:
        subprocess.run(
            ["go", "build", "-modfile", modfile.name, "-trimpath", "-o", str(dest), "."],
            cwd=str(BACKEND), env=env, check=True,
        )
    except FileNotFoundError:
        sys.exit("the `go` toolchain is not on PATH — install Go 1.22+ to build packages")
    finally:
        modfile.unlink(missing_ok=True)


def file_sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sources(target: str, binary: pathlib.Path) -> list[tuple[str, bytes]]:
    """(archive path, bytes) for everything that goes into a package.

    Mirrors dbx-plugin.toml's [package].include = ["assets", "ui"] plus the
    manifest and the sidecar. Bytes (not paths) because the manifest is
    rewritten and the checksum must match what is written.
    """
    entries: list[tuple[str, bytes]] = [("manifest.json", packaged_manifest(target))]
    for directory in ("assets", "ui"):
        for path in sorted((ROOT / directory).rglob("*")):
            if path.is_file():
                entries.append((path.relative_to(ROOT).as_posix(), path.read_bytes()))
    entries.append((f"bin/{target}/{sidecar_filename(target)}", binary.read_bytes()))
    return entries


def build_target(target: str, goos: str, goarch: str, sdk: pathlib.Path,
                 version: str, url_prefix: str) -> dict:
    DIST.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmpdir:
        binary = pathlib.Path(tmpdir) / sidecar_filename(target)
        build_sidecar(goos, goarch, binary, sdk)

        entries = sources(target, binary)
        checksums = {
            "algorithm": "sha256",
            "files": {name: hashlib.sha256(blob).hexdigest() for name, blob in entries},
        }
        package = DIST / f"com.dbx.plugin.imrepo-{version}-{target}.dbxp"
        with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, blob in entries:
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.external_attr = 0o644 << 16
                if name.startswith("bin/"):
                    # the host must be able to execute the extracted sidecar
                    info.external_attr = 0o755 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, blob)
            archive.writestr("checksums.json", json.dumps(checksums, indent=2) + "\n")

    artifact = {
        "target": target,
        "url": f"{url_prefix}{package.name}",
        "sha256": file_sha256(package),
        "size": package.stat().st_size,
    }
    (DIST / f"{package.name[:-5]}.artifact.json").write_text(
        json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    print(f"  built {package.name} ({artifact['size']:,} bytes)")
    return artifact


def main() -> int:
    parser = argparse.ArgumentParser(description="Build DBX plugin packages for all targets.")
    parser.add_argument("-t", "--target", action="append", choices=sorted(TARGETS),
                        help="build only this target (repeatable); default: all")
    parser.add_argument("--version", default=None, help="default: manifest version")
    parser.add_argument("--url-prefix", default="",
                        help="prefix for artifact URLs, e.g. a release download base URL")
    args = parser.parse_args()

    version = args.version or manifest()["version"]
    wanted = args.target or list(TARGETS)
    sdk = sdk_root()
    print(f"IMREPO {version}: building {len(wanted)} target(s)\n  sdk: {sdk}")

    artifacts = [build_target(t, *TARGETS[t], sdk, version, args.url_prefix) for t in wanted]

    meta = manifest()
    candidates = {
        "plugin": {
            "id": meta["id"],
            "name": meta["name"],
            "description": meta["description"],
            "publisher": meta["publisher"],
            "version": version,
            "permissions": meta.get("permissions", []),
        },
        "artifacts": sorted(artifacts, key=lambda a: a["target"]),
    }
    out = DIST / "release-candidates.json"
    out.write_text(json.dumps(candidates, indent=2) + "\n", encoding="utf-8")
    print(f"\nwrote {out.name} ({len(artifacts)} artifact(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
