#!/usr/bin/env python3
"""Gate: every packaged target is a well-formed package for its platform.

A cross-compiled package can be wrong in ways that only show up on the user's
machine — the host picks the artifact by target name and then launches whatever
manifest.json names, so a mistake here is "installs fine, never starts":

  * the binary is the wrong format or architecture for the target it is filed
    under (a mis-set GOARCH in the build matrix is silent otherwise);
  * darwin-arm64 lacks a code signature. macOS on Apple Silicon refuses to
    execute unsigned arm64 code, and Go only applies an ad-hoc signature for
    that one target — so an unsigned one there is dead on arrival, not merely
    unpolished;
  * the manifest's backend path does not name the file that ships (the original
    hand-assembled packages had exactly this, and the sidecar tests could not
    see it because they extract the binary themselves);
  * a POSIX sidecar is not marked executable inside the archive.

Everything is checked from the built artifacts, so it runs on any host and needs
no emulator: the format/arch/signature checks read the binaries, they do not
execute them. Actually running them is what the CI matrix is for.

Usage:  python3 tools/check-packages.py [--target windows-x64 ...]   (exit 0 = clean)
"""

from __future__ import annotations

import argparse
import pathlib
import struct
import sys
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import _harness  # noqa: E402  (needs the path fix above)

ROOT = _harness.ROOT

# target -> (format, architecture, requires code signature)
EXPECTED = {
    "windows-x64": ("PE", "x86_64", False),
    "windows-arm64": ("PE", "arm64", False),
    "linux-x64": ("ELF", "x86_64", False),
    "linux-arm64": ("ELF", "aarch64", False),
    "darwin-x64": ("Mach-O", "x86_64", False),
    # Apple Silicon executes nothing unsigned — Go ad-hoc signs this target.
    "darwin-arm64": ("Mach-O", "arm64", True),
}

MACHO_CPU = {0x01000007: "x86_64", 0x0100000C: "arm64"}
ELF_MACHINE = {0x3E: "x86_64", 0xB7: "aarch64"}
PE_MACHINE = {0x8664: "x86_64", 0xAA64: "arm64"}
LC_CODE_SIGNATURE = 0x1D


def describe_binary(blob: bytes) -> dict:
    """Format, architecture, and (for Mach-O) whether it carries a signature."""
    if blob[:2] == b"MZ":
        offset = struct.unpack("<I", blob[0x3C:0x40])[0]
        if blob[offset:offset + 4] == b"PE\x00\x00":
            machine = struct.unpack("<H", blob[offset + 4:offset + 6])[0]
            return {"format": "PE", "arch": PE_MACHINE.get(machine, hex(machine))}
    if blob[:4] == b"\x7fELF":
        machine = struct.unpack("<H", blob[18:20])[0]
        return {"format": "ELF", "arch": ELF_MACHINE.get(machine, hex(machine))}
    if struct.unpack(">I", blob[:4])[0] in (0xCAFEBABE, 0xCAFEBABF):
        return {"format": "Mach-O", "arch": "universal", "signed": False}
    if struct.unpack("<I", blob[:4])[0] == 0xFEEDFACF:
        cpu = struct.unpack("<I", blob[4:8])[0]
        ncmds = struct.unpack("<I", blob[16:20])[0]
        offset, signed = 32, False
        for _ in range(ncmds):
            cmd, size = struct.unpack("<II", blob[offset:offset + 8])
            if cmd == LC_CODE_SIGNATURE:
                signed = True
            offset += size
        return {"format": "Mach-O", "arch": MACHO_CPU.get(cpu, hex(cpu)), "signed": signed}
    return {"format": "unknown", "arch": "unknown"}


def check_package(package: pathlib.Path, target: str) -> list[str]:
    problems = list(_harness.package_layout_errors(package))
    binary_name = _harness.sidecar_name(target)
    inner = f"bin/{target}/{binary_name}"

    with zipfile.ZipFile(package) as archive:
        if inner not in archive.namelist():
            return problems + [f"{inner} is missing from the package"]
        blob = archive.read(inner)
        info = archive.getinfo(inner)

    actual = describe_binary(blob)
    want_format, want_arch, needs_signature = EXPECTED[target]

    if actual["format"] != want_format:
        problems.append(f"binary is {actual['format']}, expected {want_format} for {target}")
    if actual.get("arch") != want_arch:
        problems.append(f"binary is {actual.get('arch')}, expected {want_arch} for {target}")
    if needs_signature and not actual.get("signed"):
        problems.append(f"{target} has no code signature — macOS refuses to execute it on Apple Silicon")

    # POSIX needs the executable bit; Windows ignores the mode entirely.
    if not target.startswith("windows") and not (info.external_attr >> 16) & 0o111:
        problems.append(f"{inner} is not marked executable inside the archive")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("-t", "--target", action="append", choices=sorted(EXPECTED),
                        help="check only this target (repeatable); default: all present")
    args = parser.parse_args()

    wanted = args.target or sorted(EXPECTED)
    checked, failures = 0, 0
    for target in wanted:
        try:
            package = _harness.find_package(target)
        except SystemExit:
            print(f"  [SKIP] {target:<15} no package in dist/")
            continue
        problems = check_package(package, target)
        checked += 1
        if problems:
            failures += 1
            print(f"  [FAIL] {target:<15} {package.name}")
            for problem in problems:
                print(f"           - {problem}")
        else:
            print(f"  [PASS] {target:<15} {package.name}")

    print()
    if failures:
        print(f"PACKAGE GATE FAILED — {failures} of {checked} target(s) are not installable")
        return 1
    if not checked:
        print("PACKAGE GATE SKIPPED — nothing in dist/ (run: npm run package)")
        return 0
    print(f"PACKAGE GATE PASSED — {checked} target(s) well-formed for their platform")
    return 0


if __name__ == "__main__":
    sys.exit(main())
