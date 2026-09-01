#!/usr/bin/env python3
"""Add Wingman's authenticated FIPS bootstrap to a persisted config once."""

from __future__ import annotations

import os
import re
import stat
import sys
import tempfile
from pathlib import Path


BOOTSTRAP_NPUB = "npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98"
BOOTSTRAP_ADDRESS = "217.77.8.91:2121"
BOOTSTRAP = f'''  - npub: "{BOOTSTRAP_NPUB}"
    alias: "wingman-bootstrap"
    addresses:
      - transport: udp
        addr: "{BOOTSTRAP_ADDRESS}"
    connect_policy: auto_connect
'''


def with_bootstrap(text: str) -> tuple[str, bool]:
    active_bootstrap = rf'^\s*-\s+npub:\s*["\']?{re.escape(BOOTSTRAP_NPUB)}["\']?\s*$'
    if re.search(active_bootstrap, text, re.MULTILINE):
        return text, False
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.strip() == "peers: []":
            newline = "\r\n" if line.endswith("\r\n") else "\n"
            lines[index] = f"peers:{newline}{BOOTSTRAP.replace(chr(10), newline)}"
            return "".join(lines), True
        if line.strip() == "peers:":
            newline = "\r\n" if line.endswith("\r\n") else "\n"
            lines.insert(index + 1, BOOTSTRAP.replace("\n", newline))
            return "".join(lines), True
    raise ValueError("missing top-level peers section")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: ensure-fips-bootstrap.py <fips.yaml>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    try:
        original = path.read_text(encoding="utf-8")
        updated, changed = with_bootstrap(original)
    except (OSError, ValueError) as error:
        print(f"Could not prepare FIPS bootstrap in {path}: {error}", file=sys.stderr)
        return 1
    if not changed:
        return 0

    metadata = path.stat()
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.wingman-bootstrap.", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as temporary:
            temporary.write(updated)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temporary_name, stat.S_IMODE(metadata.st_mode))
        os.chown(temporary_name, metadata.st_uid, metadata.st_gid)
        os.replace(temporary_name, path)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
    print(f"Added authenticated Wingman FIPS bootstrap to {path}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
