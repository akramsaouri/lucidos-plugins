# Email Triage

**Looking for a mail app? Install [Inbox](https://github.com/akramsaouri/lucidos-plugins/tree/main/inbox)
instead; it uses this plugin.** Inbox's setup walks you through this one.

Email Triage is the engine underneath. It reads each of your mailboxes on a schedule, decides what actually
needs you, and sends one notification for that. The rest is cleared quietly, and a run that finds nothing says
nothing.

## What you get

- **Your rules first**: a rule chain per account, checked top to bottom, first match wins. A rule matches the
  sender, recipients, subject or body and does one thing: skip, mark read, move to Trash, add a reminder,
  notify you, flag, or pass to AI triage.
- **AI triage for the rest**: mail no rule catches is sorted into needs you, FYI or noise. Per account, you pick
  what happens to FYI and noise: mark it read, move it to Trash, or leave it alone.
- **One notification, never twice**: a single push per run, and a ledger so an unread message doesn't ping you
  every hour.
- **Looking never marks mail read**: triage reads through the Gmail API or an IMAP peek.
- **Gmail, Outlook and plain IMAP**: Gmail over its API, other mailboxes over IMAP with OAuth or a password.
- **No app of its own**: its controls (Pause, Triage now, the rule editor, run history) live in Inbox. Without
  Inbox, rules and pauses are hand edits to the config file.

## What it needs

- Lucidos 0.47.1 or later.
- At least one mailbox. Setup connects it. A password mailbox keeps its password as a workspace credential,
  never in the config file.
- Push notifications switched on for your device.
- A Mac, only for the reminder action, which adds to Apple Reminders. Every other action works anywhere.

Each scheduled run is a short AI run at low reasoning effort, even when there's no new mail.

## What setup asks for

Setup is a conversation, one account at a time. You write no rules or cron expressions yourself.

1. **The mailbox**, if it isn't connected yet: OAuth for most providers, or an IMAP host and password.
2. **What you want gone, silenced, or always shown.** Setup turns that into a first chain of 2 to 5 rules.
3. **What happens to mail that needs nothing**: mark read (safe for work or shared mailboxes), Trash, or leave it.
4. **A schedule.** Setup suggests hourly during waking hours plus an early-morning run, and you adjust it.

## How it works

Setup creates one cron trigger per account, after install. The plugin ships the triage instructions, the IMAP
helpers and one trigger, "Email Triage — on demand", which Inbox's **Triage now** fires. Your accounts and rules
live in `artifacts/email-triage/config.json`, not in the plugin.

Pause is a flag in that file, which every run checks first. Mail that arrives while paused waits for the first
run after you resume.

Uninstalling removes what the plugin shipped, but not the cron triggers setup created: delete those yourself.
Updating from 0.6 removes the old Email Triage app; accounts, rules, schedules and run history stay.

## Try first

Install Inbox and run its setup. Once an account is in, open its **Triage** entry in Inbox's sidebar and press
**Triage now**. The first run is quiet unless something needs you. That's the design, not a failure.
