# Inbox

**Start here**

1. Install Inbox.
2. Its setup walks you through Email Triage, the engine that sorts your mail, and offers to install it if needed.
3. Open Inbox.

Inbox is one calm inbox across all your mailboxes. Each account splits in two: *Needs you*, the mail that
survived triage, with the reason it was kept, and *Not triaged yet*, the mail triage hasn't seen. Email Triage
does the sorting (your rules first, then AI). Inbox is where you read and act on the result, and where you run
triage itself.

## What you get

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
- **Careful reading**: remote images stay blocked until you allow them. Opening a message triage hasn't seen
  keeps it unread, so the next run still sees it.
- **An Inbox widget for Home** that counts what needs you, per account on bigger tiles.

## What it needs

- Lucidos 0.48.0 or later.
- The **Email Triage** plugin, 0.7.0 or later, set up with at least one account. Inbox reads its accounts, rules
  and results, and never triages mail itself. Setup checks for it first and offers to set it up.
- For each **Gmail** account, a Lucidos API proxy for that mailbox. Setup reuses Email Triage's Google sign-in
  where it can, or connects the mailbox.
- For each **password IMAP** account, the credential Email Triage already holds. Replies go out over SMTP with
  the same username and password.
- An AI model provider for Suggest, Polish and Summarize: Anthropic or Vertex by default, or OpenAI, OpenRouter,
  xAI or a local model. Everything else works without one.

**Not supported yet:** accounts Email Triage reads over OAuth IMAP, such as Outlook and Exchange. Their triage
controls work, but their mail shows as a red dot with the reason, never as an empty inbox.

## What setup asks for

1. **Each Gmail account** gets a proxy, checked to read the right mailbox. Inbox repeats that check before every
   list, so it can't archive or reply in the wrong mailbox.
2. **Each IMAP account** gets a test sync through the bridge trigger. Setup asks about the SMTP host only when it
   isn't the usual one.
3. **Your name and reply voice**, a sentence or two on how replies should sound. A shared mailbox can have its
   own From name, voice or signature.
4. **An AI provider**, only if you have neither Anthropic nor Vertex.

## How it works

An app can't speak IMAP or SMTP, so password IMAP accounts go through a script trigger the plugin ships,
"Inbox — IMAP bridge". Only the Inbox app can make it change or send mail, so a crafted email can't trick a
triage run into trashing or sending anything.

The triage controls edit Email Triage's `artifacts/email-triage/config.json` and keep every key they don't
touch. Pause is a flag in that file, which every run checks first. **Triage now** asks Email Triage's on-demand
trigger for a run.

Settings live in `artifacts/inbox/settings.json`, and IMAP snapshots in `artifacts/inbox/cache/`, which the
workspace repo never commits. Drafts stay on the device. A reply still in its undo window when you close the app
comes back as a draft, never sent behind your back.

## Try first

Open an account's *Needs you* list and press `?`. Open a thread, press `r` and try **Suggest**. Then open the
account's **Triage** entry and press **Triage now**, and pin the **Inbox** widget to Home.
