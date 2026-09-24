#!/usr/bin/env python3
"""Gate: the workbench UI stays usable on the oldest browser DBX supports.

A sandbox UI runs inside whatever engine the host has. Feature *detection* is
not available to CSS — an unsupported property or function is simply dropped —
so a stylesheet written on a modern Chrome degrades quietly for anyone on an
older one: a colour falls back to nothing, a layout rule never applies, and
nobody notices because nobody tests on the floor version.

DBX supports Chrome 109 (January 2023). Anything that landed after it must
either be avoided or come with a fallback that does the same job, and that
choice has to be visible — hence the ACKNOWLEDGED list below. Adding a newer
feature means adding a line here saying why it is safe, which is deliberate
friction rather than a prohibition.

This is a static check, not a render: it cannot prove the layout looks right on
109, only that the code does not reach for something 109 does not have.

Usage:  python3 tools/check-browser-baseline.py [--verbose]     (exit 0 = clean)
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import _harness  # noqa: E402  (forces a UTF-8 console — see its docstring)

ROOT = _harness.ROOT
UI = ROOT / "ui"

# The oldest engine the plugin must work in.
BASELINE = 109

CSS = "css"
JS = "js"

# name -> (kind, pattern, minimum Chrome version). The versions are the
# "Chrome" entries of MDN's browser-compat data; the list is deliberately wider
# than what the stylesheet uses today so that a feature can be added later
# without the gate silently not knowing about it.
FEATURES: list[tuple[str, str, str, int]] = [
    # ---- CSS: layout & selectors ----
    ("gap (flexbox)", CSS, r"(?<![\w-])(?:row-|column-)?gap\s*:", 84),
    ("aspect-ratio", CSS, r"(?<![\w-])aspect-ratio\s*:", 88),
    (":is() / :where()", CSS, r":(?:is|where)\(", 88),
    (":has()", CSS, r":has\(", 105),
    ("@container", CSS, r"@container\b", 105),
    (":nth-child(An+B of S)", CSS, r":nth-(?:child|last-child)\([^)]*\bof\b", 111),
    ("subgrid", CSS, r"grid-template-[a-z-]*\s*:[^;]*\bsubgrid\b", 117),
    (":user-valid / :user-invalid", CSS, r":user-(?:valid|invalid)\b", 119),
    (":autofill", CSS, r":autofill\b", 110),
    # ---- CSS: values & functions ----
    ("dvh / svh / lvh units", CSS, r"\d(?:dvh|svh|lvh|dvw|svw|lvw)\b", 108),
    ("color-mix()", CSS, r"color-mix\(", 111),
    ("oklch() / oklab() / lab() / lch()", CSS, r"\b(?:oklch|oklab|lab|lch)\(", 111),
    ("light-dark()", CSS, r"light-dark\(", 123),
    ("individual transform properties", CSS, r"(?<![\w-])(?:translate|rotate|scale)\s*:", 104),
    ("text-wrap: balance/pretty", CSS, r"text-wrap\s*:\s*(?:balance|pretty)", 114),
    ("scrollbar-width / scrollbar-color", CSS, r"(?<![\w-])scrollbar-(?:width|color)\s*:", 121),
    ("scrollbar-gutter", CSS, r"(?<![\w-])scrollbar-gutter\s*:", 94),
    ("unprefixed mask-image", CSS, r"(?<![\w-])mask(?:-image)?\s*:", 120),
    ("unprefixed background-clip: text", CSS, r"(?<![\w-])background-clip\s*:\s*text", 120),
    ("unprefixed line-clamp", CSS, r"(?<![\w-])line-clamp\s*:", 130),
    ("field-sizing", CSS, r"(?<![\w-])field-sizing\s*:", 123),
    ("@starting-style", CSS, r"@starting-style\b", 117),
    ("@scope", CSS, r"@scope\b", 118),
    ("view transitions", CSS, r"view-transition-name\s*:|startViewTransition", 111),
    ("anchor positioning", CSS, r"\banchor\(|position-anchor\s*:", 125),
    # ---- JS ----
    (".toSorted/.toReversed/.toSpliced/.with", JS, r"\.(?:toSorted|toReversed|toSpliced|with)\(", 110),
    ("Object.groupBy / Map.groupBy", JS, r"\b(?:Object|Map)\.groupBy\(", 117),
    ("Promise.withResolvers", JS, r"\bPromise\.withResolvers\(", 119),
    ("Array.fromAsync", JS, r"\bArray\.fromAsync\(", 121),
    ("URL.canParse", JS, r"\bURL\.canParse\(", 120),
    ("String.prototype.isWellFormed/toWellFormed", JS, r"\.(?:isWellFormed|toWellFormed)\(", 111),
    ("Set.prototype set operations", JS,
     r"\.(?:union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(", 122),
    ("Iterator helpers", JS, r"\.(?:map|filter|take|drop|flatMap)\(\s*\([^)]*\)\s*=>[^)]*\)\.(?:next|toArray)\(", 122),
    ("RegExp v flag", JS, r"/[^/\n]*\[[^\]]*\][^/\n]*/v", 112),
]

# Post-baseline features that are used on purpose, each with the fallback that
# makes them safe on the floor version. Every entry is a claim someone can check.
ACKNOWLEDGED = {
    "scrollbar-width / scrollbar-color": (
        "the ::-webkit-scrollbar rules right below them style the same scrollbar "
        "on anything older (Chrome 4+), so 109 loses nothing but the modern spelling"
    ),
}


def scan() -> tuple[dict[str, list[str]], dict[str, int]]:
    """Feature name -> where it was found; plus how many were checked."""
    sources = {
        CSS: [UI / "styles.css", UI / "index.html"],
        JS: sorted((UI / "js").glob("*.js")),
    }
    found: dict[str, list[str]] = {}
    checked = 0
    for name, kind, pattern, _min in FEATURES:
        checked += 1
        rx = re.compile(pattern, re.MULTILINE)
        hits = []
        for path in sources[kind]:
            if not path.exists():
                continue
            for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if rx.search(line):
                    hits.append(f"{path.relative_to(ROOT)}:{line_no}")
        if hits:
            found[name] = hits
    return found, {"checked": checked}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verbose", action="store_true", help="list every feature checked")
    args = parser.parse_args()

    found, stats = scan()
    violations, acknowledged, fine = [], [], []
    for name, _kind, _pattern, minimum in FEATURES:
        if name not in found:
            continue
        if minimum <= BASELINE:
            fine.append((name, minimum))
        elif name in ACKNOWLEDGED:
            acknowledged.append((name, minimum))
        else:
            violations.append((name, minimum))

    print(f"baseline: Chrome {BASELINE} (the oldest engine DBX supports)")
    print(f"scanned:  ui/styles.css, ui/index.html, ui/js/*.js — {stats['checked']} features")
    if args.verbose:
        for name, minimum in fine:
            print(f"  [ok]  {name:<42} Chrome {minimum}")

    for name, minimum in acknowledged:
        print(f"  [ack] {name:<42} Chrome {minimum}")
        print(f"        fallback: {ACKNOWLEDGED[name]}")
        for loc in found[name]:
            print(f"        at {loc}")

    if violations:
        print(f"\nBROWSER BASELINE FAILED — {len(violations)} feature(s) newer than Chrome {BASELINE}:")
        for name, minimum in violations:
            print(f"  - {name} (Chrome {minimum}) at {', '.join(found[name])}")
        print("\nEither stop using it, provide a fallback and record it in ACKNOWLEDGED,")
        print("or raise BASELINE once DBX's floor moves.")
        return 1

    tail = f", {len(acknowledged)} acknowledged with a fallback" if acknowledged else ""
    print(f"\nBROWSER BASELINE PASSED — nothing newer than Chrome {BASELINE}{tail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
