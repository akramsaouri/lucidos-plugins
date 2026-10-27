---
name: Inbox Triage Retro
knowhow:
  - inbox-triage-retro
  - inbox-triage
---

Go back over the mail triage archived or trashed on every account, restore anything the user would want to see,
and suggest rule changes. The knowhow has the files, the bar for a miss and how to restore per account type.

0. **Check the setting first.** Read `artifacts/inbox/settings.json`. Unless `retro.enabled` is `true`, stop:
   read no mail, change nothing, and emit no `InboxTriageRetroCompleted`. Reply with one line saying the retro is
   off in Inbox's settings.
1. Load `artifacts/email-triage/config.json` and `artifacts/inbox/retro/ledger.json` (absent means empty). Take
   `since` from the triggering event, else 4 days ago.
2. For every account in the config, paused ones included (a paused account's past clears still count): read
   `artifacts/inbox/retro/cleared-<slug>.json` and keep the entries dated on or after `since` that the ledger
   doesn't already hold as `fine` or `restored`.
3. Read each one's full body without marking it read, and judge it against the bar for a miss. When unsure,
   restore.
4. Restore each miss: back in the inbox, unread, plus a "Retro:" reason in `kept-<slug>.json`. A miss you can't
   restore is `failed`.
5. Record every reviewed mail in the ledger with its outcome, set `last_run`, and prune entries older than 60 days.
6. Group the restored mail by pattern and suggest one rule per pattern, numbered. **Never edit config.json.**
7. Reply: per account `reviewed N · restored M`, each restored or failed mail, then the suggestions. Set
   `request_read: true`.
8. Emit `InboxTriageRetroCompleted` with `{summary, since, reviewed, restored, per_account, suggestions}`.

## Never ask questions: this run is unattended

Never call `ask_user_question`, and never end the run waiting on an answer. If an account can't be read (no proxy,
the profile check fails, a login fails), say so in the reply and in its `per_account` entry, and carry on with the
others.
