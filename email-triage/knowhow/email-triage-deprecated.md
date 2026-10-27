---
name: Email Triage (deprecated)
description: Email Triage is now part of the Inbox plugin. Load when someone asks about the Email Triage plugin, or finds it still installed
---

# Email Triage is now part of Inbox

The Email Triage plugin is deprecated. Since Inbox 0.3.0, the Inbox plugin ships the whole triage engine: the
triage intent (`triggers/email-triage/intents/triage.md`), the knowhow (`knowhow/email-triage.md`), the IMAP
helpers (`scripts/email-triage/`) and the on-demand trigger behind Triage now. Install Inbox; that's all.

This version of Email Triage ships only this note, so uninstalling it removes nothing triage needs. Accounts,
rules and run history stay in `artifacts/email-triage/`, and the per-account cron triggers stay as they are.

If Inbox is below 0.3.0 or not installed, triage has nothing to run until it is: update or install Inbox, and
its setup checks the move.
