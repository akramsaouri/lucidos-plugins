#!/usr/bin/env python3
"""Snapshot an IMAP mailbox WITHOUT marking anything read.

Why this exists
---------------
The obvious way to triage an IMAP account is `read_emails(account,
search="UNSEEN")` followed by `read_email(uid)` per message. That is a trap: both
tools fetch the message with a plain `FETCH BODY[]` / `RFC822`, and the IMAP spec
says a non-peek body fetch SETS the `\Seen` flag. So the act of reading a message
in order to decide whether it needs the user marks it read — including mail the
user has never opened, which then shows up read on their phone.

Observed in a live workspace: one `read_emails(limit=50)` against Exchange Online
cleared the unread state of all 50 fetched messages, 13 of them genuine unreads,
which had to be restored by hand with `STORE -FLAGS \Seen`.

This script fetches the same data without the side effect:

  * INBOX is opened with EXAMINE (``readonly=True``), so the server is not
    permitted to change a flag at all.
  * Bodies are fetched with ``BODY.PEEK[]``, the IMAP-level way of saying "do not
    set \Seen".

Both belts are deliberate. EXAMINE alone would do, but a later edit that needs
read-write for some other reason must not silently start eating unread state.

The run then works entirely off the snapshot: rules, AI categorization, the
notified ledger and the output file all read `body_text` / `body_html` from the
JSON rather than touching the mailbox again. `\Seen` is only ever set on purpose,
by a `read` action or a `no_action_clear: "read"` verdict.

Usage
-----
    python apps/email-triage/scripts/snapshot_imap.py --account "Outlook" [--limit 50]

Config
------
Reads the account block from `artifacts/email-triage/config.json`. The block needs:

    {
      "name": "Outlook",
      "slug": "outlook",
      "address": "someone@example.com",
      "fetch": "imap-peek",
      "imap_host": "outlook.office365.com",
      "imap_port": 993,                 // optional, defaults to 993
      "oauth_provider": "microsoft"     // optional; omit for password auth
    }

Auth resolves in this order, from environment variables the engine injects into
every subprocess it spawns:

  1. `oauth_provider` set  -> XOAUTH2 with `OAUTH_<PROVIDER>_ACCESS_TOKEN`
     (auto-refreshed by the engine).
  2. otherwise             -> LOGIN with `CRED_<NAME>_PASSWORD` (password-type
     credential) or `CRED_<NAME>` (single-value), where `<NAME>` is
     `credential` on the account block, else the account name uppercased with
     non-alphanumerics turned into underscores.

Output
------
`artifacts/email-triage/inbox-<slug>.json` — the most recent N inbox messages
regardless of read state, newest first. Not only the unseen ones: a consumer that
offers an "All" view would otherwise be shown a filtered mailbox and lie about it.
The unseen set is `[m for m in snapshot["messages"] if m["unread"]]`.
"""

from __future__ import annotations

import argparse
import email
import email.header
import email.utils
import imaplib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

CONFIG_PATH = Path("data/artifacts/email-triage/config.json")
OUT_DIR = Path("data/artifacts/email-triage")

# A snapshot of 50 messages with full HTML gets large fast, and no known consumer
# has an attachment UI. Cap the bodies, drop the attachments.
MAX_HTML = 100_000
MAX_TEXT = 100_000
PREVIEW_CHARS = 200


def load_account(name: str) -> dict:
    if not CONFIG_PATH.exists():
        raise SystemExit(f"{CONFIG_PATH} not found — is the plugin set up?")
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    for account in config.get("accounts", []):
        if account.get("name") == name:
            return account
    known = ", ".join(a.get("name", "?") for a in config.get("accounts", []))
    raise SystemExit(f"no account named {name!r} in {CONFIG_PATH} (have: {known})")


def env_key(value: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", value.upper()).strip("_")


def authenticate(conn: imaplib.IMAP4_SSL, account: dict) -> None:
    address = account.get("address")
    if not address:
        raise SystemExit(f"account {account.get('name')!r} has no 'address'")

    provider = account.get("oauth_provider")
    if provider:
        var = f"OAUTH_{env_key(provider)}_ACCESS_TOKEN"
        token = os.environ.get(var)
        if not token:
            raise SystemExit(f"{var} missing — is the {provider} OAuth account connected?")
        blob = f"user={address}\x01auth=Bearer {token}\x01\x01".encode()
        conn.authenticate("XOAUTH2", lambda _: blob)
        return

    name = account.get("credential") or account.get("name", "")
    base = f"CRED_{env_key(name)}"
    password = os.environ.get(f"{base}_PASSWORD") or os.environ.get(base)
    if not password:
        raise SystemExit(
            f"{base}_PASSWORD (or {base}) missing — add the credential, or set "
            f"'oauth_provider' on the account block for XOAUTH2."
        )
    conn.login(os.environ.get(f"{base}_USERNAME", address), password)


def decode_header(value: str | None) -> str:
    """Decode a MIME-encoded header (=?utf-8?B?...?=) into plain text."""
    if not value:
        return ""
    out = []
    for chunk, enc in email.header.decode_header(value):
        if isinstance(chunk, bytes):
            try:
                out.append(chunk.decode(enc or "utf-8", errors="replace"))
            except (LookupError, UnicodeDecodeError):
                out.append(chunk.decode("utf-8", errors="replace"))
        else:
            out.append(chunk)
    return "".join(out).strip()


def part_text(part) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")


def extract_bodies(msg) -> tuple[str, str]:
    """Return (text, html); either may be empty."""
    text_parts: list[str] = []
    html_parts: list[str] = []
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_maintype() == "multipart":
                continue
            if "attachment" in str(part.get("Content-Disposition") or "").lower():
                continue
            ctype = part.get_content_type()
            if ctype == "text/plain":
                text_parts.append(part_text(part))
            elif ctype == "text/html":
                html_parts.append(part_text(part))
    else:
        body = part_text(msg)
        (html_parts if msg.get_content_type() == "text/html" else text_parts).append(body)
    return "\n".join(text_parts).strip(), "\n".join(html_parts).strip()


def strip_html(html: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    for entity, char in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"),
                         ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        text = text.replace(entity, char)
    return re.sub(r"\s+", " ", text).strip()


def parse_date(msg, meta: bytes) -> str:
    raw = msg.get("Date")
    if raw:
        try:
            dt = email.utils.parsedate_to_datetime(raw)
            if dt is not None:
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except (TypeError, ValueError):
            pass
    if b"INTERNALDATE" in meta:
        parsed = imaplib.Internaldate2tuple(meta)
        if parsed:
            return (datetime.fromtimestamp(time.mktime(parsed), tz=timezone.utc)
                    .isoformat().replace("+00:00", "Z"))
    return ""


def fetch_snapshot(account: dict, limit: int) -> list[dict]:
    host = account.get("imap_host")
    if not host:
        raise SystemExit(f"account {account.get('name')!r} has no 'imap_host'")

    conn = imaplib.IMAP4_SSL(host, int(account.get("imap_port", 993)))
    try:
        authenticate(conn, account)

        # EXAMINE, not SELECT: the server may not change a single flag while we read.
        conn.select("INBOX", readonly=True)

        typ, data = conn.uid("SEARCH", None, "ALL")
        if typ != "OK":
            raise SystemExit(f"IMAP SEARCH failed: {typ} {data!r}")
        uids = data[0].split()[-limit:]

        messages: list[dict] = []
        for uid in reversed(uids):  # newest first
            # BODY.PEEK[] — the whole point of this script. Never BODY[] / RFC822.
            typ, resp = conn.uid("FETCH", uid, "(UID FLAGS INTERNALDATE BODY.PEEK[])")
            if typ != "OK" or not resp or resp[0] is None:
                continue
            meta, raw = b"", b""
            for item in resp:
                if isinstance(item, tuple):
                    meta += item[0]
                    raw = item[1]
                elif isinstance(item, bytes):
                    meta += item
            msg = email.message_from_bytes(raw)

            flags = imaplib.ParseFlags(meta) or ()
            from_name, from_addr = email.utils.parseaddr(msg.get("From", ""))
            text, html = extract_bodies(msg)

            messages.append({
                "uid": int(uid),
                "from_name": decode_header(from_name) or from_addr or "(unknown)",
                "from_addr": from_addr,
                "subject": decode_header(msg.get("Subject")),
                "date": parse_date(msg, meta),
                "preview": (text or strip_html(html))[:PREVIEW_CHARS].strip(),
                "unread": b"\\Seen" not in flags,
                "body_text": text[:MAX_TEXT],
                "body_html": html[:MAX_HTML],
            })
        return messages
    finally:
        try:
            conn.logout()
        except Exception:
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--account", required=True, help="account 'name' from config.json")
    ap.add_argument("--limit", type=int, default=50, help="most recent N inbox messages")
    ap.add_argument("--stdout", action="store_true", help="print JSON instead of writing the snapshot")
    args = ap.parse_args()

    account = load_account(args.account)
    payload = {
        "account": account["name"],
        "synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "messages": fetch_snapshot(account, args.limit),
    }

    if args.stdout:
        json.dump(payload, sys.stdout, ensure_ascii=False)
        return 0

    slug = account.get("slug") or re.sub(r"[^a-z0-9]+", "-", account["name"].lower()).strip("-")
    out = OUT_DIR / f"inbox-{slug}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    unread = sum(1 for m in payload["messages"] if m["unread"])
    print(f"wrote {out} — {len(payload['messages'])} messages, {unread} unread (no flags touched)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
