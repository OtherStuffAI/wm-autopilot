#!/usr/bin/env python3
"""Validate the cross-client settings Autopilot requires from a FIPS config."""

from __future__ import annotations

import sys
import re
from pathlib import Path


REQUIRED_APP = "wingman-fips-poc-v1"
BOOTSTRAP_NPUB = "npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98"
BOOTSTRAP_ADDRESS = "217.77.8.91:2121"


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


def has_authenticated_bootstrap(text: str) -> bool:
    peer = re.search(
        rf'(?ms)^  - npub:\s*["\']?{re.escape(BOOTSTRAP_NPUB)}["\']?\s*$'
        r'(?P<body>.*?)(?=^  - npub:|\Z)',
        text,
    )
    if peer is None:
        return False
    body = peer.group("body")
    return bool(
        re.search(
            rf'(?m)^\s+addr:\s*["\']?{re.escape(BOOTSTRAP_ADDRESS)}["\']?\s*$',
            body,
        )
        and re.search(r'(?m)^\s+connect_policy:\s*auto_connect\s*$', body)
    )


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
    share_local_candidates = scalar_at_path(
        text, ("node", "rendezvous", "nostr", "share_local_candidates")
    )
    if share_local_candidates != "true":
        print(
            f"Incompatible FIPS same-LAN traversal in {config_path}: expected "
            "node.rendezvous.nostr.share_local_candidates=true. This PoC setting "
            "is only appropriate when both peers are on the same physical LAN.",
            file=sys.stderr,
        )
        return 1
    lan_enabled = scalar_at_path(text, ("node", "rendezvous", "lan", "enabled"))
    lan_scope = scalar_at_path(text, ("node", "rendezvous", "lan", "scope"))
    if lan_enabled != "true" or lan_scope != REQUIRED_APP:
        print(
            f"Incompatible FIPS LAN rendezvous in {config_path}: expected "
            f"node.rendezvous.lan.enabled=true and scope={REQUIRED_APP!r}.",
            file=sys.stderr,
        )
        return 1
    if not has_authenticated_bootstrap(text):
        print(
            f"Incompatible FIPS bootstrap in {config_path}: expected authenticated "
            f"peer {BOOTSTRAP_NPUB} at pinned address {BOOTSTRAP_ADDRESS} with "
            "connect_policy=auto_connect. Update the persisted config explicitly.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
