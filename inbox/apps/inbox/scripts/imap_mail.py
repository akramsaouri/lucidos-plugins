#!/usr/bin/env python3
r"""IMAP helpers for the Inbox bridge (imap_bridge.py, beside this file).

Never marks mail read as a side effect: callers open folders read-only to
browse and fetch with BODY.PEEK. Messages are addressed by their Message-ID
header (stable across sessions and folder moves) and resolved to a UID inside
the same session, just before a write.

Connection settings come from the account's block in triage's
data/artifacts/email-triage/config.json, the same `"fetch": "imap"` schema its
own scripts/inbox-triage/imap_helper.py reads:

  "imap": {"host", "port", "ssl", "username", "credential_env", "mailbox",
           "trash_folder", "archive_folder", "sent_folder", "smtp_host", "smtp_port"}

`host` and `credential_env` are required. `username` defaults to the account's
`address`, `port` to 993 (143 with `"ssl": false`, which means STARTTLS: the
password is never sent in the clear). The folder names are fallbacks for a
server that flags no RFC 6154 special-use folder.
"""
import imaplib, json, os, re
from email.header import decode_header, make_header

ROOT = os.environ.get("LUCIDOS_WORKSPACE") or os.getcwd()
CONFIG = os.path.join(ROOT, "data", "artifacts", "email-triage", "config.json")
# RFC 6154 special-use flags, and the names servers use when they send none.
SPECIAL_FLAGS = {"\\archive": "archive", "\\sent": "sent", "\\drafts": "drafts", "\\junk": "junk", "\\trash": "trash"}
SPECIAL_NAMES = {"archive": "archive", "sent": "sent", "sent items": "sent", "sent messages": "sent", "drafts": "drafts",
                 "spam": "junk", "junk": "junk", "trash": "trash", "deleted items": "trash", "deleted messages": "trash"}
FALLBACK = {"archive": ("archive_folder", "Archive"), "trash": ("trash_folder", "Trash"), "sent": ("sent_folder", "Sent")}
LIST_RE = re.compile(r'^\((?P<flags>[^)]*)\) (?P<delim>"(?:[^"\\]|\\.)*"|NIL) (?P<name>.*)$', re.I)


def accounts():
    """Triage's accounts as {name: block}. The config keys them by name; tolerate a list of blocks too."""
    raw = json.load(open(CONFIG, encoding="utf-8")).get("accounts", {})
    if isinstance(raw, list):
        raw = {a.get("name"): a for a in raw}
    return raw


def imap_accounts():
    """Names of the accounts the bridge serves: password IMAP, `"fetch": "imap"`."""
    return [n for n, b in accounts().items() if isinstance(b, dict) and b.get("fetch") == "imap"]


def settings(name):
    """(block, imap settings) for one account, with defaults filled in. Raises ValueError naming what is missing."""
    block = accounts().get(name)
    if not isinstance(block, dict):
        raise ValueError(f"no account {name!r} in the triage config")
    if block.get("fetch") != "imap":
        raise ValueError(f"{name!r} is not an IMAP account (fetch is {block.get('fetch')!r})")
    c = dict(block.get("imap") or {})
    c.setdefault("username", block.get("address"))
    c.setdefault("credential_env", block.get("credential_env"))  # tolerate it beside `imap` rather than inside
    missing = [k for k in ("host", "username", "credential_env") if not c.get(k)]
    if missing:
        raise ValueError(f"{name}: missing IMAP setting(s) {', '.join(missing)} in its `imap` block")
    return block, c


def password(c):
    pw = os.environ.get(c["credential_env"])
    if not pw:
        raise KeyError(c["credential_env"])
    return pw


def connect(name):
    """Log in to one account -> (M, imap settings, block)."""
    block, c = settings(name)
    pw = password(c)
    if c.get("ssl", True):
        M = imaplib.IMAP4_SSL(c["host"], int(c.get("port", 993)))
    else:
        M = imaplib.IMAP4(c["host"], int(c.get("port", 143)))
        M.starttls()
    M.login(c["username"], pw)
    return M, c, block


def hdr(v):
    try:
        return str(make_header(decode_header(v or "")))
    except Exception:
        return v or ""


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


def quoted(s):
    """Quote an IMAP string argument; imaplib passes arguments through raw."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def check(res, what):
    typ, d = res
    if typ != "OK":
        raise RuntimeError(f"{what}: {typ} {d}")
    return d


def caps_of(M):
    """Post-login capabilities. imaplib's M.capabilities is the PRE-auth list and login() never refreshes it,
    and some servers (Dovecot among them) only advertise MOVE and UIDPLUS after authentication."""
    typ, d = M.capability()
    return set(d[0].decode().upper().split()) if typ == "OK" and d and d[0] else set()


def unquote(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] == '"':
        return re.sub(r'\\(.)', r'\1', s[1:-1])
    return s


def list_raw(M):
    """IMAP LIST -> [(path, flags, delim)], wire names (modified UTF-7) as the server sent them."""
    out = []
    for raw in check(M.list(), "LIST") or []:
        if raw is None:
            continue
        literal = None
        if isinstance(raw, tuple):  # a name sent as a literal: (b'(\\HasNoChildren) "/" {7}', b'Projets')
            raw, literal = raw[0], raw[1]
        mm = LIST_RE.match(raw.decode("utf-8", "replace").strip())
        if not mm:
            continue
        delim = None if mm.group("delim").upper() == "NIL" else unquote(mm.group("delim"))
        path = literal.decode("utf-8", "replace") if literal is not None else unquote(re.sub(r"\{\d+\}$", "", mm.group("name")))
        if path:
            out.append((path, mm.group("flags").split(), delim))
    return out


def special_of(flags, leaf):
    low = {f.lower() for f in flags}
    return next((SPECIAL_FLAGS[f] for f in low if f in SPECIAL_FLAGS), "") or SPECIAL_NAMES.get(leaf.lower(), "")


def special_folder(M, c, role):
    """The folder flagged for `role` (archive | trash | sent), else the configured name, else the common default."""
    flag = "\\" + role
    for path, flags, _ in list_raw(M):
        if flag in {f.lower() for f in flags}:
            return path
    key, default = FALLBACK[role]
    return c.get(key) or default


def move(M, caps, uid, dest):
    if "MOVE" in caps:
        check(M.uid("MOVE", uid, quoted(dest)), f"MOVE {dest}")
        return
    check(M.uid("COPY", uid, quoted(dest)), f"COPY {dest}")  # never flag \Deleted without a copy
    check(M.uid("STORE", uid, "+FLAGS.SILENT", "(\\Deleted)"), "STORE +Deleted")
    if "UIDPLUS" in caps:
        check(M.uid("EXPUNGE", uid), "UID EXPUNGE")  # expunges this message only
    # Without UIDPLUS, leave it flagged: a bare EXPUNGE would also purge mail someone else flagged \Deleted
    # in another client. Listings skip \Deleted mail.
