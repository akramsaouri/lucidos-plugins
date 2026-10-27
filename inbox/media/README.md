# Inbox

**Install Inbox, that's all.** Its setup connects your mailboxes, sets up triage for each, and opens the app.

Inbox is one calm inbox across all your mailboxes, with triage built in. Triage reads each mailbox on a
schedule, applies your rules first, then AI, and sends one notification for what actually needs you. Inbox
splits each account in two: *Needs you*, the mail that survived triage, with the reason it was kept, and *Not
triaged yet*, the mail triage hasn't seen.

**Had the Email Triage plugin?** It's now part of Inbox. Update Inbox and its setup moves you over: it points
your schedules at Inbox, then removes Email Triage. Accounts, rules, schedules and run history carry over
untouched.

## What you get

- **Your rules first**: a rule chain per account, checked top to bottom, first match wins. A rule matches the
  sender, recipients, subject or body and does one thing: skip, mark read, move to Trash, add a reminder, notify
  you, flag, or pass to AI triage.
- **AI triage for the rest**: mail no rule catches is sorted into needs you, FYI or noise. Per account, you pick
  what happens to FYI and noise: mark it read, move it to Trash, or leave it alone.
- **One notification, never twice**: a single push per run, and a ledger so an unread message doesn't ping you
  every hour. A run that finds nothing says nothing.
- **Two zones per account, never mixed**, so a long list never hides what matters.
- **Quick actions**: `e` archives, `#` deletes, `z` undoes, or swipe right and left on a touch screen. `?` lists
  every shortcut.
- **Replies with AI help**: **Suggest** drafts a reply in your voice, **Polish** tidies what you wrote, and
  **Summarize** (`s`) condenses a long thread. A sent reply waits 8 seconds, so you can undo it.
- **A hand-off to Lucidos**: `a` starts a Lucidos thread about the email, such as "draft a polite no".
- **Folders and labels** in the sidebar, opening in the same list.
- **Triage controls**: each account has a **Triage** entry with its health and next run, Pause / Resume,
  **Triage now**, the rule editor, suggestions from runs and run history. An **All accounts** strip pauses or
  runs every account at once.
- **Careful reading**: looking never marks mail read, in triage or in the app. Remote images stay blocked until
  you allow them.
- **An Inbox widget for Home** that counts what needs you, per account on bigger tiles.

## What it needs

- Lucidos 0.48.0 or later.
- At least one mailbox: Gmail over its API, other mailboxes over IMAP with OAuth or a password. Setup connects
  them. A password mailbox keeps its password as a workspace credential, never in a config file.
- Push notifications switched on for your device.
- An AI model provider for Suggest, Polish and Summarize: Anthropic or Vertex by default, or OpenAI, OpenRouter,
  xAI or a local model.
- A Mac, only for the reminder rule action, which adds to Apple Reminders.

Each scheduled triage run is a short AI run at low reasoning effort, even when there's no new mail.

**Not supported yet:** reading OAuth IMAP accounts such as Outlook and Exchange in the app. They're triaged as
usual and their controls work, but their mail shows as a red dot with the reason, never as an empty inbox.

## What setup asks for

Setup is a conversation, one account at a time. You write no rules or cron expressions yourself.

1. **The mailbox**, if it isn't connected yet.
2. **What you want gone, silenced, or always shown.** Setup turns that into a first chain of 2 to 5 rules.
3. **What happens to mail that needs nothing**: mark read (safe for work or shared mailboxes), Trash, or leave it.
4. **A schedule.** Setup suggests hourly during waking hours plus an early-morning run, and you adjust it.
5. **Your name and reply voice**, a sentence or two on how replies should sound, and an AI provider only if you
   have neither Anthropic nor Vertex.

Gmail accounts get a proxy checked to read the right mailbox, and Inbox repeats that check before every list, so
it can't archive or reply in the wrong mailbox. Password IMAP accounts get a test sync.

## How it works

Setup creates one cron trigger per account. The plugin ships the triage instructions, the IMAP helpers and two
triggers: "Inbox — triage on demand", which **Triage now** fires, and "Inbox — IMAP bridge". An app can't speak
IMAP or SMTP, so password IMAP accounts go through the bridge. Only the Inbox app can make it change or send
mail, so a crafted email can't trick a triage run into trashing or sending anything.

Accounts and rules live in `artifacts/email-triage/config.json`, settings in `artifacts/inbox/settings.json`,
and IMAP snapshots in `artifacts/inbox/cache/`, which the workspace repo never commits. Pause is a flag in the
config file, which every run checks first; mail that arrives while paused waits for the first run after you
resume. Drafts stay on the device. A reply still in its undo window when you close the app comes back as a
draft, never sent behind your back.

Uninstalling removes what the plugin shipped, but not the cron triggers setup created: delete those yourself.

## Try first

Open an account's **Triage** entry and press **Triage now**. The first run is quiet unless something needs you.
Then open its *Needs you* list and press `?`, open a thread, press `r` and try **Suggest**, and pin the **Inbox**
widget to Home.
