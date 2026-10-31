---
name: Inbox Triage Retro
description: How Inbox's triage retro goes back over mail triage archived or trashed on every account, restores anything the user would want to see, and suggests rule changes in its own thread. Covers the Retro setting, the daily schedule check that decides when a retro is due, the cleared log triage writes, the ledger that stops a mail being restored twice, and the InboxTriageRetroCompleted event. Load when a retro runs, when a wrongly cleared mail is found, or when changing what the retro counts as a miss.
---

# Inbox Triage Retro

The retro is the safety net behind triage. Triage clears mail on its own judgement, and a wrong clear can bury a
bill or a ticket. On a schedule, the retro reads what triage archived or trashed since the last retro, brings back
what the user would have wanted, and suggests rule changes so triage keeps that mail next time. Triage's own
procedure is in `knowhow/inbox-triage.md`.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| Setting | `artifacts/inbox/settings.json`, `retro` | `{"enabled": true, "schedule": "twice-weekly"}`. The one switch. |
| Schedule check | workspace cron "Inbox — triage retro schedule", running `scripts/inbox-triage/retro_tick.py` | Daily, no AI. Emits `InboxTriageRetroRequested` when the retro is on and due. |
| The retro | "Inbox — triage retro", shipped with Inbox | Answers `InboxTriageRetroRequested` and runs `triggers/inbox-triage/intents/retro.md`. |
| Cleared log | `artifacts/inbox/retro/cleared-<slug>.json` | Triage appends every mail it archives or trashes. |
| Ledger | `artifacts/inbox/retro/ledger.json` | Every mail a retro reviewed, and what it did. |
| Schedule state | `artifacts/inbox/retro/tick.json` | The date the schedule check last asked for a retro. |

Plugins can't ship a cron, so Inbox setup creates the schedule check (and the Inbox app adds it when the user turns
the retro on and it is missing). It runs every evening at 20:00 and costs no AI run. The retro itself is
event-driven, so the app's **Retro now** button and the schedule check start the same run.

## The setting

```json
{ "retro": { "enabled": true, "schedule": "twice-weekly" } }
```

- **`enabled`**: off unless it is `true`. Off means the schedule check emits nothing, and a retro that starts anyway
  (an emitted event, **Retro now**) stops at step 0 without touching mail or emitting a completion event.
- **`schedule`**: `daily`, `twice-weekly` (Wednesday and Sunday) or `weekly` (Sunday). Default `twice-weekly`.

The Retro section of the Inbox app's triage pane (the **All accounts** view) writes both keys, and setup asks for
them. Keep every other key in the settings file when you write it.

## When a retro is due

`retro_tick.py` decides, so the schedule and the switch both take effect on the next evening without editing any
trigger:

- Off, or a schedule it doesn't know: nothing.
- Already asked today: nothing.
- Today is a scheduled day (`daily`: every day; `twice-weekly`: Wednesday and Sunday; `weekly`: Sunday): due.
- The last ask is older than the schedule's longest gap (1, 4 or 7 days), say the machine was off on the day: due,
  as a catch-up.

When due it emits `InboxTriageRetroRequested` with `{"summary", "since", "schedule", "source": "schedule"}` and records
today in `tick.json`. `since` is the day before the last ask, so consecutive windows overlap by a day, or 4 days back
on the first ask. It never reaches back more than 30 days, the cleared log's own limit. **Retro now** sends
`"source": "inbox-app"` and no `since`; the retro then uses 4 days.

To start one by hand:
`lucidos events emit InboxTriageRetroRequested --summary "Triage retro" --payload '{"summary": "Triage retro", "source": "cli"}'`.

## What counts as cleared by triage

Only mail triage itself cleared. The user's own archiving and deleting are never in scope.

Triage appends one entry per mail it moves out of the inbox, by a rule or by the account's `no_action_clear`, to
`artifacts/inbox/retro/cleared-<slug>.json` (the slug rule is triage's own):

```json
{
  "account": "Gmail - Work",
  "cleared": [
    {
      "id": "19efb1badde27730", "thread_id": "19efb1badde27730", "date": "2026-10-26T18:04:00Z",
      "action": "archive", "by": "rule 3",
      "from": "Billing <billing@example.com>", "subject": "Your receipt", "snippet": "Thanks for your payment of…"
    }
  ]
}
```

- **`id`** is triage's own id for the account: the Gmail API message id for `gmail-api`, the `Message-ID` header for
  `imap`, the IMAP UID for `imap-peek`.
- **`action`** is `archive` (out of the inbox, kept) or `delete` (moved to Trash).
- **`by`** is `rule <n>` (1-based, the rule that matched) or `ai` (a `no_action_clear` verdict).
- Triage prunes entries older than 30 days.

`read` and `keep` leave mail in the inbox, so they are never logged and the retro never reviews them.

## The ledger: never restore a mail twice

`artifacts/inbox/retro/ledger.json`:

```json
{
  "last_run": "2026-10-26T20:03:00Z",
  "reviewed": [
    {"id": "19efb1badde27730", "account": "Gmail - Work", "subject": "Your receipt", "outcome": "restored", "date": "2026-10-26"},
    {"id": "<abc@mail.example.com>", "account": "Mailhost - Support", "subject": "Weekly digest", "outcome": "fine", "date": "2026-10-26"}
  ]
}
```

- **`outcome`** is `fine` (rightly cleared), `restored`, or `failed` (a miss the retro could not bring back).
- **Skip every `(account, id)` already in the ledger** with `fine` or `restored`. A `failed` entry is tried again on
  the next retro.
- **Never restore the same mail twice.** If the user clears a restored mail again, that is their decision. Triage
  leaves a `restored` mail alone too (its intent skips those ids), so it can't clear it again.
- Prune entries older than 60 days on every run.

## The bar for a miss

Judge each cleared mail on its **full body**, read without marking it read (see "Restoring and reading" below). It
is a miss if it is any of these:

- **Money**: charges, top-ups, invoices, receipts, payment due or failed, renewals, refunds, bank or card notices.
- **Travel and bookings**: tickets, itineraries, reservations, schedule changes, check-in. Anyone's booking.
- **Invites and access**: beta or test invites, "now available to test" builds, team or org invites, shared docs.
- **Security**: sign-ins, password resets, 2FA codes, account or key changes, unusual-activity warnings.
- **Legal and official**: tax, government, insurance, contracts, e-signatures.
- **A real person** writing to the user, or a customer writing to a shared mailbox.
- **Anything with a deadline or an amount owed.**

Not a miss: marketing, newsletters, promotions (travel sales included), social notifications, code-review and CI
activity, and anything the account's rules or the user's past replies to a retro said to ignore.

**When unsure, restore.** A wrong restore costs one tap. A wrong clear can cost a missed bill.

## Restoring and reading

Per account, by its `fetch`:

- **`gmail-api`**: use the account's proxy from the Inbox settings (`accounts["<name>"].proxy`) with
  `lucidos proxy <proxy> <path>`. Check `/gmail/v1/users/me/profile` first: its `emailAddress` must equal the
  account's `address`, or skip the account and say why. With no proxy, use triage's own token path ("Operational
  Notes" in `knowhow/inbox-triage.md`), with the same profile check.
  - Read: `GET /gmail/v1/users/me/messages/{id}?format=full`. The API never changes read state.
  - Archived: `POST /gmail/v1/users/me/messages/{id}/modify` with `{"addLabelIds": ["INBOX", "UNREAD"]}`.
  - Trashed: `POST /gmail/v1/users/me/messages/{id}/untrash`, then the same modify.
  - A message that is back in the inbox already (it has `INBOX` and no `TRASH`) was handled by the user: record it
    `fine` and move on.
- **`imap`**: `imap_helper.py` reads and restores by Message-ID. A `delete` entry is in Trash, an `archive` entry in
  the Archive folder: add `--from-archive` to both commands for those.
  - Read: `python data/scripts/inbox-triage/imap_helper.py peek --account "<name>" --from-trash --id '<msgid>'`.
  - Restore: `python data/scripts/inbox-triage/imap_helper.py restore --account "<name>" --id '<msgid>'` moves it from
    Trash (or, with `--from-archive`, the Archive folder) back to the inbox, unread. `"ok": false, "error": "not found"` means the user already emptied or moved it:
    record it `fine`.
- **`imap-peek`** (OAuth IMAP such as Outlook): Inbox has no write path for these yet. Judge on the cleared log's
  `from`, `subject` and `snippet`, record a miss as `failed`, and list it in the reply so the user can pull it back
  in their mail client.

Never use `read_email` to read a cleared mail: it marks it read.

After a restore, add the mail to `artifacts/email-triage/kept-<slug>.json` (`{"kept": [{"id", "thread_id",
"reason", "action", "from"}]}`, creating it if absent and keeping every entry already there) with `"action":
"retro"` and a one-sentence reason that starts with "Retro:", for example "Retro: a $12.40 charge on the API
account; triage had archived it." Inbox shows that reason under the mail in **Needs you**.

## Rule suggestions

For each restored mail, the cleared log's `by` says what cleared it. Group the misses by pattern (a sender, a
subject shape) and propose **one** rule per pattern:

- the account, the field, the operator and value, the action (usually `flag` or `notify`), and the position: it must
  sit above whatever cleared the mail (`rule <n>`), or anywhere for an `ai` clear.
- a check against the last 30 days of that account's cleared log: how many of the restored mails it catches, and how
  many fine ones it would wrongly keep. Narrow a rule that keeps more than about one fine mail in ten before
  proposing it.

Number them so the user can answer "apply 1 and 3". **Never edit `artifacts/email-triage/config.json` from a
retro.** The user applies a suggestion by replying in the retro's thread, or in the Inbox rule editor.

## The run's reply

Short. Per account, `reviewed N · restored M`. Then each restored mail (sender, subject, why), any `failed` miss
with what the user should do, then the numbered suggestions. A clean run says so in one line. An account the retro
couldn't read gets one line saying why. Always `request_read: true`.

Emit `InboxTriageRetroCompleted`:

```json
{
  "summary": "Reviewed 41 cleared mails, restored 2 (a receipt on Work, a sign-in alert on Personal).",
  "since": "2026-10-22",
  "reviewed": 41, "restored": 2,
  "per_account": {"Gmail - Work": {"reviewed": 30, "restored": 1}, "Gmail - Personal": {"reviewed": 11, "restored": 1}},
  "suggestions": ["Work: flag from contains billing@example.com, above rule 3"]
}
```

`per_account` names every account the retro covered, with `"error"` on one it couldn't read. Inbox's Retro section
shows the newest event's summary and suggestions.

## Unattended

The retro runs with nobody watching. **Never** call `ask_user_question`. Put anything worth raising in the reply
and finish the run.
