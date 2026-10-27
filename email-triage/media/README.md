# Email Triage

**Deprecated: now part of [Inbox](https://github.com/akramsaouri/lucidos-plugins/tree/main/inbox).** Install
Inbox instead; if you have this installed, update Inbox and its setup will migrate you.

Inbox 0.3.0 ships the whole triage engine that used to live here: your rules first, then AI, on a schedule per
account, with one notification for what needs you. Nothing about how triage runs has changed.

## If you have Email Triage installed

1. Update Inbox to 0.3.0 or later. Its setup tells you it will remove Email Triage, points your triage schedules
   at Inbox, then uninstalls Email Triage.
2. That's it. Your accounts, rules, run history and schedules stay: they're workspace state, not plugin files.

Updating Email Triage to this version (0.8.0) changes nothing about how triage runs, so it's safe at any time,
even with an older Inbox.

If you uninstall Email Triage yourself before Inbox's setup has run, scheduled triage stops until it does. Inbox
shows a "Triage engine missing" banner when that happens; run Inbox's setup to fix it.
