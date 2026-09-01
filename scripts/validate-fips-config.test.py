#!/usr/bin/env python3

import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("validate-fips-config.py")
SPEC = importlib.util.spec_from_file_location("validate_fips_config", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ValidateFipsConfigTest(unittest.TestCase):
    def test_reads_exact_nested_namespace(self) -> None:
        text = '''
node:
  rendezvous:
    nostr:
      app: "wingman-fips-poc-v1"
'''
        self.assertEqual(
            MODULE.scalar_at_path(text, ("node", "rendezvous", "nostr", "app")),
            "wingman-fips-poc-v1",
        )

    def test_does_not_accept_same_key_from_another_section(self) -> None:
        text = '''
app: "wingman-fips-poc-v1"
node:
  rendezvous:
    nostr:
      app: "fips-overlay-v1"
'''
        self.assertEqual(
            MODULE.scalar_at_path(text, ("node", "rendezvous", "nostr", "app")),
            "fips-overlay-v1",
        )

    def test_reads_lan_scope(self) -> None:
        text = '''
node:
  rendezvous:
    lan:
      enabled: true
      scope: "wingman-fips-poc-v1"
'''
        self.assertEqual(
            MODULE.scalar_at_path(text, ("node", "rendezvous", "lan", "scope")),
            "wingman-fips-poc-v1",
        )


if __name__ == "__main__":
    unittest.main()
