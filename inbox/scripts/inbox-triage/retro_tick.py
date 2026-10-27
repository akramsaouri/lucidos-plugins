#!/usr/bin/env python3
"""Inbox's triage retro schedule check: asks for a retro when the Retro setting is on and one is due.

Runs from the workspace cron "Inbox — triage retro schedule" (daily, created by Inbox setup or the Inbox app),
with no AI. The setting is the one switch, so turning the retro off or changing its schedule in Inbox takes effect
on the next evening without touching any trigger:

  artifacts/inbox/settings.json   {"retro": {"enabled": true, "schedule": "twice-weekly"}}
  artifacts/inbox/retro/tick.json {"last_requested": "YYYY-MM-DD"}, written here

Due when the retro is on, it hasn't asked today, and today is a scheduled day (daily; Wednesday and Sunday;
Sunday) or the last ask is older than the schedule's longest gap (a missed evening catches up). When due it emits
InboxTriageRetroRequested, which the shipped "Inbox — triage retro" trigger answers.

Usage (cwd = workspace root): python data/scripts/inbox-triage/retro_tick.py [--dry-run]
"""
import argparse, datetime as dt, json, os, subprocess, sys

WORKSPACE = os.environ.get("LUCIDOS_WORKSPACE", ".")
SETTINGS = os.path.join(WORKSPACE, "data/artifacts/inbox/settings.json")
TICK = os.path.join(WORKSPACE, "data/artifacts/inbox/retro/tick.json")

# schedule -> (weekdays it runs on, Monday = 0; longest gap in days before a missed run catches up)
SCHEDULES = {
    "daily": (range(7), 1),
    "twice-weekly": ((2, 6), 4),
    "weekly": ((6,), 7),
}
DEFAULT_SCHEDULE = "twice-weekly"
FIRST_LOOKBACK_DAYS = 4
MAX_LOOKBACK_DAYS = 30  # the cleared log keeps 30 days


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def retro_setting(settings):
    """(enabled, schedule) from the settings file. Off unless `enabled` is exactly true."""
    r = settings.get("retro") if isinstance(settings, dict) else None
    r = r if isinstance(r, dict) else {}
    return r.get("enabled") is True, r.get("schedule") or DEFAULT_SCHEDULE


def due(settings, last_requested, today):
    """Whether a retro is due today. `last_requested` is a date or None."""
    enabled, schedule = retro_setting(settings)
    if not enabled or schedule not in SCHEDULES:
        return False
    if last_requested is not None and last_requested >= today:
        return False
    days, gap = SCHEDULES[schedule]
    if today.weekday() in days:
        return True
    return last_requested is not None and (today - last_requested).days > gap


def since_for(last_requested, today):
    """The first day the retro reviews: a day before the last ask, so windows overlap, within the cleared log."""
    start = last_requested - dt.timedelta(days=1) if last_requested else today - dt.timedelta(days=FIRST_LOOKBACK_DAYS)
    return max(start, today - dt.timedelta(days=MAX_LOOKBACK_DAYS))


def last_requested_of(tick):
    try:
        return dt.date.fromisoformat(tick.get("last_requested"))
    except (TypeError, ValueError):
        return None


def main(argv=None, today=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="say whether a retro is due, emit and write nothing")
    a = ap.parse_args(argv)
    today = today or dt.date.today()
    settings, tick = read_json(SETTINGS), read_json(TICK)
    last = last_requested_of(tick)
    enabled, schedule = retro_setting(settings)
    if not due(settings, last, today):
        print(json.dumps({"due": False, "enabled": enabled, "schedule": schedule, "last_requested": last and last.isoformat()}))
        return 0
    since = since_for(last, today).isoformat()
    payload = {"summary": f"Triage retro since {since}", "since": since, "schedule": schedule, "source": "schedule"}
    if a.dry_run:
        print(json.dumps({"due": True, **payload}))
        return 0
    subprocess.run(["lucidos", "events", "emit", "InboxTriageRetroRequested", "--summary", payload["summary"],
                    "--payload", json.dumps(payload)], check=True)
    # Recorded only after the emit lands, so a failed emit is retried tomorrow.
    os.makedirs(os.path.dirname(TICK), exist_ok=True)
    with open(TICK, "w") as f:
        json.dump(dict(tick, last_requested=today.isoformat()), f, indent=2)
    print(json.dumps({"due": True, **payload}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
