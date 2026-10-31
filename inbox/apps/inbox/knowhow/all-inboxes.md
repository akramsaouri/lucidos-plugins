---
name: Inbox All inboxes
description: How the Inbox app's All inboxes view merges every account into one list, how actions route to each row's own account, how a failed account shows, and how the last picked mailbox is remembered. Load when the merged list is missing mail, tags the wrong account, or opens on the wrong mailbox
---

# Inbox: All inboxes

With two or more accounts in `Mail.ORDER` (triage's accounts, in `artifacts/email-triage/config.json` order), **All inboxes** leads the account list in the sidebar, and **All** leads the phone's account pills. It shows every account's mail in the same two zones (Needs you / Not triaged yet), newest first, and tags each row with its account's label in the account's colour. With a single account neither shows.

- **Picking**: the picked mailbox is `S.filter` in `app.js`: an account key, or `'all'`. A pick from the sidebar or the pills is saved to `lucidos.storage.local` under `inbox.filter` and restored on the next open. A saved value that is no longer an account (an account removed from `config.json`, or `'all'` with a single account) falls back to the first account in `ORDER`. Opening a folder or leaving a per-account Triage pane moves to that account without saving it.
- **No folders, no Triage entry**: All inboxes has neither. Folders and the per-account Triage entry stay under each account; the triage-wide view is still the **All accounts** strip above it.
- **Actions** go through the row's own account, as everywhere else (`Mail.act` reads `t.account`): Gmail rows hit that account's own proxy, IMAP rows emit `InboxImapActionRequested` to the IMAP bridge for that account.
- **Failures**: an account that fails to load keeps its red dot and a quiet "<account>: not loaded" line in the strip above the list, and All inboxes gets a red dot listing the failed accounts. The other accounts still show. The list blanks to "Couldn't load any mailbox" only when every account has an error.

Tests: the All inboxes cases in the plugin repo's `tests/inbox/triage/` (`cd tests/inbox/triage && npm install && npm test`).
