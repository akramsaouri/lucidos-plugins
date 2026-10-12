# Email Triage

Most of your mail doesn't need you, but you only find that out by opening it. Email Triage reads each of your
mailboxes on a schedule, decides what actually needs you, and sends one notification for that. The rest is
cleared quietly, and a run that finds nothing says nothing.

## What you get

- **Your rules first**: a rule chain per account, checked top to bottom, first match wins. A rule matches the
  sender, recipients, subject or body (contains, equals or regex) and does one thing with the mail: skip it, mark
  it read, move it to Trash, add a reminder, notify you, flag it, or pass it to AI triage.
- **AI triage for the rest**: mail no rule catches is sorted into needs you, FYI or noise. For each account you
  choose what happens to FYI and noise: mark it read, move it to Trash, or leave it alone.
- **One notification, never twice**: only mail that needs you reaches you, as a single consolidated push per
  run. A ledger remembers what already pinged you, so a message that stays unread doesn't ping you every hour.
- **Looking never marks mail read**: triage reads through the Gmail API or an IMAP peek, so an unread message
  stays unread until you open it.
- **Email Triage app**: a control panel with an account rail and three views. Overview shows each account's
  health, next run and what is currently actionable. Rules is the rule chain editor, and dims a rule an earlier
  rule makes unreachable. Activity is the run history and the suggestions runs leave behind. Each account has a
  **Triage now** button and Pause / Resume, one at a time or all at once.
- **Gmail, Outlook and plain IMAP**: Gmail goes over its API. Other mailboxes go over IMAP, either with OAuth
  (Outlook, Exchange) or with nothing but a host and a password.

## What it needs

- Lucidos 0.47.1 or later.
- At least one mailbox to triage. Setup connects it for you. A password mailbox keeps its password as a
  workspace credential, never in the config file.
- Push notifications switched on for your device, since that's how triage reaches you.
- A Mac, if you want the reminder action. It adds to the Apple Reminders list "Tasks" through AppleScript, so it
  works only when Lucidos runs on a Mac. Every other action works anywhere.

Each scheduled run is a short AI run, pinned to low reasoning effort. A run with no new mail still starts one,
but sends nothing.

[Inbox](https://github.com/akramsaouri/lucidos-plugins/tree/main/inbox) is a companion plugin for reading and
answering the mail that survives triage. It needs Email Triage, and Email Triage doesn't need it.

## What setup asks for

Setup is a conversation, one account at a time. You don't write any rules or cron expressions yourself.

1. **The mailbox**, if it isn't connected yet. Most providers connect with OAuth. A mailbox with no API and no
   OAuth needs its IMAP host and password instead.
2. **What you want gone, what you want silenced but kept, and what should always reach you.** Setup turns your
   answers into a first chain of 2 to 5 rules. The Rules tab is where you grow it.
3. **What happens to mail the AI judges needs nothing**: mark it read, move it to Trash, or leave it alone. Mark
   it read is the safe choice for a work or shared mailbox, where Trash could bury mail someone else needs.
   Trash suits a personal mailbox that collects a lot of noise.
4. **A schedule.** Setup offers hourly during waking hours plus one early-morning run, and you adjust it.

## How it works

Setup creates one cron trigger per account, since a schedule is yours rather than the plugin's. The plugin itself
ships the app, the triage instructions, the IMAP helpers, and one trigger, "Email Triage — on demand", which the
**Triage now** button fires. Your accounts and rules live in `artifacts/email-triage/config.json` in your
workspace, not in the plugin.

Pause is a flag in that config file, which both a scheduled run and **Triage now** check first, so a paused
account does nothing. The app also tries to pause that account's cron trigger, and tells you if it couldn't.
Mail that arrives while an account is paused waits for the first run after you resume.

Uninstalling removes what the plugin shipped, but not the cron triggers setup created. Delete those from your
triggers afterwards.

## Try first

Open the Email Triage app and press **Set up Email Triage**, or ask Lucidos to set it up. Once an account is in,
press **Triage now** on it and look at Activity. The first run is quiet unless something needs you. That's the
design, not a failure.
