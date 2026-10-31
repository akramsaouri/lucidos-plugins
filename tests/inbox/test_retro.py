"""Inbox's triage retro: the daily schedule check decides from the setting alone, the IMAP helper restores from Trash
unread, and the shipped trigger, intent, knowhow, setup and app all name the same files and events."""
import datetime as dt
import importlib.util
import io
import json
import os
import re
import stat
import tempfile
import tomllib
import unittest
from contextlib import redirect_stdout
from unittest import mock

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
PLUGIN = os.path.join(ROOT, "inbox")
SCRIPTS = os.path.join(PLUGIN, "scripts", "inbox-triage")
TRIGGER = os.path.join(PLUGIN, "triggers", "inbox-triage-retro", "trigger.toml")
INTENT = os.path.join(PLUGIN, "triggers", "inbox-triage", "intents", "retro.md")
KNOWHOW = os.path.join(PLUGIN, "knowhow", "inbox-triage-retro.md")
TRIAGE_INTENT = os.path.join(PLUGIN, "triggers", "inbox-triage", "intents", "triage.md")
TRIAGE_KNOWHOW = os.path.join(PLUGIN, "knowhow", "inbox-triage.md")
TRIAGE_JS = os.path.join(PLUGIN, "apps", "inbox", "triage.js")


def read(path):
    with open(path) as f:
        return f.read()


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(SCRIPTS, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


tick = load("retro_tick")
imap_helper = load("imap_helper")

D = dt.date
WED, THU, SAT, SUN, MON = D(2026, 10, 28), D(2026, 10, 29), D(2026, 10, 31), D(2026, 11, 1), D(2026, 11, 2)
on = lambda schedule=None: {"retro": {"enabled": True, **({"schedule": schedule} if schedule else {})}}


class DueTest(unittest.TestCase):
    def test_off_unless_enabled_is_exactly_true(self):
        for settings in ({}, {"retro": {}}, {"retro": {"enabled": False}}, {"retro": {"enabled": "true"}}, {"retro": True}, []):
            self.assertFalse(tick.due(settings, None, WED), settings)

    def test_twice_weekly_is_the_default_and_runs_wednesday_and_sunday(self):
        self.assertEqual(tick.retro_setting(on())[1], "twice-weekly")
        self.assertTrue(tick.due(on(), WED - dt.timedelta(days=3), WED))
        self.assertTrue(tick.due(on(), WED, SUN))
        self.assertFalse(tick.due(on(), WED, THU))
        self.assertFalse(tick.due(on(), WED, SAT))

    def test_weekly_runs_sunday_and_daily_every_day(self):
        self.assertTrue(tick.due(on("weekly"), SUN - dt.timedelta(days=7), SUN))
        self.assertFalse(tick.due(on("weekly"), SUN, WED + dt.timedelta(days=7)))
        for day in (WED, THU, SAT, SUN, MON):
            self.assertTrue(tick.due(on("daily"), day - dt.timedelta(days=1), day))

    def test_never_twice_a_day(self):
        self.assertFalse(tick.due(on("daily"), WED, WED))
        self.assertFalse(tick.due(on(), SUN, SUN))

    def test_a_missed_evening_catches_up(self):
        # Last asked the Sunday before; the Wednesday fire was missed (machine off), so Thursday catches up.
        self.assertTrue(tick.due(on(), WED - dt.timedelta(days=4), THU))
        self.assertTrue(tick.due(on("weekly"), SUN - dt.timedelta(days=7), MON))
        # The first ever check on an off day waits for a scheduled day.
        self.assertFalse(tick.due(on(), None, THU))

    def test_an_unknown_schedule_never_runs(self):
        self.assertFalse(tick.due(on("hourly"), None, WED))

    def test_since_overlaps_a_day_and_stays_within_the_cleared_log(self):
        self.assertEqual(tick.since_for(SUN, WED + dt.timedelta(days=7)), SAT)
        self.assertEqual(tick.since_for(None, WED), WED - dt.timedelta(days=4))
        self.assertEqual(tick.since_for(WED - dt.timedelta(days=90), WED), WED - dt.timedelta(days=30))


class TickRunTest(unittest.TestCase):
    """main() against a temporary workspace, with a fake `lucidos` that records its arguments."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        ws = self.tmp.name
        self.settings = os.path.join(ws, "data/artifacts/inbox/settings.json")
        self.tick = os.path.join(ws, "data/artifacts/inbox/retro/tick.json")
        os.makedirs(os.path.dirname(self.settings))
        self.calls = os.path.join(ws, "calls.txt")
        bin_dir = os.path.join(ws, "bin")
        os.makedirs(bin_dir)
        fake = os.path.join(bin_dir, "lucidos")
        with open(fake, "w") as f:
            f.write(f"#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{self.calls}'\n")
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
        self.patches = [mock.patch.object(tick, "SETTINGS", self.settings), mock.patch.object(tick, "TICK", self.tick),
                        mock.patch.dict(os.environ, {"PATH": bin_dir + os.pathsep + os.environ["PATH"]})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def write_settings(self, obj):
        with open(self.settings, "w") as f:
            json.dump(obj, f)

    def run_tick(self, today, *argv):
        with redirect_stdout(io.StringIO()) as out:
            self.assertEqual(tick.main(list(argv), today=today), 0)
        return json.loads(out.getvalue().strip().splitlines()[-1])

    def emitted(self):
        return read(self.calls).splitlines() if os.path.exists(self.calls) else []

    def test_due_emits_the_request_and_records_the_day(self):
        self.write_settings({"display_name": "Alex", **on()})
        out = self.run_tick(WED)
        self.assertTrue(out["due"])
        args = self.emitted()
        self.assertEqual(args[:4], ["events", "emit", "InboxTriageRetroRequested", "--summary"])
        payload = json.loads(args[args.index("--payload") + 1])
        self.assertEqual(payload, {"summary": "Triage retro since 2026-10-24", "since": "2026-10-24",
                                   "schedule": "twice-weekly", "source": "schedule"})
        self.assertEqual(json.loads(read(self.tick)), {"last_requested": "2026-10-28"})
        # The same evening again: nothing.
        self.assertFalse(self.run_tick(WED)["due"])
        self.assertEqual(len([a for a in self.emitted() if a == "emit"]), 1)

    def test_off_or_missing_settings_emit_nothing(self):
        self.assertFalse(self.run_tick(WED)["due"])
        self.write_settings({"retro": {"enabled": False, "schedule": "daily"}})
        self.assertFalse(self.run_tick(WED)["due"])
        self.assertEqual(self.emitted(), [])
        self.assertFalse(os.path.exists(self.tick))

    def test_turning_it_off_takes_effect_on_the_next_evening(self):
        self.write_settings(on("daily"))
        self.assertTrue(self.run_tick(WED)["due"])
        self.write_settings({"retro": {"enabled": False, "schedule": "daily"}})
        self.assertFalse(self.run_tick(THU)["due"])
        self.assertEqual(len([a for a in self.emitted() if a == "emit"]), 1)

    def test_a_dry_run_emits_and_writes_nothing(self):
        self.write_settings(on())
        self.assertTrue(self.run_tick(WED, "--dry-run")["due"])
        self.assertEqual(self.emitted(), [])
        self.assertFalse(os.path.exists(self.tick))


class FakeIMAP:
    """Two folders keyed by UID, each message {msgid, flags}. Enough of imaplib for cmd_restore."""

    def __init__(self, caps="IMAP4rev1 UIDPLUS MOVE"):
        self.caps = caps
        self.folders = {'"INBOX"': {}, '"Trash"': {}, '"Archive"': {}}
        self.selected = None
        self.next_uid = 100

    def add(self, folder, msgid, flags=()):
        self.next_uid += 1
        self.folders[folder][str(self.next_uid)] = {"msgid": msgid, "flags": set(flags)}

    def capability(self):
        return "OK", [self.caps.encode()]

    def list(self):
        return "OK", [b'(\\HasNoChildren) "/" "INBOX"', b'(\\HasNoChildren \\Trash) "/" "Trash"',
                      b'(\\HasNoChildren \\Archive) "/" "Archive"']

    def select(self, folder, readonly=False):
        self.selected = folder
        return "OK", [b"1"]

    def expunge(self):
        box = self.folders[self.selected]
        for uid in [u for u, m in box.items() if "\\Deleted" in m["flags"]]:
            del box[uid]
        return "OK", []

    def uid(self, cmd, *args):
        box = self.folders[self.selected]
        if cmd == "SEARCH":
            want = args[-1].strip('"')
            return "OK", [" ".join(u for u, m in box.items() if m["msgid"] == want).encode()]
        uids = args[0].split(",")
        if cmd in ("MOVE", "COPY"):
            for u in uids:
                m = box[u]
                self.next_uid += 1
                self.folders[args[1]][str(self.next_uid)] = {"msgid": m["msgid"], "flags": set(m["flags"]) - {"\\Deleted"}}
                if cmd == "MOVE":
                    del box[u]
            return "OK", []
        if cmd == "STORE":
            flag = args[2].strip("()")
            for u in uids:
                (box[u]["flags"].add if args[1].startswith("+") else box[u]["flags"].discard)(flag)
            return "OK", []
        if cmd == "EXPUNGE":
            for u in uids:
                if "\\Deleted" in box[u]["flags"]:
                    del box[u]
            return "OK", []
        raise AssertionError(cmd)


class RestoreTest(unittest.TestCase):
    def restore(self, M, ids):
        with redirect_stdout(io.StringIO()) as out:
            rc = imap_helper.cmd_restore(M, {}, ids)
        return rc, [json.loads(line) for line in out.getvalue().splitlines()]

    def check_back_unread(self, M):
        inbox = list(M.folders['"INBOX"'].values())
        self.assertEqual([m["msgid"] for m in inbox], ["<a@example.com>"])
        self.assertNotIn("\\Seen", inbox[0]["flags"])
        self.assertEqual(M.folders['"Trash"'], {})

    def test_moves_from_trash_to_the_inbox_unread(self):
        M = FakeIMAP()
        M.add('"Trash"', "<a@example.com>", ["\\Seen"])
        rc, out = self.restore(M, ["<a@example.com>"])
        self.assertEqual(rc, 0)
        self.assertEqual(out, [{"id": "<a@example.com>", "ok": True, "action": "restore"}])
        self.check_back_unread(M)

    def test_without_move_it_copies_then_expunges(self):
        M = FakeIMAP(caps="IMAP4rev1 UIDPLUS")
        M.add('"Trash"', "<a@example.com>", ["\\Seen"])
        self.assertEqual(self.restore(M, ["<a@example.com>"])[0], 0)
        self.check_back_unread(M)

    def test_a_message_no_longer_in_trash_is_not_found(self):
        M = FakeIMAP()
        rc, out = self.restore(M, ["<gone@example.com>"])
        self.assertEqual(rc, 1)
        self.assertEqual(out, [{"id": "<gone@example.com>", "ok": False, "action": "restore", "error": "not found"}])


class ArchiveTest(unittest.TestCase):
    """`archive` (the archive rule and no_action_clear: "archive" on password IMAP accounts) and its undo."""

    def run_cmd(self, fn, *args):
        with redirect_stdout(io.StringIO()) as out:
            rc = fn(*args)
        return rc, [json.loads(line) for line in out.getvalue().splitlines()]

    def test_archive_marks_read_and_moves_to_the_archive_folder(self):
        for caps in ("IMAP4rev1 UIDPLUS MOVE", "IMAP4rev1 UIDPLUS"):
            M = FakeIMAP(caps=caps)
            M.add('"INBOX"', "<a@example.com>")
            rc, out = self.run_cmd(imap_helper.cmd_write, M, {}, ["<a@example.com>"], "archive")
            self.assertEqual((rc, out), (0, [{"id": "<a@example.com>", "ok": True, "action": "archive"}]), caps)
            self.assertEqual(M.folders['"INBOX"'], {})
            [m] = M.folders['"Archive"'].values()
            self.assertEqual((m["msgid"], m["flags"]), ("<a@example.com>", {"\\Seen"}))
            self.assertEqual(M.folders['"Trash"'], {}, "archive never trashes")

    def test_with_no_special_use_flag_it_uses_the_configured_folder(self):
        M = FakeIMAP()
        M.list = lambda: ("OK", [b'(\\HasNoChildren) "/" "INBOX"', b'(\\HasNoChildren) "/" "Old mail"'])
        M.folders['"Old mail"'] = {}
        M.add('"INBOX"', "<a@example.com>")
        self.assertEqual(self.run_cmd(imap_helper.cmd_write, M, {"archive_folder": "Old mail"}, ["<a@example.com>"], "archive")[0], 0)
        self.assertEqual([m["msgid"] for m in M.folders['"Old mail"'].values()], ["<a@example.com>"])

    def test_restore_from_archive_brings_it_back_unread(self):
        M = FakeIMAP()
        M.add('"Archive"', "<a@example.com>", ["\\Seen"])
        rc, out = self.run_cmd(imap_helper.cmd_restore, M, {}, ["<a@example.com>"], True)
        self.assertEqual((rc, out), (0, [{"id": "<a@example.com>", "ok": True, "action": "restore"}]))
        [m] = M.folders['"INBOX"'].values()
        self.assertEqual((m["msgid"], m["flags"]), ("<a@example.com>", set()))
        self.assertEqual(M.folders['"Archive"'], {})


class WiringTest(unittest.TestCase):
    def setUp(self):
        self.trigger = tomllib.loads(read(TRIGGER))
        self.manifest = tomllib.loads(read(os.path.join(PLUGIN, "manifest.toml")))
        self.setup = re.sub(r"\s+", " ", self.manifest["setup"])

    def test_the_retro_trigger_is_event_driven_and_lands_in_review(self):
        self.assertEqual(self.trigger["app_id"], "inbox")
        self.assertNotIn("schedule", self.trigger)  # a plugin can't ship a cron
        self.assertEqual([o["event_type"] for o in self.trigger["on"]], ["InboxTriageRetroRequested"])
        self.assertTrue(self.trigger["go_to_review"])
        self.assertIn("triggers/inbox-triage/intents/retro.md", self.trigger["run"]["intent"])

    def test_exactly_one_shipped_trigger_answers_retro_requests(self):
        slugs = []
        for base, _, names in os.walk(os.path.join(PLUGIN, "triggers")):
            if "trigger.toml" in names:
                t = tomllib.loads(read(os.path.join(base, "trigger.toml")))
                if any(o["event_type"] == "InboxTriageRetroRequested" for o in t.get("on", [])):
                    slugs.append(t["slug"])
        self.assertEqual(slugs, ["inbox-triage-retro"])

    def test_the_intent_checks_the_setting_first_and_loads_its_knowhow(self):
        intent = read(INTENT)
        self.assertIn("  - inbox-triage-retro\n", intent)
        self.assertTrue(read(KNOWHOW).startswith("---\nname: Inbox Triage Retro\n"))
        step0 = intent[intent.index("0. "):intent.index("1. ")]
        self.assertIn("retro.enabled", step0)
        self.assertIn("emit no `InboxTriageRetroCompleted`", step0)
        self.assertIn("Never edit config.json", intent)
        self.assertIn("ask_user_question", intent)

    def test_every_script_the_retro_runs_ships(self):
        paths = set(re.findall(r"data/(scripts/\S+?\.py)", read(KNOWHOW)))
        paths |= set(re.findall(r"`(scripts/inbox-triage/\S+?\.py)`", read(KNOWHOW)))
        self.assertIn("scripts/inbox-triage/retro_tick.py", paths)
        self.assertIn("scripts/inbox-triage/imap_helper.py", paths)
        for rel in paths:
            self.assertTrue(os.path.exists(os.path.join(PLUGIN, rel)), rel)

    def test_one_ledger_path_everywhere(self):
        for path in (KNOWHOW, INTENT, TRIAGE_INTENT, TRIAGE_KNOWHOW):
            self.assertIn("artifacts/inbox/retro/ledger.json", read(path), path)
        for path in (KNOWHOW, INTENT, TRIAGE_INTENT, TRIAGE_KNOWHOW):
            self.assertIn("artifacts/inbox/retro/cleared-", read(path), path)

    def test_triage_logs_its_clears_and_leaves_restored_mail_alone(self):
        intent = read(TRIAGE_INTENT)
        self.assertIn('outcome: "restored"', intent)
        self.assertLess(intent.index('outcome: "restored"'), intent.index("3. Apply rules"))
        self.assertIn("cleared-<slug>.json", intent)

    def test_setup_asks_and_adds_the_schedule_check(self):
        step = self.setup[self.setup.index("11. **Ask whether to turn on the triage retro"):]
        for must in ('"enabled": false', '"twice-weekly"', "scripts/inbox-triage/retro_tick.py",
                     "`Inbox — triage retro schedule`", "`0 0 20 * * *`", "reuse it",
                     "Never create a trigger that answers `InboxTriageRetroRequested`"):
            self.assertIn(must, step)
        gate = self.setup[:self.setup.index("---")]
        self.assertIn("no `retro` key, ask step 11", gate)
        self.assertGreaterEqual(self.manifest["setup_revision"], 3)

    def test_setup_checks_the_retro_engine(self):
        check = self.setup[self.setup.index("## Check the engine resolves"):self.setup.index("## Triage, per account")]
        for rel in ("knowhow/inbox-triage-retro.md", "triggers/inbox-triage/intents/retro.md",
                    "scripts/inbox-triage/retro_tick.py"):
            self.assertIn(rel, check)
            self.assertTrue(os.path.exists(os.path.join(PLUGIN, rel)), rel)
        self.assertIn("exactly one answers `InboxTriageRetroRequested`", check)

    def test_the_app_and_the_check_agree_on_the_schedules(self):
        js = read(TRIAGE_JS)
        self.assertIn(f"path: '{os.path.relpath(os.path.join(SCRIPTS, 'retro_tick.py'), PLUGIN)}'", js)
        self.assertIn(f"value: '{tick.DEFAULT_SCHEDULE}'", js)
        for value, (weekdays, _) in tick.SCHEDULES.items():
            m = re.search(rf"value: '{value}'.*?days: \[([\d, ]+)\]", js)
            self.assertTrue(m, value)
            # Python weekday() is Monday 0; JS getDay() is Sunday 0.
            self.assertEqual(sorted(int(x) for x in m.group(1).split(",")), sorted((d + 1) % 7 for d in weekdays), value)

    def test_no_one_s_personal_mail_setup_ships(self):
        # The retro started as one workspace's procedure: none of its accounts, plates or senders ship.
        for path in (KNOWHOW, INTENT, TRIGGER):
            text = read(path)
            self.assertNotRegex(text, r"(?i)przone|receipto|spacemail|team@|YWA60U", path)
            self.assertNotRegex(text, r"\bSat\b|/Users/|/home/", path)
            addrs = re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", text)
            self.assertEqual([a for a in addrs if not re.search(r"@[\w.-]*example\.\w+$", a)], [], path)


if __name__ == "__main__":
    unittest.main()
