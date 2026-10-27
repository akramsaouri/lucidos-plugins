---
name: Inbox
description: How the Inbox app (the inbox plugin) reads triage's accounts and results, its settings file (Gmail proxy per account, display name, reply voice, AI provider), the IMAP bridge trigger and its event protocol, where the triage controls live (the Triage pane), and what to check when an account shows a red dot or the bridge doesn't answer. Load when setting up Inbox, adding an account to it, or debugging it
---

# Inbox

Inbox is a mail client with triage built in. The plugin ships the triage engine (`knowhow/inbox-triage.md`, the
intent at `triggers/inbox-triage/intents/triage.md`, the "Inbox — triage on demand" trigger) as well as the app.
The app itself never triages: everything it shows comes from triage's config and the files its runs leave
behind. Each account's inbox is split into two zones that never mix:

- **Needs you**: mail that survived triage, with the reason it was kept under each row.
- **Not triaged yet**: mail that arrived since the account's last run, or that triage never saw (read before an
  unread-only account's run, or missing from a shared account's `state.processed`).

With two or more accounts, **All inboxes** leads the account list: every account's mail in the same two zones,
newest first, each row tagged with its account. Actions on a row go to that row's own account; folders and the
per-account Triage entry stay under each account. An account that fails to load keeps its red dot and a quiet
"not loaded" line while the others still show. The last mailbox picked (All or one account) is remembered.

Folders and labels are browsed on demand outside the zones: see `apps/inbox/knowhow/folders.md`.

Inbox is also triage's control panel. A **Triage** entry heads each
account's folders and an **All accounts** strip tops the sidebar; both open the Triage pane in the list's place:
health and next run, pause/resume, Triage now, the rule chain editor, suggestions from runs and run history. It
writes triage's `config.json` and emits `EmailTriageRequested`: see `apps/inbox/knowhow/triage.md`.

## Accounts

Inbox lists triage's accounts (`artifacts/email-triage/config.json`) in config order.

- **Label**: `accounts["<name>"].label` from the settings below, else the config name with only a `Gmail - `
  prefix dropped, the way triage shows it.
- **Colour**: one of five theme-mixed colours, by the account's position in config.json, so an account wears
  one colour in its inbox, its triage pane and the widget.
- **How it is read** follows the block's `fetch`:

| `fetch` | Read and changed through |
|---|---|
| `gmail-api` (or no `fetch` on a Gmail address) | The engine proxy named in `accounts["<name>"].proxy`. Every list first calls `/profile` and refuses to go on when the proxy reads a different address, so a token mix-up can never act on the wrong mailbox. |
| `imap` | The "Inbox — IMAP bridge" script trigger, which logs in with the block's `imap` settings (below). |
| `imap-peek` and anything else | Not supported yet. The account shows in the sidebar with a red dot and the reason. |

An account Inbox can't read (no proxy recorded, an unsupported `fetch`, a failed load) shows a red dot in the
sidebar, with the reason as its tooltip and in its empty list. It never shows as a silently empty inbox.

## Settings: `artifacts/inbox/settings.json`

Everything is optional except a `proxy` for each Gmail account. Keys under `accounts` are triage's
account names, exactly as in its config.

```json
{
  "display_name": "Alex Example",
  "voice": "Friendly and brief. No exclamation marks.",
  "undo_send_seconds": 8,
  "ai": { "provider": "anthropic", "model": "claude-sonnet-5-5" },
  "accounts": {
    "Gmail - Work": { "proxy": "gmail-work", "signature": "Alex\nExample Co" },
    "Mailhost - Support": { "from_name": "Example Support", "voice": "Formal; sign off as the support team." }
  }
}
```

- **`display_name`**: the From name on outgoing mail and the person the AI writes for. An account's
  `from_name` overrides it on that account's mail.
- **`voice`**: how AI-drafted replies should sound. An account's `voice` overrides it there. `signature` is
  per account only, appended to new replies and kept out of the AI's view of a draft.
- **`undo_send_seconds`**: how long a sent reply waits, undoable, before it goes out. Default 8.
- **`ai`**: Suggest, Polish and Summarize call one of the engine's built-in model proxies. With no `ai`
  block, Inbox tries `anthropic`, then `vertex`, with a Claude model, moving on only when the engine answers
  404 (no credential for that provider). `openai`, `openrouter`, `xai` and `local` work too, and need `model`.
- **`accounts["<name>"].proxy`**: the `data/config/apis.json` entry that carries that Gmail mailbox's OAuth
  token, base URL `https://www.googleapis.com`. Setup finds one in this order: an existing proxy whose
  `/gmail/v1/users/me/profile` reads the account's `address`; a new proxy on the account's triage
  `oauth_provider` (or another connected Google provider whose token reads that address), which needs no new
  provider and no popup; and only then a new connection via `connect_oauth_account`. That one opens a popup
  for a Google OAuth client ID and secret, so explain it first: the user can paste the same client as their
  existing Google connection, must sign in as this mailbox's address, and must list it as a test user if the
  OAuth app is in Testing.

Drafts, the outbox of replies inside their undo window, folded sections and a cached copy of the list live in
the device's own storage (`lucidos.storage.local`), not in this file. A reply still inside its undo window when
the app closes comes back as a draft on the next open, never sent behind the user's back.

## What Inbox reads from triage

Per account, by triage's slug (the name lowercased and hyphenated, only a `Gmail - ` prefix dropped):

- `config.json`: the account's `rules` (to say which rule would catch an untriaged mail), `paused` and
  `shared`. A shared account fetches a date window, so read state doesn't decide what triage sees.
- `triage-<slug>.json`: the actionable snapshot. Each entry's `summary` is the reason shown under a kept row.
- `notified-<slug>.json`: mail triage already pushed to the user.
- `state-<slug>.json`: `last_run` and, for shared accounts, `processed`.
- `kept-<slug>.json` (optional): `{"kept": [{"id", "thread_id", "reason", "action", "from"}]}`, why triage
  left each mail in the inbox. The shipped triage intent doesn't write this file. A workspace whose triage intent does gets a
  reason under every kept row. Without it, rows fall back to the triage snapshot's summary, or a generic reason.
- `EmailTriageCompleted` events: the last run per account, and today's cleared count for the empty state.
- Each account's cron trigger, matched by name (`triggerFor` in `mail.js`): its next run and paused state show
  in the reader, and the triage pane pauses and resumes it.

Opening an unread mail marks it read only when that can't hide it from triage: in the Needs you zone, or on a
shared account. On an unread-only account an untriaged mail stays unread when opened, so its next run still
sees it.

## The IMAP bridge

An app frame can't speak IMAP or SMTP, so for a `fetch: imap` account the app emits an event and the
"Inbox — IMAP bridge" trigger (shipped by this plugin, `apps/inbox/scripts/imap_bridge.py`) does the work and
answers with `InboxImapResult`, carrying the same `request_id` and `account`.

| Event | Payload | Does |
|---|---|---|
| `InboxImapSyncRequested` | `request_id`, `account` (none: every IMAP account) | Snapshot INBOX |
| `InboxImapActionRequested` | `op: read \| unread \| archive \| trash`, `ids` | Change those messages, then snapshot |
| `InboxImapActionRequested` | `op: restore`, `ids`, `from_folder: archive \| trash`, `mark_unread` | Undo an archive or delete |
| `InboxImapActionRequested` | `op: send`, `to`, `cc`, `subject`, `body`, `in_reply_to`, `references` | Send over SMTP, copy to Sent, flag the original `\Answered` |
| `InboxImapActionRequested` | `op: folders` | List folders (read-only): `folders` in the answer |
| `InboxImapActionRequested` | `op: folder`, `folder`, `limit` | Snapshot one folder (read-only): `file` in the answer |
| `EmailTriageCompleted` | (from a triage run) | Resync each IMAP account in `account_results`; silent for any other run |

- **Ids are Message-IDs**, as in triage's IMAP accounts. A UID is resolved inside the session, right
  before a write, and never leaves it.
- **Nothing is marked read by looking.** Folders open read-only and bodies are fetched with `BODY.PEEK[]`.
- **Connection** comes from the account's `imap` block in triage's config: `host`, `port`, `ssl`,
  `username` (default: the address) and `credential_env` (the name of the env var holding the password).
  Archive, Trash and Sent are the folders the server flags with RFC 6154 special-use, else `archive_folder`,
  `trash_folder`, `sent_folder` from the block, else `Archive`, `Trash`, `Sent`.
- **SMTP** uses the same username and password, at `smtp_host` / `smtp_port` from the block. Without them it
  assumes `smtp.<domain>` when the IMAP host is `imap.<domain>`, the IMAP host itself otherwise, on 465
  (implicit TLS). Any other port means STARTTLS. The password never goes over a plaintext connection.
- **Snapshots** go to `artifacts/inbox/cache/`: `imap-<slug>.json` for INBOX (the newest 100), attachments up to
  5 MB in `imap-<slug>-att/`, and `imap-<slug>-folder-*.json` for folders. They hold mail bodies, so the bridge
  writes them straight to disk, never through `lucidos data write`, and keeps a `.gitignore` in the folder so
  the workspace repo never commits them.
- **Only the Inbox app can change or send mail.** The trigger fires `InboxImapActionRequested` only when the
  engine recorded the emit as coming from a device (`actor.kind: device`), and the bridge refuses a write or a
  send whose `actor` is an agent or a script. So a triage run misled by a crafted email can't make the bridge
  trash or send anything. `InboxImapSyncRequested` stays open to agents and scripts: it only reads.
- **A request is answered once.** The bridge records each `request_id` it handles for a day, so a second
  bridge trigger (one registered by hand before the plugin, say) can't send the same reply twice.

## When something is wrong

- **Red dot, "No Gmail proxy is recorded"**: add `accounts["<name>"].proxy` to the settings (run the plugin's
  setup again, or see its step 6). Setup then wires only the accounts that lack one.
- **"the … proxy reads x@…, not y@…"**: that proxy carries another mailbox's token. Point the account at the
  right entry. Never loosen the check.
- **"the IMAP bridge did not answer"**: the "Inbox — IMAP bridge" trigger is missing or paused
  (`lucidos triggers list`), or its run failed. `InboxImapResult` events carry the bridge's `error`.
- **"credential … is not available to this process"**: the block's `credential_env` names an env var that
  doesn't exist. List the names with `env | cut -d= -f1 | grep '^CRED_'`, or re-run `configure_email`.
- **AI buttons fail with "no model provider answered"**: set `ai.provider` and `ai.model`.
