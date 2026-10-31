# Inbox changelog

## 1.2.0

- **IMAP accounts log in again on current engines.** The engine hands a script a credential only when a file
  names it, so setup now writes each IMAP account's credential name beside the IMAP bridge and the triage
  helpers (`imap_credentials.py`, a workspace file the plugin doesn't ship). Existing installs are asked to
  re-run setup once.
- **Setup spots triggers that would fire twice**: an on-demand triage, IMAP bridge or scheduled retro made
  before Inbox. It asks which to keep, and changes nothing without an answer. It also moves reply voices and
  the AI model from an older hand-built Inbox's settings into the current shape.
- **The layout follows your UI scale.** Inbox picks one, two or three panes from the room it has in theme
  units, so a larger UI scale drops to fewer panes instead of squeezing the reader.
- Touch screens no longer keep a stuck hover after a tap.
- The Inbox widget stays covered until its first real render, so it never flashes an empty card.
- Reason lines name archive, label, calendar and Notion rules, and a label or calendar rule counts as
  keeping the mail.

## 1.1.0

- **Triage retro.** Twice a week by default, a retro goes back over the mail triage archived or trashed on every
  account, brings back anything you'd want to see (unread, with the reason), and suggests rule changes in its own
  thread. It never changes your rules, and it never brings back the same mail twice.
- **A Retro section in the Triage pane** (All accounts): switch the retro on or off, pick twice a week, once a
  week or every evening, see when it runs next, and run it now. The last retro's summary and suggestions show
  there too.
- **Setup asks about the retro**, and existing installs are asked once after updating. Turning it on adds a
  daily check that uses no AI and starts a retro only when one is due.
- Triage now logs every mail it archives or trashes to `artifacts/inbox/retro/`, and leaves a mail the retro
  brought back alone.
- The IMAP helper can restore a message from Trash to the inbox, unread.

## 1.0.0

- Inbox stands alone: the old Email Triage plugin is gone, and Inbox no longer migrates from it.
