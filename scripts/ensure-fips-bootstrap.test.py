#!/usr/bin/env python3

import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("ensure-fips-bootstrap.py")
SPEC = importlib.util.spec_from_file_location("ensure_fips_bootstrap", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class EnsureFipsBootstrapTest(unittest.TestCase):
    def test_replaces_empty_peer_list_and_is_idempotent(self) -> None:
        original = "node:\n  identity:\n    persistent: true\npeers: []\n"
        updated, changed = MODULE.with_bootstrap(original)
        self.assertTrue(changed)
        self.assertIn(MODULE.BOOTSTRAP_NPUB, updated)
        self.assertIn(MODULE.BOOTSTRAP_ADDRESS, updated)
        repeated, changed_again = MODULE.with_bootstrap(updated)
        self.assertFalse(changed_again)
        self.assertEqual(repeated, updated)

    def test_preserves_existing_operator_peers(self) -> None:
        original = '''peers:
  - npub: "npub1operator"
    addresses:
      - transport: udp
        addr: "192.0.2.10:2121"
'''
        updated, changed = MODULE.with_bootstrap(original)
        self.assertTrue(changed)
        self.assertIn("npub1operator", updated)
        self.assertEqual(updated.count(MODULE.BOOTSTRAP_NPUB), 1)

    def test_commented_bootstrap_does_not_prevent_migration(self) -> None:
        original = f'''peers: []
# - npub: "{MODULE.BOOTSTRAP_NPUB}"
'''
        updated, changed = MODULE.with_bootstrap(original)
        self.assertTrue(changed)
        self.assertIn('alias: "wingman-bootstrap"', updated)

    def test_rejects_a_config_without_peer_boundary(self) -> None:
        with self.assertRaisesRegex(ValueError, "peers section"):
            MODULE.with_bootstrap("node:\n  identity:\n    persistent: true\n")

    def test_main_preserves_file_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fips.yaml"
            path.write_text("peers: []\n", encoding="utf-8")
            path.chmod(0o640)
            previous_argv = MODULE.sys.argv
            MODULE.sys.argv = [str(MODULE_PATH), str(path)]
            try:
                self.assertEqual(MODULE.main(), 0)
            finally:
                MODULE.sys.argv = previous_argv
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            self.assertIn(MODULE.BOOTSTRAP_NPUB, path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
