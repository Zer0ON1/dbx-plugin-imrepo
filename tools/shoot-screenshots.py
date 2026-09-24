#!/usr/bin/env python3
"""Regenerate the README screenshots from the real workbench.

Screenshots drift: the UI gains a column, the committed PNGs keep showing the
old one, and nobody notices until a reviewer does. Regenerating them from
.preview/preview.html makes them a build product of the actual source rather
than something a person once captured — so they can be refreshed (and reviewed
as a diff) with one command.

Each shot is a (name, query) pair; the query is the same harness switch the UI
tests use, which is why a shot can show a dialog or the dark theme without any
extra plumbing.

Usage:
    python3 tools/make-preview.py
    python3 tools/shoot-screenshots.py [--out docs/screenshots] [--list]

Requires a Chromium-based browser (see _harness.find_browser; CHROME_HEADLESS_SHELL
overrides). On a machine without CJK fonts, export XDG_DATA_HOME pointing at a
directory whose fonts/ has one, or the Chinese labels render as boxes.
"""

from __future__ import annotations

import argparse
import pathlib
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import _harness  # noqa: E402  (needs the path fix above)

ROOT = _harness.ROOT
PREVIEW = ROOT / ".preview" / "preview.html"

# name -> harness query. Keep the list ordered: it is the order they appear in
# the README's gallery.
SHOTS: dict[str, str] = {
    "harbor-artifacts": "theme=light",
    "v2-namespaces": "mode=docker&theme=light",
    "layers": "modal=layers&theme=light",
    "cleanup": "modal=cleanup&rules=1&theme=light",
    "vulnerabilities": "modal=vuln&threshold=high&theme=light",
    "overview-harbor": "overviewtab=1&theme=light",
    "overview-v2": "mode=docker&overviewtab=1&theme=light",
    "project-settings": "projectsettings=1&theme=light",
    "settings": "modal=settings&theme=light",
    "dark": "mode=docker&theme=dark",
}

WINDOW = "1360,880"
# Virtual time to let the mocked RPCs settle and the UI paint. Generous because
# a shot that captures a spinner is worse than a slow one.
BUDGET_MS = 9000


def shoot(browser: str, name: str, query: str, out_dir: pathlib.Path, workdir: pathlib.Path) -> bool:
    # A fresh profile per shot: a reused one can silently fail to start.
    profile = workdir / name
    target = out_dir / f"{name}.png"
    proc = subprocess.run(
        [
            browser, "--headless=new", "--disable-gpu", "--no-sandbox",
            "--hide-scrollbars", "--force-device-scale-factor=1",
            f"--window-size={WINDOW}", f"--virtual-time-budget={BUDGET_MS}",
            f"--user-data-dir={profile}", f"--screenshot={target}",
            f"file://{PREVIEW.as_posix()}?{query}",
        ],
        capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=180,
    )
    if not target.exists() or target.stat().st_size == 0:
        print(f"  FAILED {name}: {proc.stderr.strip()[:200]}")
        return False
    print(f"  {name:<20} {target.stat().st_size:>8,} bytes   ?{query}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(ROOT / "docs" / "screenshots"))
    parser.add_argument("--list", action="store_true", help="print the shot list and exit")
    args = parser.parse_args()

    if args.list:
        for name, query in SHOTS.items():
            print(f"{name:<20} ?{query}")
        return 0

    if not PREVIEW.exists():
        sys.exit("preview harness missing — run: python3 tools/make-preview.py")
    browser = _harness.find_browser()
    if not browser:
        sys.exit("no Chromium-based browser found (set CHROME_HEADLESS_SHELL)")

    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    workdir = pathlib.Path(tempfile.mkdtemp(prefix="imrepo-shots-"))
    print(f"browser: {browser}\nout:     {out_dir}")
    try:
        failed = [name for name, query in SHOTS.items()
                  if not shoot(browser, name, query, out_dir, workdir)]
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    if failed:
        print(f"\n{len(failed)} shot(s) failed: {', '.join(failed)}")
        return 1
    print(f"\n{len(SHOTS)} screenshots written to {out_dir.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
