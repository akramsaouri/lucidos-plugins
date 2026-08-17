---
name: Email Triage
description: Per-account email triage with configurable schedules, rules, and AI categorization
---

## Overview

Automated email triage system. Each Gmail account has its own schedule and rule chain. Config lives in `artifacts/email-triage/config.json`.

## Triage Flow

1. **Read config** — load `artifacts/email-triage/config.json`
2. **Fetch emails** — depends on account type:
   - **Personal (non-shared)**: `read_emails(account, search="UNSEEN", limit=50)`
   - **Shared accounts** (`"shared": true`): Use date-based fetch with state file:
     1. Load state file (e.g. `artifacts/email-triage/state-<slug>.json`)
     2. Fetch with `read_emails(account, since=<last_run - 1 day>, limit=50)` — 1-day overlap for safety
     3. Filter out UIDs already in `state.processed`
     4. After processing, append new UIDs with today's date to `state.processed`
     5. Update `state.last_run` to current ISO timestamp
     6. Prune `state.processed` entries older than 30 days
     7. Save state file
   - On **first run** (last_run is null), use `since=<today - 2 days>` as bootstrap window
3. **For each email**, evaluate rules in order:
   - First matching rule's action is applied
   - If no rule matches → `default_action` applies (usually "triage")
4. **Execute actions**:
   - `skip` — do nothing, move on
   - `read` — mark email as read (remove the `UNREAD` label) but keep it in the inbox. Non-destructive way to clear noise. Gmail API: `POST /gmail/v1/users/me/messages/{id}/modify` with body `{"removeLabelIds": ["UNREAD"]}` for OAuth accounts; set the IMAP `\Seen` flag for non-OAuth accounts.
   - `delete` — move email to Trash (Gmail API: `POST /gmail/v1/users/me/messages/{id}/trash`)
   - `todo` — create reminder in Apple Reminders "Tasks" list via osascript
   - `notify` — send push notification with sender + subject
   - `flag` — add to high-priority list in summary
   - `triage` — AI reads the email and categorizes as actionable / FYI / noise. **Anything that needs no action (both FYI and noise) is "cleared" according to the account's `no_action_clear` setting** (see below): `read` (mark read, keep), `delete` (trash it), or `keep` (leave untouched, count only). Only `actionable` items survive to the summary. The legacy `no_auto_delete` flag is subsumed by `no_action_clear: "read"`. Note: explicit `delete` **rules** still fire regardless.
5. **Summary notification** — collect all actionable + flagged items, then **filter out any already in the notified-ledger** (see "Notification Dedup" below). Send one consolidated push notification **only if new (not-yet-notified) actionable/flagged items remain**, then append their ids to the ledger. If every actionable item was already notified on a prior run, **stay silent** — do not re-notify. If nothing is actionable, stay silent (exception-based alerting).

## Rule Evaluation

```
condition:
  field: "from" | "to" | "cc" | "subject" | "body"
  operator: "contains" | "equals" | "regex"
  value: string to match (case-insensitive for contains/equals)

action: "skip" | "read" | "todo" | "notify" | "flag" | "triage"
```

Rules are evaluated top-to-bottom per account. First match wins.

## Account Flag: `no_auto_delete`

Set `"no_auto_delete": true` on an account block to guard against the triage system *guessing wrong* and trashing something it shouldn't. The flag's scope is narrow and deliberate:

- It blocks **only the fuzzy AI judgment** — when the `triage` action's AI categorizes an email as "noise", that email is NOT deleted; it stays in the inbox and is only counted.
- It does **NOT** block explicit `delete` **rules**. Rules are deterministic and author-reviewed — if you wrote a rule that says "delete anything from `business-updates.facebook.com`", that's an intentional instruction, and it fires normally.

In short: with this flag on, the system deletes exactly what your rules tell it to and nothing more — it never deletes on a hunch. This is the right setting for a work mailbox where you want aggressive deletion of *known* noise (ad-platform notifications, duplicate alerts) but no surprise deletions from the AI fallback. Put every category you're sure about into an explicit `delete` rule; let the AI only flag/surface the rest.

## No-Action Clearing (`no_action_clear`)

Set `"no_action_clear"` per account to control what happens to emails that triage decides need **no action** — i.e. anything categorized FYI or noise. Previously FYI mail was left unread (piling up) and noise was deleted (or kept on `no_auto_delete` accounts). Now both outcomes are *cleared* uniformly so the inbox doesn't accumulate read-but-untouched clutter:

- `"read"` — mark read (remove `UNREAD`), keep in inbox. Non-destructive; clears the unread badge without losing anything. Right for work / shared mailboxes where deleting could hide a cofounder's mail.
- `"delete"` — move to Trash. Right for a personal mailbox where no-action mail is just clutter.
- `"keep"` — leave untouched, count only (the old default behavior). Use when you want zero automated changes.

If `no_action_clear` is absent, fall back to the legacy behavior: noise deleted unless `no_auto_delete: true`, FYI left in the inbox.

Choosing per account: prefer `read` for work or shared mailboxes, where deleting could bury
mail someone else also depends on. Prefer `delete` for a personal mailbox where no-action mail
is just clutter. Use `keep` when the account should see zero automated changes.

This setting governs only the AI's no-action verdict (FYI / noise) — author-written `delete` **rules** always fire regardless.

## Notification Dedup (Notified Ledger)

**The bug this prevents:** non-shared accounts (e.g. Personal) re-fetch *all* `UNSEEN` mail every run. Actionable emails are deliberately **left unread** (so the user can still act on them) and are never `read`/`delete`d — so without dedup, the *same* unread actionable email is re-discovered and re-notified on every hourly run. (Classic case: an App Store Connect "submission is complete" email sits unread for days because the release happens in App Store Connect, not by replying to the email — and the user got the same approval push ~once an hour.)

**The fix:** keep a per-account ledger of email ids we've already sent a notification about, and only notify about emails *not* in the ledger.

- **Ledger file:** `artifacts/email-triage/notified-<account-slug>.json` (the slug is the account name lowercased and hyphenated, with the provider prefix dropped: `Gmail - Work` -> `work`). Create it on first run if absent.
- **Schema:**
  ```json
  {
    "account": "Gmail - Personal",
    "notified": [
      {"id": "19efb1badde27730", "subject": "Review of your … submission is complete.", "date": "2026-06-25"}
    ]
  }
  ```
- **Key (`id`):** the stable message id. **For an OAuth-connected account, always use the provider's API message id — never the IMAP UID**, even when that particular run fetched over IMAP. The API id is the only identity that survives a transport switch.

  ⚠️ **Mixed-id-scheme hazard.** It is tempting to write "API id for OAuth accounts, IMAP UID otherwise" and key on whatever the run happened to have. That breaks, because the IMAP-timeout fallback below silently switches a run to the API mid-flight: the same email then gets two different identities depending on which transport that run used, and the ledger's dedup check misses.

  Observed in the wild: a ledger holding UID `999` for an item whose API id was `19ff420f49286535`, so the next API-transport run pushed it again. The state file showed the same drift — a block of numeric UIDs with one API-style id in the middle, marking the exact run where IMAP timed out.

  It is easy to miss, because the duplicate push only happens when an actionable item is *still inside the fetch window* AND the transport flips between runs. Shared accounts re-fetch by date, so a long-lived alert is exactly the shape that gets pushed twice.

  **Rules:**
  1. Key the ledger and `triage-<slug>.json` on the API message id. If a run fetched over IMAP, resolve the API id before writing (for Gmail: `GET /gmail/v1/users/me/messages?q=rfc822msgid:<Message-ID>`) rather than persisting a bare UID.
  2. Treat a purely-numeric `id` in either file as **legacy**. Never write a new one.
  3. The dedup check must tolerate legacy entries: an item counts as already-notified if *either* its API id or its IMAP UID is present. Do not delete the old numeric entries — they are still load-bearing for mail inside the 30-day window.
- **Notification step:**
  1. After rules + AI categorization, build the set of items that *would* notify (actionable + flagged).
  2. Drop any whose `id` is already in `notified`.
  3. If the remaining (new) set is non-empty → send the consolidated notification covering **only** those new items, then append each to `notified` with today's date.
  4. If the remaining set is empty → **send nothing** (the user has already been told about everything still in the inbox).
- **Pruning:** on each run, drop `notified` entries with `date` older than 30 days (matches the state-file convention). Once an email leaves `UNSEEN`/the fetch window it won't be re-fetched anyway, so the ledger stays small.
- **Relationship to the triage output file:** `triage-<slug>.json` still lists **all** currently-actionable items (so downstream consumers see the full picture). The ledger gates only the *push notification*, not the output file.
- **Relationship to shared-account state files:** shared accounts already avoid re-notification because processed UIDs land in `state.processed` and aren't re-fetched. The ledger is the equivalent guarantee for **non-shared** accounts, and a harmless belt-and-suspenders safety net for shared ones — apply it uniformly so the invariant "never push the same actionable item twice" holds for every account.

## Todo Creation

When action is `todo`, create a reminder in Apple Reminders via osascript:

```bash
osascript -e 'tell application "Reminders"
  tell list "Tasks"
    make new reminder with properties {name:"<subject>", body:"From: <sender>\n\n<brief summary>"}
  end tell
end tell'
```

- **List**: "Tasks"
- **Name**: email subject (or a short actionable summary)
- **Body**: sender + brief summary of what needs to be done
- No external credentials needed — runs locally via AppleScript.

## Event Tracking

After processing, emit `EmailTriageCompleted` with per-account results:
```json
{
  "summary": "Triaged 3 emails across Work and Personal...",
  "account_results": {
    "Gmail - Work": {
      "unseen": 2, "processed": 2, "skipped": 0,
      "actionable": 2, "fyi": 0, "noise": 0
    }
  }
}
```

Include all accounts that were processed, even those with 0 unseen. This keeps the event queryable for monitoring.

## Triage Output Files

Write actionable results to `artifacts/email-triage/triage-<account-slug>.json` so downstream systems can consume them without re-scanning inboxes:
```json
{
  "account": "Gmail - Work",
  "triaged_at": "ISO timestamp",
  "emails": [
    {
      "id": "919",
      "from": "sender", "subject": "...",
      "action": "respond|act|review",
      "summary": "brief description"
    }
  ]
}
```

**Every email entry MUST carry `id`** — the stable message id (Gmail API message id for OAuth accounts, IMAP UID for non-OAuth), the same identity used in the notified-ledger and state files. Downstream consumers key their persistent "done"/resolved state on `email:<slug>:<id>`, so a missing or unstable id means either (a) resolved items re-surface, or (b) a genuinely new email that happens to reuse a subject gets wrongly hidden. Never omit it.

**The output file is a fresh snapshot, not an append log.** On every run, rewrite `emails` to contain *only the items that are still actionable right now*. Do NOT carry forward stale entries. This matters most for shared accounts: their `state.processed` list stops old UIDs being re-fetched, but that also means an item that has aged out of the fetch window will never be re-evaluated — so if you append instead of replacing, the output file keeps advertising items that are long gone and downstream consumers keep showing them. Concretely: build the new `emails` array from this run's fetch window, and for shared accounts also drop any prior entry whose id is no longer within the current window. When nothing is actionable, write `"emails": []` (do not leave the previous run's list in place).

## Operational Notes

- **Fetching over the provider API: pass the account's OWN token explicitly.** `http_request` auto-injects the workspace's *default* credential for a provider's domain, whichever account the run is for. On Gmail that means a call to `gmail.googleapis.com` returns HTTP 200 with a perfectly plausible message list — from the wrong inbox. Message ids are per-mailbox, so those ids then 404 against the intended account, and that 404 is the *only* reason the swap gets caught: a run that stopped at the list step would have triaged one mailbox's mail into another's output file and ledger.

  For any account that is not the default connection, fetch via `run_python` with that account's own token from the environment:

  ```python
  tok = os.environ["OAUTH_<PROVIDER>_ACCESS_TOKEN"]   # the account's own connection name
  req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
  ```

  **Verify the mailbox before triaging a single message** — for Gmail, `GET /gmail/v1/users/me/profile` returns `emailAddress`; assert it matches the account's configured `address`. One cheap call, and a token mix-up becomes impossible to act on.

- **IMAP can time out — fall back to the provider API for OAuth accounts.** `read_emails` connects over IMAP (Gmail: `imap.gmail.com:993`) and sometimes fails with `IMAP connect ... timed out after 30s`. An OAuth-connected account does **not** have to abort the run — fetch the same mail over REST instead, which is the transport already used for the `read`/`delete` actions. For Gmail:
  1. List: `GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread%20in:inbox&maxResults=50` (for shared accounts use `q=in:inbox after:YYYY/MM/DD` to mirror the `since` window).
  2. Per message: `GET .../messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To` — which returns `snippet` too, usually enough to categorize without pulling the body.

  Reach for `format=full` only when a rule matches on the `body` field or the snippet is too thin to judge. Note the id consequence: this path yields API message ids, which is why the ledger must key on those uniformly — see the mixed-id-scheme hazard above.

- **Empty inboxes are normal.** Most hourly runs find 0 unseen emails — exit silently.
- When all accounts report 0 unseen, do not emit an event or send any notification.
- Crash/error alerts (Sentry and similar) are typically categorized as `actionable`.

## State File Schema (Shared Accounts)

```json
{
  "account": "Gmail - Work",
  "last_run": "2026-04-27T16:00:00Z",
  "processed": [
    {"uid": 12345, "date": "2026-04-27"},
    {"uid": 12340, "date": "2026-04-26"}
  ]
}
```

- **last_run**: ISO 8601 timestamp of the last triage run (null on first run)
- **processed**: list of `{uid, date}` entries — UIDs already triaged
- **Cleanup**: prune entries with `date` older than 30 days on each run
- State files live at `artifacts/email-triage/state-<account-slug>.json`
- Config points to state files via `"state_file"` key on shared accounts

## Design Principles

- **Exception-based**: only notify when something needs attention
- **Per-account config**: schedules and rules are independent per account
- **First-match-wins**: rule order matters — put specific rules before general ones
- **AI fallback**: emails that don't match any rule get AI categorization
