#!/usr/bin/env python3
"""Shared plumbing for the IMREPO end-to-end tests.

Every e2e test needs the same four things, and each used to carry its own copy
of them (five copies that drifted apart):

  * which packaged sidecar to run — the .dbxp target follows the HOST platform,
    so a Windows developer and a Linux CI runner each test their own package;
  * a config directory the sidecar cannot escape — the suite must never read or
    write the developer's real settings;
  * assertion bookkeeping that reports how many checks actually ran, because a
    hand-copied count in the README drifts silently;
  * (UI only) a Chromium-based browser to render the workbench.

Nothing here touches the network or the repo; it only prepares a temp dir.
"""

from __future__ import annotations

import glob
import json
import os
import pathlib
import platform
import shutil
import sys
import tempfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"


def force_utf8_console() -> None:
    """Make stdout/stderr UTF-8 regardless of the platform's default.

    Windows consoles default to a legacy code page (cp1252), and printing any
    character outside it — the arrows and check marks these tools use, or the
    Chinese that comes back from fixtures — raises UnicodeEncodeError and kills
    the run mid-suite. That looks like a product failure and is not one.

    Called on import so every tool that imports this module is covered; the few
    that do not import it call it explicitly.
    """
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


force_utf8_console()

# .dbxp target names use x64/arm64, Python reports x86_64/aarch64.
_ARCH = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}


def host_target() -> str:
    """The .dbxp target matching this machine, e.g. 'linux-x64' or 'windows-x64'."""
    if sys.platform.startswith("win"):
        osname = "windows"
    elif sys.platform == "darwin":
        osname = "darwin"
    else:
        osname = "linux"
    machine = platform.machine().lower()
    return f"{osname}-{_ARCH.get(machine, machine)}"


def sidecar_name(target: str) -> str:
    """Filename of the sidecar inside a package of that target."""
    return "imrepo-sidecar.exe" if target.startswith("windows") else "imrepo-sidecar"


def find_package(target: str | None = None) -> pathlib.Path:
    """Newest .dbxp in dist/ for a target (defaults to this host's target)."""
    target = target or host_target()
    packages = glob.glob(str(DIST / f"*-{target}.dbxp"))
    if not packages:
        raise SystemExit(
            f"no {target} package in dist/ — build one first:\n"
            f"  python tools/build-packages.py            (all targets, no Go cross-toolchain needed)"
        )
    return pathlib.Path(max(packages, key=os.path.getmtime))


def extract_sidecar(target: str | None = None) -> tuple[pathlib.Path, dict, pathlib.Path]:
    """Unpack the packaged sidecar of this host's target into a temp dir.

    Returns (executable, manifest, workdir). The *packaged* binary is what runs,
    so the tests exercise the artefact users actually install — including the
    manifest-driven entry path, which is asserted separately by
    `package_layout_errors`.
    """
    target = target or host_target()
    package = find_package(target)
    print(f"package under test: {package.name}")

    work = pathlib.Path(tempfile.mkdtemp(prefix="imrepo-e2e-"))
    inner = f"bin/{target}/{sidecar_name(target)}"
    with zipfile.ZipFile(package) as z:
        member = z.read(inner)
        exe = work / sidecar_name(target)
        exe.write_bytes(member)
        exe.chmod(0o755)
        (work / "manifest.json").write_bytes(z.read("manifest.json"))
        manifest = json.loads(z.read("manifest.json"))
    return exe, manifest, work


def package_layout_errors(package: pathlib.Path) -> list[str]:
    """Check the packaged manifest actually points at the packaged binary.

    Regression guard for a real bug: hand-assembled packages shipped the binary
    at bin/<target>/... while manifest.json still said bin/<name>, so the host
    had no executable to launch. The sidecar tests never noticed, because they
    extract the binary themselves and run it directly.
    """
    errors: list[str] = []
    with zipfile.ZipFile(package) as z:
        names = set(z.namelist())
        manifest = json.loads(z.read("manifest.json"))

    entry = ((manifest.get("entrypoints") or {}).get("backend") or {}).get("executable")
    if not entry:
        errors.append("manifest declares no entrypoints.backend.executable")
    elif entry not in names:
        errors.append(f"manifest backend.executable {entry!r} is not a file in the package")
    elif entry != entry.replace("\\", "/"):
        errors.append(f"manifest backend.executable {entry!r} is not a forward-slash path")

    ui_root = ((manifest.get("entrypoints") or {}).get("ui") or {}).get("entry")
    if ui_root and ui_root not in names:
        errors.append(f"manifest ui.entry {ui_root!r} is not a file in the package")
    return errors


def isolated_env() -> dict:
    """Environment that redirects the sidecar's config dir into a temp dir.

    Go's os.UserConfigDir() reads %AppData% on Windows and $XDG_CONFIG_HOME
    (else ~/.config) elsewhere, so both are set. HOME is redirected too because
    the fallback path must not reach the real one.
    """
    cfg = pathlib.Path(tempfile.mkdtemp(prefix="imrepo-cfg-"))
    return dict(
        os.environ,
        APPDATA=str(cfg),
        LOCALAPPDATA=str(cfg),
        USERPROFILE=str(cfg),
        XDG_CONFIG_HOME=str(cfg),
        HOME=str(cfg),
    )


_BROWSER_CANDIDATES = [
    # explicit override wins, then per-platform well-known locations, then PATH.
    # The macOS paths matter for CI: GitHub's macOS runners ship Chrome, not
    # Edge, and an unfound browser makes the UI suite skip rather than fail.
    os.environ.get("CHROME_HEADLESS_SHELL", ""),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/microsoft-edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]

_BROWSER_NAMES = ("chrome-headless-shell", "microsoft-edge", "chromium", "chromium-browser",
                  "google-chrome", "google-chrome-stable", "chrome")


def find_browser() -> str | None:
    """A Chromium-based browser able to run --headless --dump-dom."""
    for path in _BROWSER_CANDIDATES:
        if path and pathlib.Path(path).exists():
            return path
    for name in _BROWSER_NAMES:
        found = shutil.which(name)
        if found:
            return found
    return None


class Reporter:
    """Collects assertions and prints a machine-checkable summary.

    The reported count is the number of checks that really executed, so the
    numbers in the README can be re-derived by running the suite instead of
    being trusted.
    """

    def __init__(self, title: str):
        self.title = title
        self.failures: list[str] = []
        self.checks_run = 0

    def check(self, label: str, ok: bool, detail: object = "") -> None:
        self.checks_run += 1
        suffix = f"\n        {detail}" if detail and not ok else ""
        print(f"  [{'PASS' if ok else 'FAIL'}] {label}{suffix}")
        if not ok:
            self.failures.append(label)

    def report(self) -> int:
        """Print the summary; returns the process exit code."""
        print()
        if self.failures:
            print(f"RESULT: {len(self.failures)} of {self.checks_run} CHECK(S) FAILED")
            for failure in self.failures:
                print("  -", failure)
            return 1
        print(f"RESULT: ALL PASS ({self.checks_run} checks)")
        return 0
