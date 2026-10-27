---
name: Email Triage (deprecated)
description: Email Triage is now part of the Inbox plugin. Load when someone asks about the Email Triage plugin, or finds it still installed
---

# Email Triage is now part of Inbox

The Email Triage plugin is deprecated. Since Inbox 0.3.0, the Inbox plugin ships the whole triage engine at its
own paths: the triage intent (`triggers/inbox-triage/intents/triage.md`), the knowhow (`knowhow/inbox-triage.md`),
the IMAP helpers (`scripts/inbox-triage/`) and the on-demand trigger behind Triage now. Install Inbox; that's all.

This version of Email Triage still ships its own engine, unchanged, so updating to it never stops triage, even
with an older Inbox. The two plugins share no file, so uninstalling Email Triage never deletes Inbox's engine.
What it can break is a per-account cron trigger that still names an `email-triage` path: Inbox's setup points
those at Inbox's engine first, then removes Email Triage. Accounts, rules and run history stay in
`artifacts/email-triage/`.
