# Inbox changelog

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
