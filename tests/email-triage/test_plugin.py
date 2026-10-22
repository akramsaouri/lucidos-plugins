"""Email Triage ships the engine only since 0.7.0: its controls moved into the Inbox plugin."""
import os
import re
import tomllib
import unittest

PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "email-triage")
ON_DEMAND = os.path.join(PLUGIN, "triggers", "email-triage-on-demand", "trigger.toml")
INTENT = os.path.join(PLUGIN, "triggers", "email-triage", "intents", "triage.md")
KNOWHOW = os.path.join(PLUGIN, "knowhow", "email-triage.md")


def read(path):
    with open(path) as f:
        return f.read()


class NoAppTest(unittest.TestCase):
    def test_it_ships_no_app(self):
        self.assertFalse(os.path.exists(os.path.join(PLUGIN, "apps")))

    def test_the_on_demand_trigger_belongs_to_inbox(self):
        trig = tomllib.loads(read(ON_DEMAND))
        self.assertEqual(trig["app_id"], "inbox")
        self.assertEqual([o["event_type"] for o in trig["on"]], ["EmailTriageRequested"])
        self.assertNotIn("Email Triage app", trig["run"]["intent"])

    def test_nothing_points_at_the_removed_app(self):
        for path in (ON_DEMAND, INTENT, KNOWHOW):
            self.assertNotIn("data/apps/email-triage", read(path), path)


class ScriptPathsTest(unittest.TestCase):
    def test_every_script_the_intent_and_knowhow_run_ships(self):
        paths = set()
        for path in (INTENT, KNOWHOW):
            paths |= set(re.findall(r"python3? data/(\S+\.py)", read(path)))
        self.assertIn("scripts/email-triage/snapshot_imap.py", paths)
        for rel in paths:
            self.assertTrue(os.path.exists(os.path.join(PLUGIN, rel)), rel)


if __name__ == "__main__":
    unittest.main()
