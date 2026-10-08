#!/usr/bin/env python3
"""IMAP helper for email-triage accounts with `"fetch": "imap"` (no Gmail API, no OAuth).

Never marks mail read as a side effect: `list` and `peek` open the mailbox
read-only (EXAMINE) and every fetch uses BODY.PEEK[]. Only `mark-read` sets
\\Seen, and only `trash` moves mail.

Messages are addressed by their Message-ID header, which survives sessions and
folder moves. IMAP UIDs are resolved inside the session, right before a write,
and never leave it. A message with no Message-ID gets `uid:<n>`, which is only
good until the server renumbers the mailbox.

Usage (cwd = workspace root):
  python data/scripts/email-triage/imap_helper.py list      --account NAME [--since YYYY-MM-DD | --unseen]
  python data/scripts/email-triage/imap_helper.py peek      --account NAME --id '<abc@host>'
  python data/scripts/email-triage/imap_helper.py mark-read --account NAME --id '<abc@host>' [--id ...]
  python data/scripts/email-triage/imap_helper.py trash     --account NAME --id '<abc@host>' [--id ...]

`list` prints JSON [{id, from, to, cc, subject, date, seen, snippet}], oldest
first, capped at --limit. `peek` prints one JSON line per id with the body text.
`mark-read` / `trash` print one JSON line per id with `ok`, and exit 1 if any failed.

Connection settings come from the account's `imap` block in
data/artifacts/email-triage/config.json:
  {"host", "port", "ssl", "username", "credential_env", "mailbox", "trash_folder"}
Any of them can be given (or overridden) on the command line instead.
`username` defaults to the account's `address`; `credential_env` names the env
var holding the mailbox password.
"""
import argparse, datetime as dt, email, imaplib, json, os, re, sys
from email.header import decode_header, make_header

CONFIG = os.path.join(os.environ.get("LUCIDOS_WORKSPACE", "."), "data/artifacts/email-triage/config.json")
FIELDS = ("host", "port", "ssl", "username", "credential_env", "mailbox", "trash_folder")


def q(s):
    """Quote an IMAP string argument; imaplib passes arguments through raw."""
    return s if s.startswith('"') else '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def hdr(v):
    try:
        return str(make_header(decode_header(v or "")))
    except Exception:
        return v or ""


def account_block(name):
    accounts = json.load(open(CONFIG)).get("accounts", {})
    if isinstance(accounts, list):  # tolerate a list of blocks carrying `name`
        accounts = {a.get("name"): a for a in accounts}
    if name not in accounts:
        sys.exit(f"no account {name!r} in {CONFIG} (have: {', '.join(map(str, accounts))})")
    return accounts[name]


def settings(a):
    block = account_block(a.account) if a.account else {}
    c = dict(block.get("imap") or {})
    c.update({k: getattr(a, k) for k in FIELDS if getattr(a, k) is not None})
    c.setdefault("username", block.get("address"))
    missing = [k for k in ("host", "username", "credential_env") if not c.get(k)]
    if missing:
        sys.exit(f"missing IMAP setting(s): {', '.join(missing)} (account `imap` block or CLI flags)")
    return c


def connect(c):
    password = os.environ.get(c["credential_env"])
    if not password:
        sys.exit(f"env var {c['credential_env']} is not set: add the mailbox password as a credential")
    if c.get("ssl", True):
        M = imaplib.IMAP4_SSL(c["host"], int(c.get("port", 993)))
    else:  # never send the password in the clear: plain port means STARTTLS
        M = imaplib.IMAP4(c["host"], int(c.get("port", 143)))
        M.starttls()
    M.login(c["username"], password)
    return M


def text_of(msg, limit=None):
    parts = msg.walk() if msg.is_multipart() else [msg]
    plain = html = None
    for p in parts:
        ct = p.get_content_type()
        if str(p.get("Content-Disposition", "")).startswith("attachment"):
            continue
        if ct in ("text/plain", "text/html"):
            try:
                t = p.get_payload(decode=True).decode(p.get_content_charset() or "utf-8", "replace")
            except Exception:
                continue
            if ct == "text/plain" and plain is None:
                plain = t
            elif ct == "text/html" and html is None:
                html = re.sub(r"<[^>]+>", " ", t)
    t = re.sub(r"\s+", " ", plain or html or "").strip()
    return t[:limit] if limit else t


def uids_for(M, msgid):
    if msgid.startswith("uid:"):
        return [msgid[4:]]
    typ, d = M.uid("SEARCH", None, "HEADER", "Message-ID", q(msgid))
    return [u.decode() for u in d[0].split()] if typ == "OK" and d and d[0] else []


def trash_folder(M, c):
    """The \\Trash SPECIAL-USE folder (RFC 6154), else the configured fallback."""
    typ, lines = M.list()
    for line in lines if typ == "OK" else []:
        m = isinstance(line, bytes) and re.match(rb'\(([^)]*)\) (?:"[^"]*"|NIL) (.+)$', line)
        if m and b"\\trash" in m.group(1).lower().split():
            return q(m.group(2).decode())
    return q(c.get("trash_folder", "Trash"))


def cmd_list(M, c, criteria, limit):
    M.select(q(c.get("mailbox", "INBOX")), readonly=True)
    typ, d = M.uid("SEARCH", None, *criteria, "UNDELETED")
    out = []
    for uid in (d[0].split() if d and d[0] else [])[-limit:]:
        typ, r = M.uid("FETCH", uid, "(FLAGS BODY.PEEK[])")
        if typ != "OK" or not r or not isinstance(r[0], tuple):
            continue  # expunged since the SEARCH
        m = email.message_from_bytes(r[0][1])
        out.append({
            "id": (m["Message-ID"] or f"uid:{uid.decode()}").strip(),
            "from": hdr(m["From"]), "to": hdr(m["To"]), "cc": hdr(m["Cc"]),
            "subject": hdr(m["Subject"]), "date": m["Date"],
            "seen": b"\\Seen" in imaplib.ParseFlags(r[0][0]),
            "snippet": text_of(m, 400),
        })
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


def cmd_peek(M, c, ids):
    M.select(q(c.get("mailbox", "INBOX")), readonly=True)
    for i in ids:
        uids = uids_for(M, i)
        typ, r = M.uid("FETCH", uids[-1], "(BODY.PEEK[])") if uids else ("NO", None)
        if typ != "OK" or not r or not isinstance(r[0], tuple):
            print(json.dumps({"id": i, "error": "not found"}))
            continue
        print(json.dumps({"id": i, "body": text_of(email.message_from_bytes(r[0][1]), 8000)}, ensure_ascii=False))
    return 0


def cmd_write(M, c, ids, action):
    M.select(q(c.get("mailbox", "INBOX")))  # read-write
    caps = M.capability()[1][0].decode().upper().split()
    trash = trash_folder(M, c) if action == "trash" else None
    failed = 0
    for i in ids:
        uids = uids_for(M, i)
        if not uids:
            ok, err = False, "not found"
        elif action == "mark-read":
            ok, err = M.uid("STORE", ",".join(uids), "+FLAGS.SILENT", r"(\Seen)")[0] == "OK", "STORE failed"
        elif "MOVE" in caps:
            ok, err = M.uid("MOVE", ",".join(uids), trash)[0] == "OK", f"MOVE to {trash} failed"
        elif M.uid("COPY", ",".join(uids), trash)[0] != "OK":
            ok, err = False, f"COPY to {trash} failed, message left in place"  # never flag \Deleted without a copy
        elif M.uid("STORE", ",".join(uids), "+FLAGS.SILENT", r"(\Deleted)")[0] != "OK":
            ok, err = False, f"copied to {trash} but could not flag the original \\Deleted"
        else:
            if "UIDPLUS" in caps:
                M.uid("EXPUNGE", ",".join(uids))
            else:  # ponytail: plain EXPUNGE also removes mail another client already flagged \Deleted
                M.expunge()
            ok, err = True, None
        failed += not ok
        print(json.dumps({"id": i, "ok": ok, "action": action, **({"error": err} if not ok else {})}))
    return 1 if failed else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0],
                                 epilog="Never use read_email on these accounts: it sets \\Seen.")
    ap.add_argument("cmd", choices=["list", "peek", "mark-read", "trash"])
    ap.add_argument("--account", help="account name (key under `accounts` in config.json)")
    ap.add_argument("--since", help="list: YYYY-MM-DD, default today - 2 days")
    ap.add_argument("--unseen", action="store_true", help="list: every unread message instead of a date window")
    ap.add_argument("--limit", type=int, default=50, help="list: newest N messages (default 50)")
    ap.add_argument("--id", action="append", default=[], help="Message-ID (or uid:<n>); repeatable")
    ap.add_argument("--host")
    ap.add_argument("--port", type=int)
    ap.add_argument("--ssl", action=argparse.BooleanOptionalAction, default=None,
                    help="implicit TLS (default); --no-ssl uses STARTTLS")
    ap.add_argument("--username", help="default: the account's address")
    ap.add_argument("--credential-env", help="env var holding the mailbox password")
    ap.add_argument("--mailbox", help="default INBOX")
    ap.add_argument("--trash-folder", help="used only when the server has no \\Trash SPECIAL-USE folder")
    a = ap.parse_args()
    if a.cmd != "list" and not a.id:
        ap.error(f"{a.cmd} needs at least one --id")

    c = settings(a)
    M = connect(c)
    try:
        if a.cmd == "list":
            since = dt.date.fromisoformat(a.since) if a.since else dt.date.today() - dt.timedelta(days=2)
            return cmd_list(M, c, ["UNSEEN"] if a.unseen else ["SINCE", since.strftime("%d-%b-%Y")], a.limit)
        if a.cmd == "peek":
            return cmd_peek(M, c, a.id)
        return cmd_write(M, c, a.id, a.cmd)
    finally:
        M.logout()


if __name__ == "__main__":
    sys.exit(main())
