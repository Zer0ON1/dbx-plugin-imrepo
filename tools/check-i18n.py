#!/usr/bin/env python3
"""Gate: every translation key used by the UI exists, in both locales.

A missing key does not throw — `t()` falls back to returning the key itself, so
the workbench renders the literal string "project.accessDesc" where the hint
should be. It looks like a styling glitch rather than a bug, and only in one
corner of one dialog, which is exactly why it survives a manual pass.

The DOM-level test only spots the keys it happens to assert on. This checks all
of them, statically:

  * keys the markup asks for      — data-i18n / data-i18n-placeholder attributes
  * keys the scripts ask for      — t("...") / IM.t("...") calls
  * keys the dictionary defines   — the two I18N blocks in ui/js/i18n.js

and reports three kinds of defect: used-but-undefined, defined-but-unused, and
defined in one locale but not the other.

Usage:  python3 tools/check-i18n.py [--verbose]     (exit 0 = clean)
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX = ROOT / "ui" / "index.html"
I18N = ROOT / "ui" / "js" / "i18n.js"
SCRIPTS = sorted((ROOT / "ui" / "js").glob("*.js"))

# key: "value"  — the dictionary entries. Single-word keys are written unquoted
# (they are valid JS identifiers) while dotted ones are quoted, so the quotes are
# optional here; missing that detail made the parser see only two thirds of the
# dictionary and report every single-word key as undefined.
ENTRY = re.compile(r'["\']?([a-zA-Z][\w]*(?:\.[\w]+)*)["\']?\s*:\s*"')
# t("key") / IM.t('key'). A key ending in "." is a prefix built dynamically
# (t("role." + id)), which cannot be resolved statically — see DYNAMIC_PREFIX.
CALL = re.compile(r"""\b(?:IM\.)?t\(\s*["']([^"']+)["']""")
ATTR = re.compile(r'data-i18n(?:-placeholder)?="([^"]+)"')
# Keys the code assembles at runtime, e.g. t("role." + roleId). Listed so the
# "defined but unused" report does not flag their members as dead.
DYNAMIC_PREFIXES = ("role.", "settings.sev.")

LOCALES = ("zh-CN", "en")


def dictionary_blocks() -> dict[str, set[str]]:
    """Split i18n.js into its per-locale key sets."""
    text = I18N.read_text(encoding="utf-8")
    # Each locale is one (fairly long) object literal; find its span by locating
    # the locale marker and taking everything up to the next marker.
    positions = []
    for locale in LOCALES:
        marker = re.search(rf'["\']?{re.escape(locale)}["\']?\s*:\s*\{{', text)
        if not marker:
            sys.exit(f"i18n.js: could not find the {locale} dictionary")
        positions.append((locale, marker.end()))
    positions.append(("__end__", len(text)))

    keys: dict[str, set[str]] = {}
    for i, (locale, start) in enumerate(positions[:-1]):
        end = positions[i + 1][1]
        keys[locale] = set(ENTRY.findall(text[start:end]))
    return keys


QUOTED = re.compile(r"""["']([a-zA-Z][\w]*(?:\.[\w]+)*)["']""")


def mentioned_keys(keys: set[str]) -> set[str]:
    """Dictionary keys that appear as a string literal anywhere in the UI.

    Some call sites cannot be seen by the CALL pattern — a key passed as an
    argument (linkList("ov.namespaces", ...)) or picked inside a conditional
    (t(mode === "harbor" ? "a" : "b")). For the *unused* report that distinction
    does not matter: if the literal is in the source, the key is not dead weight.
    The pass/fail check below still uses the precise patterns, so a mis-detected
    call cannot mask a genuinely missing key.
    """
    found: set[str] = set()
    sources = [INDEX] + [p for p in SCRIPTS if p != I18N]
    for path in sources:
        found |= {k for k in QUOTED.findall(path.read_text(encoding="utf-8")) if k in keys}
    return found


def used_keys() -> dict[str, set[str]]:
    """Every key the markup and scripts ask for."""
    used: dict[str, set[str]] = {}
    html = INDEX.read_text(encoding="utf-8")
    used[str(INDEX.relative_to(ROOT))] = set(ATTR.findall(html))
    for script in SCRIPTS:
        if script == I18N:
            continue
        found = {k for k in CALL.findall(script.read_text(encoding="utf-8"))
                 if not k.endswith(".")}
        if found:
            used[str(script.relative_to(ROOT))] = found
    return used


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verbose", action="store_true", help="list every key checked")
    args = parser.parse_args()

    defined = dictionary_blocks()
    used = used_keys()
    all_used = set().union(*used.values()) if used else set()

    # Self-check before trusting the verdict. A refactor of i18n.js could break
    # the parser above, and a parser that finds too few *defined* keys reports
    # every used key as missing (loud and obvious), but one that finds too few
    # *used* keys passes silently — which is how a gate rots. Bail out instead.
    floor = 200
    for locale in LOCALES:
        if len(defined[locale]) < floor:
            sys.exit(
                f"i18n.js: parsed only {len(defined[locale])} {locale} keys (expected >= {floor}).\n"
                "The dictionary shape probably changed — fix this parser rather than trusting the result."
            )

    failures: list[str] = []

    missing = {k for k in all_used if k not in defined["zh-CN"] or k not in defined["en"]}
    for key in sorted(missing):
        where = ", ".join(sorted(f for f, ks in used.items() if key in ks))
        lacks = [loc for loc in LOCALES if key not in defined[loc]]
        failures.append(f"'{key}' is used in {where} but missing from {', '.join(lacks)}")

    asymmetric = (defined["zh-CN"] ^ defined["en"])
    for key in sorted(asymmetric):
        lacks = [loc for loc in LOCALES if key not in defined[loc]]
        failures.append(f"'{key}' is defined in only one locale (missing from {', '.join(lacks)})")

    # Unused entries are not errors — a key can be kept for a translated string
    # that is still being wired up — but they are reported so dead weight is
    # visible rather than accumulating silently.
    referenced = all_used | mentioned_keys(set(defined["zh-CN"]))
    unused = sorted(set(defined["zh-CN"]) - referenced
                    - {k for k in defined["zh-CN"]
                       if k.startswith(DYNAMIC_PREFIXES)})

    print(f"locales: {', '.join(LOCALES)}")
    print(f"keys:    {len(defined['zh-CN'])} zh-CN / {len(defined['en'])} en, "
          f"{len(all_used)} referenced from {len(used)} file(s)")
    if args.verbose:
        for key in sorted(all_used):
            source = ", ".join(sorted(f for f, ks in used.items() if key in ks))
            print(f"  {key:<40} {source}")

    if unused:
        print(f"\n{len(unused)} key(s) defined but not referenced from the UI"
              + (" (prefixes assembled at runtime are excluded)" if DYNAMIC_PREFIXES else "") + ":")
        for key in (unused if args.verbose else unused[:12]):
            print(f"  - {key}")
        if not args.verbose and len(unused) > 12:
            print(f"  ... and {len(unused) - 12} more (--verbose for the full list)")

    if failures:
        print(f"\nI18N GATE FAILED — {len(failures)} problem(s):")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("\nI18N GATE PASSED — every referenced key exists in both locales.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
