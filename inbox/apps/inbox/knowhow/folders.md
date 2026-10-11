---
name: Inbox Folders
description: How the Inbox app lists and opens each account's folders and labels (Gmail labels over the API, IMAP LIST through the IMAP bridge), which labels it hides, what it caches, and which actions a folder row allows. Load when a folder is missing, a folder view is empty or stale, or the IMAP folder ops fail
---

# Inbox folders

Folders are a browse-only side door, never part of triage. Each account in the sidebar has a chevron that expands its folders or labels. Opening one shows its newest 30 threads in the same list UI, without the Needs you / Not triaged zones. The default view on every open is still the account's inbox.

## Gmail accounts

- **List**: `GET /labels` through the account's own proxy (`accounts["<name>"].proxy` in `artifacts/inbox/settings.json`), after the same `/profile` check the inbox list does. A passed check is remembered for 10 minutes (`verify` in `mail.js`).
- **Grouping** (`GMAIL_SYS` in `mail.js`):
  - Shown: Starred, Sent, a virtual **All mail** (id `__all`: `threads.list` with no `labelIds`, so everything but spam and trash), then the user labels, A to Z.
  - Behind **More**: Drafts, Important, the five `CATEGORY_*` labels, Spam, Trash, and any user label whose `labelListVisibility` is `labelHide`.
  - Hidden: INBOX (it is the main view), UNREAD, CHAT and the superstar labels (YELLOW_STAR and friends).
- **Nesting**: `Clients/Acme` shows as "Acme" indented under "Clients", if "Clients" is in the same group. A parent label can be empty while its child holds the mail.
- **Open**: `GET /threads?maxResults=30&labelIds=<id>`, plus `includeSpamTrash=true` for SPAM and TRASH. Thread metadata goes through the same historyId cache as the inbox list.

## IMAP accounts

An app frame cannot speak IMAP, so the folder ops go through the "Inbox — IMAP bridge" trigger (`scripts/imap_bridge.py`), as `InboxImapActionRequested` with the account's name and one of two read-only ops:

| op | payload | answer (`InboxImapResult`) |
|---|---|---|
| `folders` | none | `folders: [{path, name, delim, flags, special, messages, unseen, cache}]`, from IMAP LIST plus STATUS (MESSAGES UNSEEN) per folder |
| `folder` | `folder` (a `path` from `folders`), `limit` (default 30, max 50) | `file`: the snapshot it wrote, `cache/imap-<slug>-folder-<folder>-<hash>.json` |

- `path` is the wire name (modified UTF-7) to send back; `name` is it decoded for display. `\Noselect` containers are skipped.
- `special` is the RFC 6154 flag (`\Archive`, `\Sent`, `\Drafts`, `\Junk`, `\Trash`), or the folder name when the server sends none. Archive and Sent show, Drafts, Spam and Trash wait behind More, and any other folder shows as a user folder.
- `folder` refuses INBOX and any name LIST did not return. It SELECTs the folder read-only and fetches with BODY.PEEK, so browsing never marks mail read. Attachments go to `cache/imap-<slug>-folder-att/`, pruned to what some of that account's folder snapshots still reference. Like the INBOX snapshot, these files hold mail bodies: they live under `artifacts/inbox/cache/`, which carries its own `.gitignore`, and are written straight to disk.
- Neither op resyncs INBOX, unlike every other bridge op.
- IMAP folder rows are **read-only** in the app: no archive, delete, read or unread, because the bridge's write ops only address INBOX. Reply, Summarize and Ask Lucidos work. Replying from a folder still sends over SMTP. The `\Answered` flag is only set when the original is in INBOX.

## Caching

- Folder lists: in memory for 10 minutes per account (`FOLDERS_TTL`).
- Folder contents: in memory for 2 minutes per folder (`FOLDER_TTL`). For an IMAP account, a reopen first paints the bridge's last snapshot, then refreshes if it is older than that, since a bridge round trip takes a few seconds.
- Refresh in the list header refetches the open folder.

## Actions on a folder row (Gmail)

`canAct` in `app.js` decides:
- **Archive** only if the thread still has a message in INBOX. Otherwise there is no Archive button, and `e` and swipe-right do nothing.
- **Delete** anywhere except the Trash view, where trashing again would be a no-op that undo turns into an untrash.
- **Read / unread / reply / summarize / ask**: always. Opening an unread thread marks it read, as in the inbox.
- Undo of a delete only re-adds INBOX to messages that were in the inbox; a thread that never was gets only its untrash.
