"""The triage engine ships with Inbox since 0.3.0, at its own inbox-triage paths. Email Triage 0.8.0 is a
deprecated listing that keeps its own engine, unchanged, at the email-triage paths, and the two share no file."""
import itertools
import os
import re
import tomllib
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
PLUGIN = os.path.join(ROOT, "inbox")
DEPRECATED = os.path.join(ROOT, "email-triage")
ON_DEMAND = os.path.join(PLUGIN, "triggers", "inbox-triage-on-demand", "trigger.toml")
INTENT = os.path.join(PLUGIN, "triggers", "inbox-triage", "intents", "triage.md")
KNOWHOW = os.path.join(PLUGIN, "knowhow", "inbox-triage.md")

# Inbox's engine. Uninstalling a plugin deletes every file it recorded, even one another plugin also records, so
# none of these may ever be a path Email Triage records.
ENGINE_PATHS = (
    "knowhow/inbox-triage.md",
    "triggers/inbox-triage/intents/triage.md",
    "scripts/inbox-triage/imap_helper.py",
    "scripts/inbox-triage/snapshot_imap.py",
)
# What Email Triage 0.7.1 recorded, the last release before the move. Installed copies keep this record until they
# update, and cron triggers made under it name these paths.
EMAIL_TRIAGE_071 = frozenset({
    "knowhow/email-triage.md",
    "triggers/email-triage/intents/triage.md",
    "triggers/email-triage-on-demand/trigger.toml",
    "scripts/email-triage/imap_helper.py",
    "scripts/email-triage/snapshot_imap.py",
})
OLD_ENGINE = EMAIL_TRIAGE_071 - {"triggers/email-triage-on-demand/trigger.toml"}
# Enough of Inbox 0.2.x's record for the model below: it shipped no engine file.
INBOX_02 = frozenset({"apps/inbox/app.js", "knowhow/inbox.md", "triggers/inbox-imap-bridge/trigger.toml"})


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

    def test_it_stands_down_while_the_old_on_demand_trigger_is_live(self):
        # Email Triage 0.7.x's trigger answers the same event and can't be changed on installed copies, so Inbox's
        # trigger checks for it before doing anything, or one Triage now press runs two triages of the same account.
        intent = tomllib.loads(read(ON_DEMAND))["run"]["intent"]
        guard, run = intent.index("email-triage-on-demand"), intent.index("triggers/inbox-triage/intents/triage.md")
        self.assertLess(guard, run)
        self.assertIn("not paused", intent[:run])
        self.assertIn("do nothing", intent[:run])

    def test_the_intent_loads_inbox_knowhow(self):
        self.assertIn("  - inbox-triage\n", read(INTENT))
        self.assertTrue(read(KNOWHOW).startswith("---\nname: Email Triage\n"),
                        "keeps the title, which hand-written crons name ('the Email Triage knowhow')")

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


class DeprecatedListingTest(unittest.TestCase):
    def setUp(self):
        self.manifest = tomllib.loads(read(os.path.join(DEPRECATED, "manifest.toml")))

    def test_it_shares_no_file_with_inbox(self):
        self.assertEqual(shipped(DEPRECATED) & shipped(PLUGIN), set())

    def test_its_update_drops_nothing(self):
        # An update removes what the new version dropped. 0.8.0 keeps all of 0.7.1, so updating it never takes the
        # engine away, whatever version Inbox is at.
        self.assertLessEqual(EMAIL_TRIAGE_071, shipped(DEPRECATED))
        self.assertIn("knowhow/email-triage-deprecated.md", shipped(DEPRECATED))

    def test_it_says_it_is_deprecated(self):
        self.assertTrue(self.manifest["description"].startswith("Deprecated: now part of Inbox."))
        self.assertGreaterEqual(tuple(int(p) for p in self.manifest["version"].split(".")), (0, 8, 0))
        self.assertIn("Deprecated: now part of", read(os.path.join(DEPRECATED, "media", "README.md")))

    def test_its_setup_creates_nothing_and_never_strands_a_cron(self):
        setup = re.sub(r"\s+", " ", self.manifest["setup"])
        self.assertIn("Do NOT create triggers", setup)
        self.assertIn("Don't uninstall from here while any cron", setup)


class Workspace:
    """The plugin engine's file rules, as plugins.md states them: an update writes the new files and removes the
    previous record's paths the new version dropped, except a path another installed plugin still records; an
    uninstall deletes every recorded path. A plugin's triggers are its recorded trigger.toml files."""

    def __init__(self):
        self.records = {"inbox": INBOX_02, "email-triage": EMAIL_TRIAGE_071}
        self.disk = set(INBOX_02 | EMAIL_TRIAGE_071)

    def update(self, plugin, files):
        others = set().union(*(r for p, r in self.records.items() if p != plugin))
        self.disk -= self.records[plugin] - set(files) - others
        self.disk |= set(files)
        self.records[plugin] = frozenset(files)

    def uninstall(self, plugin):
        self.disk -= self.records.pop(plugin)

    def triage_now_runs(self):
        """Triggers that run a triage for one Triage now press, after Inbox's stand-down check."""
        live = {f.split("/")[1] for r in self.records.values() for f in r if f.endswith("/trigger.toml")}
        answering = live & {"inbox-triage-on-demand", "email-triage-on-demand"}
        if "email-triage-on-demand" in answering:
            answering.discard("inbox-triage-on-demand")
        return answering


class MigrationOrderTest(unittest.TestCase):
    """Every order a user can take from Inbox 0.2.x + Email Triage 0.7.1: update Inbox, update Email Triage, and
    uninstall Email Triage, in any order, any of them skipped. Triage must never lose the engine it runs on."""

    STEPS = ("update inbox", "update email-triage", "uninstall email-triage")

    def orders(self):
        for n in range(len(self.STEPS) + 1):
            for order in itertools.permutations(self.STEPS, n):
                gone = order.index("uninstall email-triage") if "uninstall email-triage" in order else len(order)
                if "update email-triage" in order[gone:]:
                    continue  # nothing left to update
                yield order

    def test_no_order_loses_an_engine_that_is_still_installed(self):
        inbox, deprecated = shipped(PLUGIN), shipped(DEPRECATED)
        for order in self.orders():
            ws = Workspace()
            for step in order:
                if step == "update inbox":
                    ws.update("inbox", inbox)
                elif step == "update email-triage":
                    ws.update("email-triage", deprecated)
                else:
                    ws.uninstall("email-triage")
                with self.subTest(order=order, after=step):
                    if ws.records["inbox"] == frozenset(inbox):
                        self.assertLessEqual(set(ENGINE_PATHS), ws.disk, "Inbox 0.3.0's engine")
                    if "email-triage" in ws.records:
                        # So a cron still naming an email-triage path keeps working until setup moves it.
                        self.assertLessEqual(OLD_ENGINE, ws.disk, "Email Triage's engine")
                    runs = ws.triage_now_runs()
                    self.assertLessEqual(len(runs), 1, "one Triage now press, one run")
                    if ws.records["inbox"] == frozenset(inbox) or "email-triage" in ws.records:
                        self.assertEqual(len(runs), 1, "Triage now has a trigger")

    def test_the_model_sees_the_shipped_triggers(self):
        self.assertEqual(answering_slugs(DEPRECATED), ["email-triage-on-demand"])
        self.assertIn("triggers/email-triage-on-demand/trigger.toml", EMAIL_TRIAGE_071)


if __name__ == "__main__":
    unittest.main()
