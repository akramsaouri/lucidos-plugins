#!/usr/bin/env python3
"""Gatekeepr expiry check: the script behind both of the plugin's triggers. No LLM runs.

- "Gatekeepr — expiry check": the background check, a cron trigger that plugin setup (or the app's
  Background check switch) creates. Every 5 minutes (`0 */5 * * * *`) unless the user picks another
  interval in the app.
- "Gatekeepr — refresh": shipped with the plugin, on GatekeeprRefreshRequested (the app's and widget's
  Refresh).

Each run reads the session with reader.py (one `gatekeepr --json`, a few milliseconds), then:

1. Writes data/artifacts/gatekeepr/status.json, the snapshot the widget and the app draw.
2. Sends a notification when an enabled alert in settings.json is newly crossed. Each alert fires once per
   session: state.json keys its ledger on the session's `sessionStart` plus the alert id, so a new sign-in or
   a renewal starts afresh. When one check finds several alerts crossed (the Mac slept through the 30-minute
   mark, say), only the most urgent is sent and the rest are marked done. An expiry more than 45 minutes old
   is marked done without a notification, so a first check days later doesn't announce an old session. 45
   minutes outlasts the longest interval the app offers (30), so the first check after an expiry still sends.
3. Refreshes history.json (`gatekeepr history --json`) when the state changed, on a requested check, or when
   the file is missing. A quiet scheduled run makes no second CLI call.
4. Emits GatekeeprStatusChecked when the state changed (state, session, expiry or error), and always when
   answering a GatekeeprRefreshRequested, so a waiting Refresh hears back.
5. Emits GatekeeprAlertSent for each alert whose notification was delivered, with its title and message, so a
   workspace trigger can forward it to another channel. It rides the same dedup: once per alert per session.

A check that can't read the session (no binary, unreadable logs, an unknown schemaVersion) sends the
"problem" alert once per kind of problem, then stays quiet until the kind changes or a read succeeds. The
script still exits 0: a non-zero exit would raise a scheduler failure notice every 5 minutes, and the
problem is already in status.json, where the widget and the app show it.

Runtime state lives under data/artifacts/gatekeepr/, never in the plugin's own folders, and is written
straight to disk rather than through `lucidos data write`, since it changes on every run. A .gitignore there
keeps it out of the workspace repo. settings.json, which the app writes, stays tracked.
"""
import fcntl
import json
import os
import subprocess
import sys

sys.dont_write_bytecode = True  # no __pycache__ beside the plugin's scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reader as R  # noqa: E402

APP_ID = "gatekeepr"
EVENT = "GatekeeprStatusChecked"
REQUEST_EVENT = "GatekeeprRefreshRequested"
ALERT_EVENT = "GatekeeprAlertSent"
EXPIRED_RECENT_SECONDS = 45 * 60
MAX_THRESHOLD_MINUTES = 24 * 60
LEDGER_SESSIONS = 5

DEFAULT_ALERTS = [
    {"id": "warn", "kind": "before", "minutes": 30, "enabled": True},
    {"id": "final", "kind": "before", "minutes": 5, "enabled": True},
    {"id": "expired", "kind": "expired", "enabled": True},
    {"id": "problem", "kind": "problem", "enabled": True},
]
GITIGNORE = ("# Gatekeepr runtime state, rewritten by every check. settings.json stays tracked.\n"
             "status.json\nhistory.json\nstate.json\n.check.lock\n*.tmp\n")


def alerts_from(settings):
    """-> (alerts, problem or None). No `alerts` key means the defaults; a malformed entry is dropped."""
    raw = settings.get("alerts")
    if raw is None:
        return [dict(a) for a in DEFAULT_ALERTS], None
    if not isinstance(raw, list):
        return [dict(a) for a in DEFAULT_ALERTS], "settings.json `alerts` isn't a list, so the defaults were used"
    alerts, dropped = [], []
    for entry in raw:
        if not isinstance(entry, dict) or not entry.get("id") or entry.get("kind") not in ("before", "expired", "problem"):
            dropped.append(entry)
            continue
        alert = {"id": str(entry["id"]), "kind": entry["kind"], "enabled": entry.get("enabled", True) is not False}
        if alert["kind"] == "before":
            minutes = entry.get("minutes")
            if type(minutes) is not int or not 1 <= minutes <= MAX_THRESHOLD_MINUTES:
                dropped.append(entry)
                continue
            alert["minutes"] = minutes
        alerts.append(alert)
    problem = f"settings.json has {len(dropped)} alert(s) Gatekeepr can't read, which were skipped" if dropped else None
    return alerts, problem


def due(status, alerts, done):
    """-> (the alert to send or None, the alert ids this check settles). `done` is this session's ledger."""
    state = status.get("state")
    if state in ("active", "expiringSoon"):
        left = status["secondsLeft"]
        crossed = sorted((a for a in alerts if a["kind"] == "before" and a["enabled"] and a["id"] not in done
                          and left <= a["minutes"] * 60), key=lambda a: a["minutes"])
        return (crossed[0] if crossed else None), [a["id"] for a in crossed]
    if state == "expired":
        # Any "before" alert still pending is moot now, so it settles with the expiry.
        pending = [a for a in alerts if a["kind"] in ("before", "expired") and a["enabled"] and a["id"] not in done]
        send = next((a for a in pending if a["kind"] == "expired"), None)
        if send and -status["secondsLeft"] > EXPIRED_RECENT_SECONDS:
            send = None
        return send, [a["id"] for a in pending]
    return None, []


def message_for(alert, status):
    """-> (title, message). The title never repeats in the message (system-knowhow/notifications § 4)."""
    if alert["kind"] == "before":
        return (f"Appgate VPN: {status['timeLeft']} left",
                f"Your session ends at {R.clock(status['expiresAt'])}. Renew from Appgate's warning, or sign in "
                f"again, to stay on the VPN.")
    return ("Appgate VPN session expired",
            f"It ran out at {R.clock(status['expiresAt'])}. Sign in to Appgate again to get back on the VPN.")


def problem_message(wrapper):
    kind = wrapper.get("error_kind")
    error = (wrapper.get("status") or {}).get("error") or "no reason given"
    title = "Gatekeepr CLI not found" if kind == "not_installed" else "Gatekeepr can't read your VPN session"
    return title, f"{error} VPN expiry alerts are off until this is fixed."


def lucidos(*args):
    try:
        proc = subprocess.run(["lucidos", *args], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"lucidos {args[0]} failed: {e}", file=sys.stderr)
        return False
    if proc.returncode != 0:
        print(f"lucidos {args[0]} failed: {proc.stderr.strip()}", file=sys.stderr)
    return proc.returncode == 0


def notify(alert_id, title, message, status):
    """Send one alert. Once the inbox notification is delivered, also emit GatekeeprAlertSent carrying the same
    title and message, so a workspace trigger can forward the alert elsewhere (Telegram, Slack, a phone) with
    its own credentials. The event is best effort: a failed emit never re-queues the alert."""
    if not lucidos("notify", "--title", title, "--message", message, "--app-id", APP_ID):
        return False
    payload = {"summary": f"{title}. {message}", "alert_id": alert_id, "title": title, "message": message,
               "state": status.get("state")}
    for key, field in (("session_start", "sessionStart"), ("expires_at", "expiresAt"), ("time_left", "timeLeft")):
        if field in status:
            payload[key] = status[field]
    lucidos("events", "emit", ALERT_EVENT, "--payload", json.dumps(payload))
    return True


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else default
    except (OSError, ValueError):
        return default


def request_payload():
    """The GatekeeprRefreshRequested payload when this run answers one, else None. Read defensively: a stored
    payload may arrive wrapped in an envelope (system-knowhow/triggers § The envelope)."""
    if os.environ.get("TRIGGER_EVENT_TYPE") != REQUEST_EVENT:
        return None
    try:
        raw = json.loads(os.environ.get("TRIGGER_EVENT_PAYLOAD") or "{}")
    except ValueError:
        raw = {}
    if not isinstance(raw, dict):
        return {}
    return raw.get("payload") if isinstance(raw.get("payload"), dict) else raw


def fingerprint(wrapper):
    status = wrapper.get("status") or {}
    return [status.get("state"), status.get("sessionStart"), status.get("expiresAt"),
            wrapper.get("error_kind"), status.get("error")]


def run():
    root = R.state_dir()
    os.makedirs(root, exist_ok=True)
    ignore = os.path.join(root, ".gitignore")
    if not os.path.exists(ignore):
        with open(ignore, "w") as f:
            f.write(GITIGNORE)

    # One check at a time: the cron and a Refresh landing together would otherwise both send an alert.
    with open(os.path.join(root, ".check.lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return check(root)


def check(root):
    request = request_payload()
    settings, _ = R.load_settings()  # read_status() reports a settings problem in its own notes
    alerts, alerts_problem = alerts_from(settings)
    state_path = os.path.join(root, "state.json")
    state = read_json(state_path, {})
    wrapper = R.read_status()
    status = wrapper["status"]

    notes = (wrapper.pop("notes", None) or []) + ([alerts_problem] if alerts_problem else [])
    if notes:
        wrapper["notes"] = notes
    if request is not None:
        wrapper["request_id"] = request.get("request_id")
    write_json(os.path.join(root, "status.json"), wrapper)

    sent = []
    ledger = state.get("fired") if isinstance(state.get("fired"), dict) else {}
    session = status.get("sessionStart")
    if wrapper["ok"] and session:
        done = ledger.pop(session, None)
        done = done if isinstance(done, dict) else {}
        alert, settled = due(status, alerts, done)
        delivered = True
        if alert:
            delivered = notify(alert["id"], *message_for(alert, status), status)
            if delivered:
                sent.append(alert["id"])
        if delivered:  # an undelivered alert stays pending, so the next check tries again
            for alert_id in settled:
                done[alert_id] = wrapper["checked_at"]
        if done:
            ledger[session] = done  # re-inserted last, so the oldest sessions sit first
        # Keep the newest few sessions: enough for a renewal to start clean, never an unbounded file.
        while len(ledger) > LEDGER_SESSIONS:
            del ledger[next(iter(ledger))]

    problem = state.get("problem")
    if wrapper["ok"]:
        problem = None
    elif wrapper.get("error_kind") != problem:
        enabled = next((a["enabled"] for a in alerts if a["kind"] == "problem"), False)
        if not enabled or notify("problem", *problem_message(wrapper), status):
            if enabled:
                sent.append("problem")
            problem = wrapper.get("error_kind")

    current = fingerprint(wrapper)
    changed = current != state.get("fingerprint")
    history_path = os.path.join(root, "history.json")
    if (changed or request is not None or not os.path.exists(history_path)) and wrapper.get("error_kind") != "not_installed":
        write_json(history_path, R.read_history(wrapper.get("binary")))

    previous = (state.get("fingerprint") or [None])[0]
    write_json(state_path, {"fired": ledger, "problem": problem, "fingerprint": current,
                            "last_checked_at": wrapper["checked_at"]})

    if changed or request is not None:
        payload = {
            "summary": R.summarize(wrapper),
            "state": status.get("state"),
            "previous_state": previous,
            "changed": changed,
            "ok": wrapper["ok"],
            "checked_at": wrapper["checked_at"],
        }
        for key, field in (("session_start", "sessionStart"), ("expires_at", "expiresAt"),
                           ("seconds_left", "secondsLeft"), ("time_left", "timeLeft"), ("error", "error")):
            if field in status:
                payload[key] = status[field]
        if wrapper.get("error_kind"):
            payload["error_kind"] = wrapper["error_kind"]
        if sent:
            payload["alerts_sent"] = sent
        if request and request.get("request_id"):
            payload["request_id"] = request["request_id"]
        lucidos("events", "emit", EVENT, "--payload", json.dumps(payload))

    print(R.summarize(wrapper) + (f" Sent: {', '.join(sent)}." if sent else ""))
    return 0


if __name__ == "__main__":
    sys.exit(run())
