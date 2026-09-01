#!/usr/bin/env python3
"""Validate the cross-client settings Autopilot requires from a FIPS config."""

from __future__ import annotations

import sys
from pathlib import Path


REQUIRED_APP = "wingman-fips-poc-v1"


def scalar_at_path(text: str, wanted: tuple[str, ...]) -> str | None:
    stack: list[tuple[int, str]] = []
    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        content = raw_line.strip()
        if ":" not in content:
            continue
        key, value = content.split(":", 1)
        while stack and stack[-1][0] >= indent:
            stack.pop()
        stack.append((indent, key.strip()))
        if tuple(item[1] for item in stack) == wanted:
            return value.split("#", 1)[0].strip().strip("\"'")
    return None


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: validate-fips-config.py <fips.yaml>", file=sys.stderr)
        return 2
    config_path = Path(sys.argv[1])
    try:
        text = config_path.read_text(encoding="utf-8")
    except OSError as error:
        print(f"Could not read FIPS config {config_path}: {error}", file=sys.stderr)
        return 1

    configured_app = scalar_at_path(
        text, ("node", "rendezvous", "nostr", "app")
    )
    if configured_app != REQUIRED_APP:
        actual = configured_app if configured_app else "<missing; upstream default is fips-overlay-v1>"
        print(
            "Incompatible FIPS rendezvous namespace in "
            f"{config_path}: expected node.rendezvous.nostr.app "
            f"to be {REQUIRED_APP!r}, found {actual!r}. "
            "WMapp only discovers Wingman PoC advertisements in the required namespace; "
            "update the persisted config explicitly and restart.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
