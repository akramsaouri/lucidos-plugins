"""The triage engine ships with Inbox at its own inbox-triage paths, and Inbox stands alone: nothing in it knows
about the old Email Triage plugin, which this marketplace no longer lists."""
import os
import re
import tomllib
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
PLUGIN = os.path.join(ROOT, "inbox")
ON_DEMAND = os.path.join(PLUGIN, "triggers", "inbox-triage-on-demand", "trigger.toml")
INTENT = os.path.join(PLUGIN, "triggers", "inbox-triage", "intents", "triage.md")
KNOWHOW = os.path.join(PLUGIN, "knowhow", "inbox-triage.md")

ENGINE_PATHS = (
    "knowhow/inbox-triage.md",
    "triggers/inbox-triage/intents/triage.md",
    "scripts/inbox-triage/imap_helper.py",
    "scripts/inbox-triage/snapshot_imap.py",
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


def answering_slugs(plugin):
    """Slugs of the triggers a plugin ships that answer EmailTriageRequested."""
    out = []
    for base, _, names in os.walk(os.path.join(plugin, "triggers")):
        if "trigger.toml" in names:
            trig = tomllib.loads(read(os.path.join(base, "trigger.toml")))
            if any(o["event_type"] == "EmailTriageRequested" for o in trig["on"]):
                out.append(trig["slug"])
    return out


class EngineTest(unittest.TestCase):
    def test_the_engine_ships_at_its_own_paths(self):
        for rel in ENGINE_PATHS:
            self.assertTrue(os.path.exists(os.path.join(PLUGIN, rel)), rel)
        self.assertEqual({p for p in shipped(PLUGIN) if "email-triage" in p}, set())

    def test_the_on_demand_trigger_belongs_to_inbox(self):
        trig = tomllib.loads(read(ON_DEMAND))
        self.assertEqual(trig["app_id"], "inbox")
        self.assertEqual([o["event_type"] for o in trig["on"]], ["EmailTriageRequested"])
        self.assertIn("triggers/inbox-triage/intents/triage.md", trig["run"]["intent"])
        self.assertNotIn("schedule", trig)

    def test_exactly_one_trigger_answers_triage_requests(self):
        self.assertEqual(answering_slugs(PLUGIN), ["inbox-triage-on-demand"])

    def test_the_on_demand_trigger_answers_without_checking_for_another(self):
        intent = tomllib.loads(read(ON_DEMAND))["run"]["intent"]
        self.assertNotIn("email-triage", intent)
        self.assertNotIn("do nothing", intent)

    def test_the_intent_loads_inbox_knowhow(self):
        self.assertIn("  - inbox-triage\n", read(INTENT))
        self.assertTrue(read(KNOWHOW).startswith("---\nname: Inbox Triage\n"))

    def test_nothing_points_at_the_old_engine(self):
        for path in (ON_DEMAND, INTENT, KNOWHOW):
            text = read(path)
            self.assertNotIn("data/apps/email-triage", text, path)
            self.assertNotRegex(text, r"scripts/email-triage/|triggers/email-triage/intents", path)

    def test_every_script_the_intent_and_knowhow_run_ships(self):
        paths = set()
        for path in (INTENT, KNOWHOW):
            paths |= set(re.findall(r"python3? data/(\S+\.py)", read(path)))
        self.assertIn("scripts/inbox-triage/snapshot_imap.py", paths)
        for rel in paths:
            self.assertTrue(os.path.exists(os.path.join(PLUGIN, rel)), rel)


class StandsAloneTest(unittest.TestCase):
    def test_the_old_plugin_is_gone_from_the_marketplace(self):
        self.assertFalse(os.path.exists(os.path.join(ROOT, "email-triage")))
        self.assertNotIn("email-triage", read(os.path.join(ROOT, "README.md")))

    def test_inbox_never_names_an_old_plugin_path(self):
        # Its own storage, artifacts/email-triage/, and event names stay: they are Inbox's data, not the old plugin.
        old = re.compile(r"(?:knowhow|triggers|scripts|apps)/email-triage\b|email-triage-on-demand")
        for rel in shipped(PLUGIN) | {"manifest.toml"}:
            if rel.endswith((".md", ".js", ".py", ".toml", ".html", ".json")):
                self.assertNotRegex(read(os.path.join(PLUGIN, rel)), old, rel)


if __name__ == "__main__":
    unittest.main()
