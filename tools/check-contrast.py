#!/usr/bin/env python3
"""WCAG contrast gate for the IMREPO workbench palette.

Why this exists: the DBX host re-injects Tailwind v4 tokens into the plugin
sandbox (any `--color-*` / `--radius*` / `--font*` we declare gets clobbered),
so the plugin owns its entire palette under the `--im-*` namespace. That makes
palette legibility a property we must verify ourselves, not one the host fixes.

Run:  python tools/check-contrast.py            (exit 0 = all pass)
      python tools/check-contrast.py --verbose  (print every pair)
"""

from __future__ import annotations

import pathlib
import re
import sys
from pathlib import Path

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import _harness  # noqa: E402,F401  (forces a UTF-8 console — see its docstring)

CSS = Path(__file__).resolve().parent.parent / "ui" / "styles.css"

# (foreground token, background token, minimum ratio)
# 4.5 = WCAG AA normal text; 3.0 = WCAG AA large text / non-text UI
TEXT_PAIRS = [
    ("--im-fg", "--im-bg", 4.5),
    ("--im-fg", "--im-surface", 4.5),
    ("--im-fg", "--im-surface-2", 4.5),
    ("--im-fg", "--im-surface-3", 4.5),
    ("--im-fg", "--im-hover", 4.5),
    ("--im-fg-muted", "--im-bg", 4.5),
    ("--im-fg-muted", "--im-surface", 4.5),
    ("--im-fg-muted", "--im-surface-2", 4.5),
    ("--im-fg-muted", "--im-surface-3", 4.5),
    ("--im-fg-muted", "--im-hover", 4.5),
    ("--im-fg-subtle", "--im-bg", 4.5),
    ("--im-fg-subtle", "--im-surface", 4.5),
    ("--im-fg-subtle", "--im-surface-2", 4.5),
    ("--im-fg-subtle", "--im-surface-3", 4.5),
    ("--im-fg-subtle", "--im-hover", 4.5),
    # accent / semantic
    ("--im-primary", "--im-bg", 4.5),
    ("--im-primary", "--im-surface", 4.5),
    ("--im-primary", "--im-surface-2", 4.5),
    ("--im-primary-fg", "--im-primary-solid", 4.5),
    ("--im-danger", "--im-bg", 4.5),
    ("--im-danger", "--im-surface-2", 4.5),
    ("--im-warning", "--im-bg", 4.5),
    ("--im-warning", "--im-surface-2", 4.5),
    ("--im-success", "--im-bg", 4.5),
    ("--im-sev-critical", "--im-bg", 4.5),
    ("--im-sev-high", "--im-bg", 4.5),
    ("--im-sev-medium", "--im-bg", 4.5),
    ("--im-sev-low", "--im-bg", 4.5),
    # inside the CVE severity boxes (22px bold -> large text)
    ("--im-sev-critical", "--im-surface-3", 3.0),
    ("--im-sev-high", "--im-surface-3", 3.0),
    ("--im-sev-medium", "--im-surface-3", 3.0),
    ("--im-sev-low", "--im-surface-3", 3.0),
    # filled buttons only need to be distinguishable from the page
    ("--im-primary-solid", "--im-bg", 3.0),
    ("--im-danger-solid", "--im-bg", 3.0),
]

# Text drawn on top of a soft tint (active tree row, badge, protected tag, ...).
TINT_PAIRS = [
    ("--im-primary", "--im-primary-soft", "--im-surface", 4.5),
    ("--im-primary", "--im-primary-soft", "--im-surface-2", 4.5),
    # protected tag chip and "outside retention" badge
    ("--im-warning", "--im-warning-soft", "--im-bg", 4.5),
    ("--im-warning", "--im-warning-soft", "--im-surface", 4.5),
    ("--im-warning", "--im-warning-soft", "--im-surface-2", 4.5),
    # eligible / within-threshold badges
    ("--im-success", "--im-success-soft", "--im-surface", 4.5),
    ("--im-success", "--im-success-soft", "--im-surface-2", 4.5),
    ("--im-danger", "--im-danger-soft", "--im-surface", 4.5),
    ("--im-danger", "--im-danger-soft", "--im-surface-2", 4.5),
    # a rule-protected cleanup row: the row is tinted and its text must survive
    ("--im-fg-muted", "--im-warning-soft", "--im-bg", 4.5),
    ("--im-fg-subtle", "--im-warning-soft", "--im-bg", 4.5),
]

THEME_BLOCKS = [
    ("LIGHT", r":root \{"),
    ("DARK", r'\[data-dbx-theme="dark"\] \{'),
]


def block(css: str, selector: str) -> str:
    m = re.search(selector, css)
    if not m:
        raise SystemExit(f"selector not found: {selector}")
    return css[m.start():css.index("}", m.start())]


def parse(text: str) -> dict[str, str]:
    return {m.group(1): m.group(2).strip() for m in re.finditer(r"(--im-[a-z0-9-]+)\s*:\s*([^;]+);", text)}


def to_rgb(value: str) -> tuple[int, ...]:
    value = value.strip()
    if value.startswith("#"):
        h = value[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    m = re.match(r"rgba?\(([^)]+)\)", value)
    if not m:
        raise ValueError(f"unsupported colour: {value}")
    parts = [p.strip() for p in m.group(1).split(",")]
    rgb = tuple(int(round(float(parts[i]))) for i in range(3))
    return rgb + ((float(parts[3]),) if len(parts) > 3 else ())


def composite(fg: str, base: str) -> tuple[int, ...]:
    f = to_rgb(fg)
    if len(f) == 3:
        return f
    b = to_rgb(base)[:3]
    a = f[3]
    return tuple(round(f[i] * a + b[i] * (1 - a)) for i in range(3))


def luminance(c: tuple[int, ...]) -> float:
    def ch(x: float) -> float:
        x /= 255
        return x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4

    r, g, b = (ch(v) for v in c[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a: tuple[int, ...], b: tuple[int, ...]) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def main() -> int:
    verbose = "--verbose" in sys.argv
    css = CSS.read_text(encoding="utf-8")

    # Guard: nothing may collide with the token prefixes the host re-injects.
    collisions = re.findall(r"^\s*--(color|radius|font)[a-z0-9-]*\s*:", css, re.M)
    if collisions:
        print(f"FAIL: {len(collisions)} variable(s) collide with host-injected "
              f"--color/--radius/--font names: {set(collisions)}")
        return 1

    failures: list[str] = []
    for name, selector in THEME_BLOCKS:
        tokens = parse(block(css, selector))
        print(f"\n=== {name} ===")
        for fg, bg, need in TEXT_PAIRS:
            got = ratio(composite(tokens[fg], tokens[bg]), to_rgb(tokens[bg])[:3])
            ok = got >= need
            if not ok:
                failures.append(f"{name}: {fg} on {bg} = {got:.2f} (need {need})")
            if verbose or not ok:
                print(f"  {'PASS' if ok else 'FAIL'}  {fg:22s} on {bg:20s} {got:5.2f} (need {need})")
        for fg, tint, bg, need in TINT_PAIRS:
            base = composite(tokens[tint], tokens[bg])
            got = ratio(to_rgb(tokens[fg])[:3], base)
            ok = got >= need
            if not ok:
                failures.append(f"{name}: {fg} on {tint} over {bg} = {got:.2f} (need {need})")
            if verbose or not ok:
                print(f"  {'PASS' if ok else 'FAIL'}  {fg:22s} on {tint}+{bg:12s} {got:5.2f} (need {need})")

    print()
    if failures:
        print(f"CONTRAST GATE FAILED ({len(failures)}):")
        for f in failures:
            print("  -", f)
        return 1
    print("CONTRAST GATE PASSED — all pairs meet WCAG AA, no host-token collisions.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
