# Email Triage

**Deprecated: now part of [Inbox](https://github.com/akramsaouri/lucidos-plugins/tree/main/inbox).** Install
Inbox instead; if you have this installed, update Inbox and its setup will migrate you.

Inbox 0.3.0 ships the whole triage engine that used to live here: your rules first, then AI, on a schedule per
account, with one notification for what needs you. Nothing about how triage runs has changed.

## If you have Email Triage installed

1. Update Inbox to 0.3.0 or later. Its setup finds Email Triage and walks you through the rest.
2. Setup has you update Email Triage to this version (0.8.0), which hands its files over to Inbox, and then
   uninstall it.

Your accounts, rules, run history and cron triggers carry over untouched: they're workspace state, not plugin
files.

**Don't uninstall an older Email Triage after updating Inbox.** Both plugins then record the same triage files,
and uninstalling Email Triage would delete them. Update Email Triage to 0.8.0 first, or let Inbox's setup handle
it. Uninstalling Email Triage *before* updating Inbox is fine: triage just pauses until the Inbox update lands.
