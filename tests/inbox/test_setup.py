"""Inbox setup wires each Gmail account from Email Triage's OAuth before it ever asks for a Google client ID."""
import os
import re
import tomllib
import unittest

PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "inbox")


def read(path):
    with open(path) as f:
        return f.read()


class SetupTest(unittest.TestCase):
    def setUp(self):
        self.manifest = tomllib.loads(read(os.path.join(PLUGIN, "manifest.toml")))
        # Prose wraps anywhere, so match on single-spaced text.
        self.setup = re.sub(r"\s+", " ", self.manifest["setup"])
        self.knowhow = re.sub(r"\s+", " ", read(os.path.join(PLUGIN, "knowhow", "inbox.md")))

    def test_the_manifest_parses_with_a_setup(self):
        self.assertEqual(self.manifest["id"], "inbox")
        self.assertTrue(self.setup.strip())

    def test_it_reuses_a_proxy_then_the_oauth_provider_before_connecting(self):
        for text in (self.setup, self.knowhow):
            proxy = text.index("/gmail/v1/users/me/profile")
            reuse = text.index("oauth_provider")
            connect = text.index("connect_oauth_account")
            self.assertLess(proxy, reuse)
            self.assertLess(reuse, connect)

    def test_connecting_explains_the_popup_first(self):
        connect = self.setup[self.setup.index("**Connect the mailbox**"):]
        before = connect[:connect.index("connect_oauth_account")]
        self.assertIn("Name the provider", before)
        for must in ("client ID and secret", "same ones", "sign in as this mailbox", "test user"):
            self.assertIn(must, connect)

    def test_a_dismissed_popup_still_writes_the_settings(self):
        self.assertIn("dismisses the popup", self.setup)
        self.assertIn("still unwired", self.setup)

    def test_a_partial_setup_only_wires_the_missing_accounts(self):
        gate = self.setup[:self.setup.index("---")]
        self.assertIn("not a fresh install", gate)
        self.assertIn("settings file is missing", gate)

    def test_the_newest_update_note_is_this_minor_release(self):
        # A patch release that leaves setup alone adds no note (rewording setup would ask for a re-run), but a
        # minor release always says what changed.
        notes = [tuple(map(int, v.split("."))) for v in re.findall(r"\*\*Updating to (\d+\.\d+\.\d+):\*\*", self.setup)]
        version = tuple(map(int, self.manifest["version"].split(".")))
        self.assertTrue(notes)
        self.assertLessEqual(max(notes), version)
        self.assertEqual(max(notes)[:2], version[:2])


if __name__ == "__main__":
    unittest.main()
