---
name: Gatekeepr VPN expiry alerts and background check
description: "How Gatekeepr's VPN expiry alerts work: the background-check trigger and interval, thresholds in settings.json, per-session dedup in state.json, and its events. Load when an Appgate alert didn't arrive or fired twice, the widget looks stale, or when setting up, changing or forwarding alerts."
---

# Gatekeepr: expiry alerts and the background check

Everything runs through one script, `data/scripts/gatekeepr/check.py`, with no LLM run per check. It reads the
session with `reader.py` (see `gatekeepr/appgate-vpn-expiry` for the CLI and its states), writes the snapshot the
widget and app draw, sends any alert that's due, and announces changes. It always exits 0, so a broken CLI
shows up in the app and as one "problem" alert, not as a failed trigger on every run.

## The two triggers

| Trigger | Fires on | Who makes it |
|---|---|---|
| **Gatekeepr — expiry check** (the background check) | cron `0 */5 * * * *` by default (every 5 minutes, at :00, :05, …) | Plugin setup, because a cron can't ship in a plugin. The app's Background check switch creates it too when it's missing |
| **Gatekeepr — refresh** | `GatekeeprRefreshRequested` | Shipped with the plugin, registered at install |

Both run `scripts/gatekeepr/check.py` as a **script** trigger. Create the cron one like this (check
`lucidos triggers list` first and update an existing one rather than adding a second):

```bash
lucidos triggers create --name "Gatekeepr — expiry check" \
  --run '{"type": "script", "path": "scripts/gatekeepr/check.py"}' \
  --cron-expressions '["0 */5 * * * *"]' --app-id gatekeepr
```

Run it once with `lucidos triggers run --id <id>`. Leave `go_to_review` off, so its runs go straight to Archive:
the notification is the output. A script trigger runs no LLM, so it takes no model pin, and the side-effect
grant (which gates an intent's commands) doesn't apply.

**The interval is the user's, and 5 minutes is the default.** The app's Background check section turns the
check on and off and sets how often it runs: every 1, 2, 5, 10, 15 or 30 minutes. Each writes the trigger itself
(`lucidos.triggers.update`), so the trigger stays the one source of truth:

| In the app | On the trigger |
|---|---|
| Switch off | `paused: true` (the trigger is kept) |
| Switch on | `paused: false`, or a `create` like the one above when no cron trigger runs `check.py` |
| How often: every N minutes | `cron_expressions: ["0 */N * * * *"]` (every minute is `0 * * * * *`) |

Any other cron (set by hand or in the Triggers panel) keeps running, and the app shows it as Custom. Every interval
divides an hour, so the checks stay evenly spaced.

An alert lands at the first check at or past its threshold, so up to one interval late: at 5 minutes the
30-minute alert arrives with 25 to 30 minutes left, the 5-minute alert with 0 to 5, the expiry alert up to 5
minutes after. Each check costs one CLI call of a few milliseconds and a short Python process, so a tighter
interval is cheap; it just means more trigger runs.

The checks run on the Mac, so nothing fires while it sleeps. After a wake, the first check sends only the most
urgent alert that's due (see below).

**Uninstalling the plugin doesn't remove the cron trigger**, since setup created it rather than the plugin.
Delete "Gatekeepr — expiry check" afterwards, or it fails on every run with a missing script.

## Alerts and their settings

`data/artifacts/gatekeepr/settings.json`, written by the Gatekeepr app's Alerts and Gatekeepr CLI sections.
Every key is optional; no file means the defaults. The background check's interval isn't here: it lives on
the trigger (see above).

```json
{
  "binary_path": "/opt/tools/gatekeepr",
  "alerts": [
    {"id": "warn", "kind": "before", "minutes": 30, "enabled": true},
    {"id": "final", "kind": "before", "minutes": 5, "enabled": true},
    {"id": "expired", "kind": "expired", "enabled": true},
    {"id": "problem", "kind": "problem", "enabled": true}
  ]
}
```

- **`before`**: notify once `secondsLeft` is at or under `minutes` × 60 while `active` or `expiringSoon`.
  `minutes` is a whole number from 1 to 1440. The app edits `warn` and `final`; a hand-added `before` alert with
  its own `id` works too. The `id`, not the threshold, keys the dedup, so editing a threshold mid-session
  doesn't re-send an alert that already went.
- **`expired`**: notify once the state is `expired`, if it expired under 45 minutes ago, which outlasts the
  longest interval (30 minutes). An older expiry (a first check days later, a Mac that slept) is marked done
  silently.
- **`problem`**: notify once when the check can't read the session (any `error_kind`), since no other alert can
  fire then. It re-arms when a read succeeds or the kind of problem changes.
- With `alerts` present, only the entries listed exist. A malformed entry is skipped and named in
  `status.json` `notes`, and the app shows it under Gatekeepr CLI.
- `signedOut` and `noSession` never alert.

Notifications go out through `lucidos notify --app-id gatekeepr`, titled like "Appgate VPN: 25m left" or
"Appgate VPN session expired", with the local clock time in the message. The tap opens the notification, whose
**Open Gatekeepr** button opens the app.

### Forwarding alerts to another channel

Once an alert's notification is delivered, check.py also emits **`GatekeeprAlertSent`** with the same title and
message (schema under "Files and events"). To get alerts on Telegram, Slack, a phone or anywhere else, add a
workspace **script** trigger on that event that sends `title` and `message` on. The forwarder reads the payload
from `TRIGGER_EVENT_PAYLOAD` (unwrap a `payload` envelope if present, as check.py's `request_payload()` does)
and names the credential it uses in its own text (`os.environ["CRED_…"]` or a `# lucidos-credentials:` header),
since the engine sets a credential only for a script that names it. Keep the forwarder and its trigger in the
workspace, outside the plugin's folders, so a plugin update never overwrites them.

The event rides the same dedup, so each alert is forwarded once per session. Forwarding is best effort: a failed
emit or a failing forwarder never blocks or re-queues the inbox notification.

## Dedup: once per session

`data/artifacts/gatekeepr/state.json` keeps a ledger keyed on the session's `sessionStart`:

```json
{
  "fired": {"2026-10-11T23:18:18+02:00": {"warn": "2026-10-12T22:50:02+02:00", "final": "2026-10-12T23:15:01+02:00"}},
  "problem": null,
  "fingerprint": ["expiringSoon", "2026-10-11T23:18:18+02:00", "2026-10-12T23:18:16+02:00", null, null],
  "last_checked_at": "2026-10-12T23:15:01+02:00"
}
```

- Each alert id fires once per `sessionStart`. A new sign-in, or a renewal from Appgate's warning (which starts
  a new session with `sessionStartKind: "renewal"`), has a new `sessionStart`, so every alert re-arms.
- When one check finds several alerts crossed at once, it sends only the smallest threshold and marks the rest
  done, so a wake at 4 minutes left sends "4m left", not "30 minutes" and "5 minutes" together. On `expired`,
  any `before` alert still pending is marked done with it.
- An alert whose `lucidos notify` fails stays pending, and the next check tries again.
- The ledger keeps the newest 5 sessions. A file lock (`.check.lock`) serialises the cron and a Refresh that
  land together, so neither sends the same alert twice.
- To re-send an alert for testing, delete that session's entry under `fired`. Don't hand-edit `fingerprint`.

## Files and events

All under `data/artifacts/gatekeepr/`, never inside the plugin's folders:

| File | Written by | Holds |
|---|---|---|
| `settings.json` | the app (`lucidos.data.write`, so it's committed) | the alerts and `binary_path` above |
| `status.json` | every check | the reader's status wrapper, plus `notes` and `request_id` when it answered one |
| `history.json` | a check whose state changed, a requested check, or when missing | the reader's history wrapper |
| `state.json` | every check | the dedup ledger, the last problem kind, the change fingerprint |

`status.json`, `history.json` and `state.json` change on every run, so check.py writes them straight to disk
and keeps a `.gitignore` beside them that leaves them out of the workspace repo.

**`GatekeeprStatusChecked`** (emitted by check.py) fires when the state changed (state, `sessionStart`,
`expiresAt`, or the error), and on every requested check:

```json
{"summary": "Appgate VPN expiring soon: 25m left, expires 23:18 (signed in Sun 11 Oct 23:18).",
 "state": "expiringSoon", "previous_state": "active", "changed": true, "ok": true,
 "checked_at": "...", "session_start": "...", "expires_at": "...", "seconds_left": 1534, "time_left": "25m",
 "alerts_sent": ["warn"], "request_id": "app-…"}
```

`error` and `error_kind` appear on failure. A quiet scheduled run (nothing changed) emits nothing.

**`GatekeeprAlertSent`** (emitted by check.py) fires once for each alert whose `lucidos notify` succeeded, right
after it, and never for an alert that failed to send:

```json
{"summary": "Appgate VPN: 25m left. Your session ends at 23:18. ...", "alert_id": "warn",
 "title": "Appgate VPN: 25m left", "message": "Your session ends at 23:18. ...", "state": "expiringSoon",
 "session_start": "...", "expires_at": "...", "time_left": "25m"}
```

`alert_id` is the settings.json alert id, or `problem` for the can't-read notice. The session fields appear
only when the check read them.
See "Forwarding alerts to another channel" above.

**`GatekeeprRefreshRequested`** asks for a check right away: `{"summary": "...", "request_id": "<any string>",
"source": "app" | "widget" | "agent"}`. The answer is a `GatekeeprStatusChecked` with the same `request_id`.
From a thread: `lucidos events emit GatekeeprRefreshRequested --payload '{"summary": "Check the VPN session", "request_id": "agent-1", "source": "agent"}'`.

## The widget and the app

The **Gatekeepr** widget (`apps/gatekeepr-widget`) and the **Gatekeepr** app read `status.json` and draw the
session as a visual desk timer (`timer.js`, one file shipped in both app folders). A full turn is the session
length; the solid disc from 12 o'clock is `secondsLeft / sessionLengthSeconds`, with a sliver kept while any time
is left so expiring soon never looks empty. The dial's quarter labels come from `sessionLengthSeconds`. Between
checks they count `secondsLeft` down by the time since the snapshot's `now`. That lands on the CLI's own
`expiresAt` and turns the colour at its `warnThresholdSeconds`; nothing recomputes expiry. Both redraw on
`GatekeeprStatusChecked`; the widget also re-reads every 60 seconds.

When the snapshot has missed a background check (older than the interval plus 2 minutes, or 7 minutes when the
check is off, paused or on a custom cron), the widget asks for a refresh itself, at most once per 5 minutes
while it's on screen, and shows "checked … ago" with a Refresh button. It reads the interval off the trigger
every 15 minutes and when it comes back on screen. The app asks on open when the snapshot is over a minute old.
So with the background check off, alerts still fire while one of them is open, and only then. The app's
Background check section says whether the check is on, how often it runs, and whether its last run failed.

## When something looks wrong

| Symptom | Check |
|---|---|
| No alert arrived | Is "Gatekeepr — expiry check" in `lucidos triggers list`, unpaused, with recent `last_run`? (The app's Background check switch shows the same.) Is the alert enabled in settings.json? Was it already sent this session (`state.json` `fired`)? Did the Mac sleep through the window (only the most urgent alert is sent on wake)? Does `status.json` say `ok: false`? |
| An alert came twice | Two cron triggers running `scripts/gatekeepr/check.py`? Keep one. (Both still share one ledger, so a true duplicate means two different `sessionStart` values: a renewal in between.) |
| Widget shows "checked 2h ago" | The background check is off or paused, or the refresh trigger is paused. See the app's Background check section. |
| "Can't check" with `not_installed` | See "Installing gatekeepr" in `gatekeepr/appgate-vpn-expiry`, or set the app's Binary path. |
| Wrong expiry time | Compare with `<binary> --json` by hand. The plugin never adjusts the CLI's `expiresAt`, so a wrong time is gatekeepr's to fix. |
