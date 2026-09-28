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


# ---------------------------------------------------------------------------
# State overrides
# ---------------------------------------------------------------------------
# A static token-pair check cannot see a state rule that repaints a component
# whose text colour does not move with it — and that is not hypothetical.
# `.btn:hover` (specificity 0,2,0) outranked `.btn-primary` (0,1,0), so hovering
# a filled button painted the neutral hover grey under white text: every solid
# button went blank under the pointer while every individual token pair still
# measured fine. This walks the real class combinations from the UI and applies
# the same cascade the browser does: base rules and state rules compete on
# specificity, ties go to whichever comes last.
UI_DIR = CSS.parent
CLASS_ATTR = re.compile(r'class="([^"]+)"')
EL_CLASSES = re.compile(r'IM\.el\(\s*"[a-z]+"\s*,\s*"([^"]+)"')
RULE = re.compile(r"([^{}]+)\{([^{}]*)\}")
COMPONENT_SELECTOR = re.compile(r"^\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*(?::(hover|focus-visible|focus|active))?$")
STATES = ("hover", "focus-visible", "focus", "active")
TOKEN_REF = re.compile(r"var\((--im-[a-z0-9-]+)\)")

PROPS_TO_CHECK = (("color", "background"), ("color", "background-color"))


def strip_comments(css: str) -> str:
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def ui_class_combinations() -> set[frozenset[str]]:
    """The class sets the UI actually puts on a single element.

    Derived from the source rather than guessed: an element carrying both `.btn`
    and `.btn-primary` is exactly what makes the two rules interact.
    """
    combos: set[frozenset[str]] = set()
    sources = [UI_DIR / "index.html"] + sorted((UI_DIR / "js").glob("*.js"))
    for path in sources:
        text = path.read_text(encoding="utf-8")
        for group in CLASS_ATTR.findall(text) + EL_CLASSES.findall(text):
            combos.add(frozenset(group.split()))
    return {c for c in combos if c}


def parse_rules(css: str) -> list[tuple[frozenset[str], str | None, int, int, dict[str, str]]]:
    """Class-only component rules as (classes, state, specificity, order, decls)."""
    rules = []
    for order, (selector, body) in enumerate(RULE.findall(strip_comments(css))):
        match = COMPONENT_SELECTOR.match(selector.strip())
        if not match:
            continue
        state = match.group(1)
        classes = frozenset(re.findall(r"\.([a-z][a-z0-9-]*)", selector))
        decls = {
            prop: value.strip()
            for prop, value in re.findall(r"([a-z-]+)\s*:\s*([^;]+);", body + ";")
            if prop in ("color", "background", "background-color")
        }
        if decls:
            rules.append((classes, state, len(classes) + (1 if state else 0), order, decls))
    return rules


def effective(rules, combo: frozenset[str], prop: str, state: str | None) -> str | None:
    """The declaration that wins for `prop` on `combo` in `state`.

    Base rules always apply; a state rule applies on top of them. Both compete on
    (specificity, source order), which is what decides the browser's answer too.
    """
    best_key, best_value = None, None
    for classes, rule_state, spec, order, decls in rules:
        if prop not in decls or not classes <= combo:
            continue
        if rule_state is not None and rule_state != state:
            continue
        key = (spec, order)
        if best_key is None or key >= best_key:
            best_key, best_value = key, decls[prop]
    return best_value


def token_colour(value: str | None, tokens: dict[str, str]) -> str | None:
    if not value:
        return None
    ref = TOKEN_REF.search(value)
    if ref:
        return tokens.get(ref.group(1))
    return value if value.startswith("#") else None


def state_failures(css: str, tokens: dict[str, str]) -> list[str]:
    rules = parse_rules(css)
    problems = []
    for combo in sorted(ui_class_combinations(), key=lambda c: sorted(c)):
        for state in STATES:
            if not any(s == state and c <= combo for c, s, _, _, _ in rules):
                continue
            for fg_prop, bg_prop in PROPS_TO_CHECK:
                fg = token_colour(effective(rules, combo, "color", state), tokens)
                bg = token_colour(effective(rules, combo, bg_prop, state), tokens)
                if not fg or not bg:
                    continue
                # A soft tint is rgba(); measuring it directly compares it with
                # its own hue and reads ~1.0. Composite it over the page first,
                # exactly as the tint pairs above do.
                base = tokens.get("--im-bg", "#ffffff")
                got = ratio(composite(fg, base)[:3], composite(bg, base)[:3])
                if got < 4.5:
                    label = " ".join(sorted(combo))
                    problems.append(
                        f":{state} on [{label}] = {got:.2f} ({fg} on {bg}, need 4.5)")
                    break   # one report per combo/state, not per property alias
    return problems


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

        # Regression guard for state rules that repaint a filled component.
        for problem in state_failures(css, tokens):
            failures.append(f"{name}: {problem}")
            print(f"  FAIL  {problem}")

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
