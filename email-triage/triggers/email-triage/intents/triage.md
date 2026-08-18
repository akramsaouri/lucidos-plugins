---
name: Email Triage
knowhow:
  - email-triage
---

Triage unseen emails for the specified account.

0. **Check `paused` first.** If the account's config block has `"paused": true`, stop
   immediately: fetch nothing, change nothing, notify nothing, and emit no
   `EmailTriageCompleted` event. A paused account is off, whether this run came from its
   cron trigger or from the app's "Triage now" button.
1. Load config from `artifacts/email-triage/config.json` for this account
2. Fetch emails:
   - Non-shared accounts: search `UNSEEN`
   - Shared accounts (`"shared": true`): load state file, fetch with `since` (last_run - 1 day), filter out already-processed UIDs
3. Apply rules in order — first match wins
4. AI-categorize anything that doesn't match a rule (actionable / FYI / noise)
5. Clear no-action emails (FYI + noise) per the account's `no_action_clear` setting: `read` (mark read, keep), `delete` (trash), or `keep` (leave, count only). Explicit `delete` rules always fire regardless.
6. Of the actionable/flagged items, drop any already in the notified-ledger (`artifacts/email-triage/notified-<slug>.json`). If new ones remain, send one consolidated push notification covering only those, then append them to the ledger. If all were already notified, stay silent.
7. If nothing noteworthy, stay silent — exception-based alerting
8. Emit an EmailTriageCompleted event with per-account counts

## Never ask questions — this run is unattended

This runs on a schedule with nobody watching. **Never** call `ask_user_question`, and never
end the run waiting on an answer. A run that asks something holds its concurrency slot open
forever, and every later fire for that account is blocked until someone notices — this has
already cost five days of silent downtime on two accounts.

If you spot something worth raising — a rule worth adding, a recurring sender worth a new
pattern, a failing workflow buried in a notification — write it into the run summary as a
suggestion and finish the run. It'll get read later. Never trade a completed run for an
answered question.
