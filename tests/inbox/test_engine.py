"""The triage engine ships with Inbox since 0.3.0, at the data/ paths Email Triage used, and Email Triage is a
deprecated listing that ships none of them."""
import os
import re
import tomllib
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
PLUGIN = os.path.join(ROOT, "inbox")
DEPRECATED = os.path.join(ROOT, "email-triage")
ON_DEMAND = os.path.join(PLUGIN, "triggers", "inbox-triage-on-demand", "trigger.toml")
INTENT = os.path.join(PLUGIN, "triggers", "email-triage", "intents", "triage.md")
KNOWHOW = os.path.join(PLUGIN, "knowhow", "email-triage.md")

# Existing workspaces' cron triggers name these, so they must never move.
ENGINE_PATHS = (
    "knowhow/email-triage.md",
    "triggers/email-triage/intents/triage.md",
    "scripts/email-triage/imap_helper.py",
    "scripts/email-triage/snapshot_imap.py",
)


def read(path):
    with open(path) as f:
        return f.read()


def shipped(plugin):
    files = set()
    for base, _, names in os.walk(plugin):
        for name in names:
            rel = os.path.relpath(os.path.join(base, name), plugin)
            if not rel.startswith("media" + os.sep) and rel != "manifest.toml":
                files.add(rel.replace(os.sep, "/"))
    return files


class EngineTest(unittest.TestCase):
    def test_the_engine_ships_at_its_old_paths(self):
        for rel in ENGINE_PATHS:
            self.assertTrue(os.path.exists(os.path.join(PLUGIN, rel)), rel)

    def test_the_on_demand_trigger_belongs_to_inbox(self):
        trig = tomllib.loads(read(ON_DEMAND))
        self.assertEqual(trig["app_id"], "inbox")
        self.assertEqual([o["event_type"] for o in trig["on"]], ["EmailTriageRequested"])
        self.assertIn("triggers/email-triage/intents/triage.md", trig["run"]["intent"])
        self.assertNotIn("schedule", trig)

    def test_exactly_one_trigger_answers_triage_requests(self):
        answering = []
        for base, _, names in os.walk(os.path.join(PLUGIN, "triggers")):
            if "trigger.toml" in names:
                trig = tomllib.loads(read(os.path.join(base, "trigger.toml")))
                if any(o["event_type"] == "EmailTriageRequested" for o in trig["on"]):
                    answering.append(trig["slug"])
        self.assertEqual(answering, ["inbox-triage-on-demand"])

    def test_nothing_points_at_the_removed_app(self):
        for path in (ON_DEMAND, INTENT, KNOWHOW):
            self.assertNotIn("data/apps/email-triage", read(path), path)

    def test_every_script_the_intent_and_knowhow_run_ships(self):
        paths = set()
        for path in (INTENT, KNOWHOW):
            paths |= set(re.findall(r"python3? data/(\S+\.py)", read(path)))
        self.assertIn("scripts/email-triage/snapshot_imap.py", paths)
        for rel in paths:
            self.assertTrue(os.path.exists(os.path.join(PLUGIN, rel)), rel)


class DeprecatedListingTest(unittest.TestCase):
    """Uninstall deletes every file a plugin records, so Email Triage must share no path with Inbox."""

    def setUp(self):
        self.manifest = tomllib.loads(read(os.path.join(DEPRECATED, "manifest.toml")))

    def test_it_shares_no_file_with_inbox(self):
        self.assertEqual(shipped(DEPRECATED) & shipped(PLUGIN), set())
        self.assertEqual(shipped(DEPRECATED), {"knowhow/email-triage-deprecated.md"})

    def test_it_says_it_is_deprecated(self):
        self.assertTrue(self.manifest["description"].startswith("Deprecated: now part of Inbox."))
        self.assertGreaterEqual(tuple(int(p) for p in self.manifest["version"].split(".")), (0, 8, 0))
        self.assertIn("Deprecated: now part of", read(os.path.join(DEPRECATED, "media", "README.md")))

    def test_its_setup_creates_nothing(self):
        setup = re.sub(r"\s+", " ", self.manifest["setup"])
        self.assertIn("Do NOT create triggers", setup)


if __name__ == "__main__":
    unittest.main()
