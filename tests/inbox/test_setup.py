"""Inbox setup: triage first, then each Gmail account wired from its OAuth before it ever asks for a Google client
ID. Inbox stands alone: setup never migrates from the old Email Triage plugin."""
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
        gmail = self.setup[self.setup.index("**Each Gmail account**"):]
        for text in (gmail, self.knowhow):
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

    def test_triage_comes_before_the_inbox_wiring(self):
        order = ["## Check the engine resolves", "**Connect the mailbox** if", "**Build a starting rule chain.**", "**Ask what happens to mail",
                 "create the cron trigger", "**Each Gmail account**", "**Each IMAP account**", "display name",
                 "**AI Suggest"]
        at = [self.setup.index(o) for o in order]
        self.assertEqual(at, sorted(at))

    def test_the_safety_rules_hold(self):
        self.assertIn("Never read a message with `read_email`", self.setup)
        self.assertIn("Never create an on-demand trigger", self.setup)
        self.assertIn("reuse it rather than adding another", self.setup)

    def test_it_no_longer_moves_anyone_off_email_triage(self):
        self.assertNotIn("Moving from Email Triage", self.setup)
        self.assertNotIn("email-triage-on-demand", self.setup)
        self.assertNotIn('id="email-triage"', self.setup)
        self.assertNotRegex(self.setup, r"(?:knowhow|triggers|scripts|apps)/email-triage\b")

    def test_a_cron_naming_a_missing_file_is_repaired_in_place(self):
        check = self.setup[self.setup.index("## Check the engine resolves"):self.setup.index("## Triage, per account")]
        self.assertIn("no per-account cron names a file that is missing", check)
        self.assertIn("triggers/inbox-triage/intents/triage.md", check)
        self.assertIn("Never recreate, pause or delete one", check)

    def test_the_check_covers_the_engine_and_the_crons(self):
        check = self.setup[self.setup.index("## Check the engine resolves"):]
        for path in ("knowhow/inbox-triage.md", "triggers/inbox-triage/intents/triage.md",
                     "scripts/inbox-triage/imap_helper.py", "scripts/inbox-triage/snapshot_imap.py"):
            self.assertIn(path, check)
            self.assertTrue(os.path.exists(os.path.join(PLUGIN, path)), path)
        self.assertIn("no per-account cron names a file that is missing", check)
        self.assertIn("Exactly one trigger answers `EmailTriageRequested`", check)

    def test_new_crons_run_inbox_engine(self):
        cron = self.setup[self.setup.index("create the cron trigger"):self.setup.index("**Write the account into")]
        self.assertIn("triggers/inbox-triage/intents/triage.md", cron)
        self.assertIn("`Inbox triage — <Account>`", cron)

    def test_a_raised_setup_revision_says_why(self):
        self.assertGreaterEqual(self.manifest["setup_revision"], 1)
        self.assertLessEqual(len(self.manifest["setup_reason"]), 200)
        self.assertIn("stands alone", self.manifest["setup_reason"])

    def test_the_newest_update_note_is_this_minor_release(self):
        # A patch release that leaves setup alone adds no note (rewording setup would ask for a re-run), but a
        # minor or major release always says what changed.
        notes = [tuple(map(int, v.split("."))) for v in re.findall(r"\*\*Updating to (\d+\.\d+\.\d+):\*\*", self.setup)]
        version = tuple(map(int, self.manifest["version"].split(".")))
        self.assertTrue(notes)
        self.assertLessEqual(max(notes), version)
        self.assertEqual(max(notes)[:2], version[:2])

    def test_the_1_0_0_note_says_to_uninstall_and_install_fresh(self):
        note = self.setup[self.setup.index("**Updating to 1.0.0:**"):self.setup.index("---")]
        for must in ("uninstall Email Triage and Inbox", "install Inbox fresh", "run this setup"):
            self.assertIn(must, note)


if __name__ == "__main__":
    unittest.main()
