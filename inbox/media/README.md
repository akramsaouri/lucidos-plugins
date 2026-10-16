# Inbox

[Email Triage](https://github.com/akramsaouri/lucidos-plugins/tree/main/email-triage) decides what needs you.
Inbox is where you read and act on it: one calm inbox across every mailbox Email Triage watches, with the mail
that survived triage kept apart from the mail triage hasn't seen yet, so a long list never hides what matters.

## What you get

- **Two zones per account, never mixed**: *Needs you* is mail that survived triage, with the reason it was kept
  under each row. *Not triaged yet* is mail that arrived since the account's last run, or that triage never saw.
- **Archive, delete and undo in one key or swipe**: `e` archives, `#` deletes, `z` undoes. On a touch screen,
  swipe right to archive and left to delete. `j` and `k` move through the list, `/` filters it, and `?` lists
  every shortcut.
- **Replies with AI help**: reply or reply all, then **Suggest** drafts a reply in your voice and **Polish**
  tidies what you wrote. **Summarize** (`s`) condenses a long thread. A sent reply waits in an undo window, 8
  seconds by default, before it goes out.
- **A hand-off to Lucidos**: `a` starts a Lucidos thread about the email, with an instruction if you give one,
  such as "draft a polite no".
- **Folders and labels**: each account's folders (IMAP) or labels (Gmail) fold away in the sidebar and open in
  the same list. IMAP folders are read-only for archive and delete. Replying works everywhere.
- **Careful reading**: remote images stay blocked until you allow them for a message. On an account where triage
  looks at unread mail, opening a message triage hasn't seen leaves it unread, so its next run still sees it.
- **An Inbox widget for Home**: how many threads need you across every account, with how many aren't triaged
  yet. A small tile shows the one number, medium adds a count per account that doubles as a filter, and large
  adds the top few threads with the reason triage kept each one. Tap it to open the Inbox. It reads the same
  accounts and triage results as the app, and needs no setup of its own.

## What it needs

- Lucidos 0.48.0 or later.
- The **Email Triage** plugin, 0.6.0 or later, installed and set up with at least one account. Inbox owns no
  accounts. It reads Email Triage's accounts, rules and results, and never triages anything itself. Without Email
  Triage it has nothing to show.
- For each **Gmail** account, a Lucidos API proxy that carries that mailbox's OAuth token. Setup reuses one Email
  Triage already has, or adds one.
- For each **password IMAP** account, the credential Email Triage already holds for it. Inbox sends replies over
  SMTP with the same username and password.
- An AI model provider, for Suggest, Polish and Summarize. Inbox tries Anthropic, then Vertex, with a Claude model.
  With neither configured, setup asks you to choose OpenAI, OpenRouter, xAI or a local model. Everything else
  works without one.

**Not supported yet:** accounts Email Triage reads over OAuth IMAP, such as Outlook and Exchange. They show in the
sidebar with a red dot and the reason, never as an empty inbox you'd mistake for a clear one.

## What setup asks for

Setup first checks that Email Triage is installed with at least one account, and stops to offer setting it up
first if not. After that it mostly wires things up and asks little:

1. **Each Gmail account** gets its proxy, found or added, and checked to read the right mailbox. Inbox repeats
   that check before every list and refuses to go on if the proxy reads a different address, so it can't
   archive or reply in the wrong mailbox.
2. **Each IMAP account** gets the bridge trigger confirmed live, the credential confirmed present and a test
   sync. Setup asks about the SMTP host only when your provider's isn't the usual one.
3. **Your name and how your replies should sound.** The name goes on outgoing mail and into the AI prompts. The
   voice is a sentence or two, for example friendly and brief. You can give a shared mailbox its own From name,
   voice or signature, or skip that.
4. **An AI provider**, only if you have neither Anthropic nor Vertex.

## How it works

An app can't speak IMAP or SMTP, so for password IMAP accounts Inbox asks a script trigger the plugin ships,
"Inbox — IMAP bridge", to do the work. Only the Inbox app can make it change or send mail. A request from an
agent or a script is refused, so a triage run misled by a crafted email can't make the bridge trash or send
anything. A sync, which only reads, is all an agent can ask for.

Your settings live in `artifacts/inbox/settings.json`. Snapshots of IMAP mail, which hold message bodies, go to
`artifacts/inbox/cache/`, a folder the workspace repo never commits. Drafts and replies waiting in their undo
window stay on the device. A reply still waiting when you close the app comes back as a draft, never sent behind
your back.

## Try first

Open the Inbox app and look at an account's *Needs you* list. Press `?` for the shortcuts, `s` to summarize a
thread, or `r` to reply and try Suggest. Then pin the **Inbox** widget to Home from the board's Add.
