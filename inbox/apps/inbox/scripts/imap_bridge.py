#!/usr/bin/env python3
"""IMAP bridge for the Inbox app (apps/inbox), for Email Triage accounts with `"fetch": "imap"`.

An app frame cannot speak IMAP or SMTP, so the app emits an event and the "Inbox — IMAP bridge" script
trigger runs this file. Every request names its account (the key in Email Triage's config.json), and every
answer is an `InboxImapResult` event carrying the same request_id and account:

  InboxImapSyncRequested    {request_id, account?}     no account: every IMAP account
  InboxImapActionRequested  {request_id, account, op: read|unread|archive|trash, ids}
  InboxImapActionRequested  {request_id, account, op: restore, ids, from_folder: archive|trash, mark_unread}
  InboxImapActionRequested  {request_id, account, op: send, to, cc, subject, body, in_reply_to, references}
  InboxImapActionRequested  {request_id, account, op: folders}               -> payload.folders (LIST + STATUS)
  InboxImapActionRequested  {request_id, account, op: folder, folder, limit} -> payload.file (one folder's snapshot)
  EmailTriageCompleted      a triage run finished: resync each IMAP account in its account_results

Every request except the two read-only folder ops ends with a fresh snapshot of that account's INBOX in
artifacts/inbox/cache/imap-<slug>.json (attachments in cache/imap-<slug>-att/). `folder` writes the newest
`limit` messages of that folder to cache/imap-<slug>-folder-<folder>-<hash>.json (attachments in
cache/imap-<slug>-folder-att/). The cache holds mail bodies, so it is written straight to disk, never through
`lucidos data write`, and carries its own `.gitignore` so the workspace repo never commits it. Mail is
fetched with BODY.PEEK only, and folders are opened read-only, so nothing here marks anything read.
"""
import base64, email, hashlib, imaplib, json, os, re, smtplib, subprocess, sys, time
from datetime import datetime, timezone
from email import policy
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

sys.dont_write_bytecode = True  # no __pycache__ in the plugin's app folder, which would read as a local edit
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import imap_mail as I  # noqa: E402

os.chdir(I.ROOT)
CACHE_DIR = os.path.join("data", "artifacts", "inbox", "cache")
CACHE_URL = "artifacts/inbox/cache/"
SETTINGS = os.path.join("data", "artifacts", "inbox", "settings.json")
SEEN_DIR = os.path.join(CACHE_DIR, ".requests")
MAX_ATT, MAX_INLINE, MAX_MSGS, MAX_FOLDER_MSGS = 5 << 20, 400 << 10, 100, 50
WRITE_OPS = {"read", "unread", "archive", "trash", "restore"}
FOLDER_OPS = {"folders", "folder"}


def slug_for(name):
    """Email Triage's sidecar slug: lowercased and hyphenated, with only a "Gmail - " prefix dropped."""
    return re.sub(r"[^a-z0-9]+", "-", re.sub(r"^Gmail\s*-\s*", "", name, flags=re.I).strip().lower())


def ensure_cache():
    os.makedirs(CACHE_DIR, exist_ok=True)
    ignore = os.path.join(CACHE_DIR, ".gitignore")
    if not os.path.exists(ignore):
        with open(ignore, "w") as f:
            f.write("# Inbox's mail cache: message bodies and attachments. Never commit it.\n*\n")


def first_time(request_id):
    """True once per request_id. A second bridge trigger (say, one registered by hand before the plugin) gets
    False, so the same request is never handled twice: a reply is never sent twice."""
    if not request_id:
        return True
    os.makedirs(SEEN_DIR, exist_ok=True)
    now = time.time()
    for f in os.listdir(SEEN_DIR):
        try:
            if now - os.path.getmtime(os.path.join(SEEN_DIR, f)) > 86400:
                os.remove(os.path.join(SEEN_DIR, f))
        except OSError:
            pass
    try:
        os.close(os.open(os.path.join(SEEN_DIR, hashlib.sha1(str(request_id).encode()).hexdigest()), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        return True
    except FileExistsError:
        return False


def emit(payload):
    ok, err = payload.get("ok"), str(payload.get("error") or "")[:200]
    who = payload.get("account") or "?"
    payload["summary"] = f"Inbox IMAP bridge: {payload.get('op') or '?'} for {who} {'ok' if ok else 'failed'}" + ("" if ok or not err else f" ({err})")
    subprocess.run(["lucidos", "events", "emit", "InboxImapResult", "--payload", json.dumps(payload, ensure_ascii=False)],
                   capture_output=True, timeout=30)


def find_uid(M, msgid):
    if msgid.startswith("uid:"):
        return msgid[4:].encode()
    typ, d = M.uid("SEARCH", None, "HEADER", "Message-ID", I.quoted(msgid))
    uids = d[0].split() if typ == "OK" and d and d[0] else []
    return uids[-1] if uids else None


def decode_part(p):
    raw = p.get_payload(decode=True) or b""
    try:
        return raw.decode(p.get_content_charset() or "utf-8", "replace")
    except LookupError:
        return raw.decode("utf-8", "replace")


def parse(m, att_dir, att_url):
    """-> (html, text, attachments). Small inline (cid:) images are folded into the html as data: URLs."""
    html = text = None
    atts, cids = [], {}
    for p in (m.walk() if m.is_multipart() else [m]):
        if p.is_multipart():
            continue
        ct = p.get_content_type()
        disp = (p.get_content_disposition() or "").lower()
        name = I.hdr(p.get_filename()) if p.get_filename() else ""
        cid = (p.get("Content-ID") or "").strip().strip("<>")
        if ct in ("text/html", "text/plain") and not name and disp != "attachment":
            if ct == "text/html" and html is None:
                html = decode_part(p)
                continue
            if ct == "text/plain" and text is None:
                text = decode_part(p)
                continue
        data = p.get_payload(decode=True) or b""
        if cid and ct.startswith("image/") and len(data) <= MAX_INLINE:
            cids[cid] = f"data:{ct};base64," + base64.b64encode(data).decode()
            if disp != "attachment":
                continue
        if not name and not cid:
            continue
        name = name or f"{cid or 'attachment'}.{ct.split('/')[-1]}"
        item = {"name": name, "type": ct, "size": len(data)}
        if data and len(data) <= MAX_ATT:
            ext = re.sub(r"[^A-Za-z0-9.]", "", os.path.splitext(name)[1])[:10] or "." + ct.split("/")[-1][:8]
            fname = hashlib.sha1(data).hexdigest()[:16] + ext
            path = os.path.join(att_dir, fname)
            if not os.path.exists(path):
                with open(path, "wb") as f:
                    f.write(data)
            item["path"] = att_url + fname
        atts.append(item)
    if html and cids:
        html = re.sub(r"cid:([^\"'\s)>]+)", lambda mm: cids.get(mm.group(1), mm.group(0)), html)
    return html, text, atts


def fetch_selected(M, limit, att_dir, att_url):
    """The newest `limit` messages of the mailbox already SELECTed, read-only, newest last."""
    typ, d = M.uid("SEARCH", None, "NOT", "DELETED")
    uids = (d[0].split() if typ == "OK" and d and d[0] else [])[-limit:]
    out = []
    for uid in uids:
        typ, r = M.uid("FETCH", uid, "(FLAGS INTERNALDATE BODY.PEEK[])")
        if typ != "OK" or not r or not isinstance(r[0], tuple):
            continue
        meta = r[0][0].decode("utf-8", "replace")
        m = email.message_from_bytes(r[0][1], policy=policy.compat32)
        when = imaplib.Internaldate2tuple(r[0][0])
        html, text, atts = parse(m, att_dir, att_url)
        mid = (m["Message-ID"] or "").strip()
        out.append({
            "id": mid or f"uid:{uid.decode()}", "uid": uid.decode(),
            "from": I.hdr(m["From"]), "to": I.hdr(m["To"]), "cc": I.hdr(m["Cc"]), "reply_to": I.hdr(m["Reply-To"]),
            "subject": I.hdr(m["Subject"]), "date": int(time.mktime(when)) * 1000 if when else None,
            "seen": "\\Seen" in meta, "answered": "\\Answered" in meta, "flagged": "\\Flagged" in meta,
            "message_id": mid, "references": (m["References"] or "").strip(), "in_reply_to": (m["In-Reply-To"] or "").strip(),
            "snippet": I.text_of(m, 300), "html": html, "text": text, "attachments": atts,
        })
    return out


def write_json(target, data):
    with open(target + ".tmp", "w") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(target + ".tmp", target)


def sync(M, c, name):
    slug = slug_for(name)
    att_dir = os.path.join(CACHE_DIR, f"imap-{slug}-att")
    os.makedirs(att_dir, exist_ok=True)
    I.check(M.select(I.quoted(c.get("mailbox", "INBOX")), readonly=True), "SELECT INBOX")
    msgs = fetch_selected(M, MAX_MSGS, att_dir, f"{CACHE_URL}imap-{slug}-att/")
    keep = {a["path"].rsplit("/", 1)[-1] for m in msgs for a in m["attachments"] if a.get("path")}
    for f in os.listdir(att_dir):
        if f not in keep:
            os.remove(os.path.join(att_dir, f))
    write_json(os.path.join(CACHE_DIR, f"imap-{slug}.json"),
               {"account": name, "synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "messages": msgs})
    return len(msgs)


def mutf7(s):
    """Decode an IMAP modified UTF-7 mailbox name (RFC 3501 5.1.3) for display."""
    def dec(mm):
        b = mm.group(1)
        if not b:
            return "&"
        b = b.replace(",", "/")
        try:
            return base64.b64decode(b + "=" * (-len(b) % 4)).decode("utf-16-be")
        except Exception:
            return mm.group(0)
    return re.sub(r"&([A-Za-z0-9+,]*)-", dec, s)


def cache_name(slug, path):
    fslug = re.sub(r"[^a-z0-9]+", "-", mutf7(path).lower()).strip("-")[:40] or "folder"
    return f"imap-{slug}-folder-{fslug}-{hashlib.sha1(path.encode()).hexdigest()[:6]}.json"


def list_folders(M, slug, status=True):
    """-> [{path, name, delim, flags, special, messages, unseen, cache}]. `path` is the wire name (modified UTF-7)
    to send back; `name` is it decoded for display. \\Noselect containers are left out."""
    out = []
    for path, flags, delim in I.list_raw(M):
        low = {f.lower() for f in flags}
        if "\\noselect" in low or "\\nonexistent" in low:
            continue
        name = mutf7(path)
        leaf = name.rsplit(delim, 1)[-1] if delim else name
        item = {"path": path, "name": name, "delim": delim, "flags": flags, "special": I.special_of(flags, leaf), "cache": cache_name(slug, path)}
        if status and path.upper() != "INBOX":
            try:
                typ, st = M.status(I.quoted(path), "(MESSAGES UNSEEN)")
                txt = st[0].decode("utf-8", "replace") if typ == "OK" and st and st[0] else ""
                for key in ("MESSAGES", "UNSEEN"):
                    n = re.search(key + r" (\d+)", txt)
                    if n:
                        item[key.lower()] = int(n.group(1))
            except Exception:
                pass  # a count is a nicety; the folder still opens
        out.append(item)
    return out


def fetch_folder(M, name, p):
    """Snapshot the newest messages of one folder into its cache file, read-only."""
    slug = slug_for(name)
    path = str(p.get("folder") or "")
    if not path or path.upper() == "INBOX":
        raise ValueError("folder must name a folder other than INBOX")
    if path not in {f["path"] for f in list_folders(M, slug, status=False)}:
        raise ValueError(f"no folder {path!r} on the server")
    try:
        limit = max(1, min(MAX_FOLDER_MSGS, int(p.get("limit") or 30)))
    except (TypeError, ValueError):
        limit = 30
    att_dir = os.path.join(CACHE_DIR, f"imap-{slug}-folder-att")
    os.makedirs(att_dir, exist_ok=True)
    I.check(M.select(I.quoted(path), readonly=True), f"SELECT {path}")
    msgs = fetch_selected(M, limit, att_dir, f"{CACHE_URL}imap-{slug}-folder-att/")
    fname = cache_name(slug, path)
    write_json(os.path.join(CACHE_DIR, fname),
               {"account": name, "folder": path, "synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "messages": msgs})
    keep, prefix = set(), f"imap-{slug}-folder-"
    for snap in os.listdir(CACHE_DIR):
        if snap.startswith(prefix) and snap.endswith(".json"):
            try:
                for m in json.load(open(os.path.join(CACHE_DIR, snap))).get("messages", []):
                    keep.update(a["path"].rsplit("/", 1)[-1] for a in m.get("attachments", []) if a.get("path"))
            except Exception:
                pass
    for f in os.listdir(att_dir):
        if f not in keep:
            os.remove(os.path.join(att_dir, f))
    return {"folder": path, "file": fname, "count": len(msgs)}


def act(M, c, op, ids, source=None, mark_unread=False):
    inbox = c.get("mailbox", "INBOX")
    if op == "restore":
        if source not in ("archive", "trash"):
            raise ValueError(f"restore only from archive or trash, not {source!r}")
        folder = I.special_folder(M, c, source)
    else:
        folder = inbox
    dest = I.special_folder(M, c, op) if op in ("archive", "trash") else None
    I.check(M.select(I.quoted(folder)), f"SELECT {folder}")
    caps = I.caps_of(M)
    res = []
    for i in ids:
        uid = find_uid(M, i)
        if not uid:
            res.append({"id": i, "ok": False, "error": f"not in {folder}"})
            continue
        if op == "read":
            I.check(M.uid("STORE", uid, "+FLAGS.SILENT", "(\\Seen)"), "STORE +Seen")
        elif op == "unread":
            I.check(M.uid("STORE", uid, "-FLAGS.SILENT", "(\\Seen)"), "STORE -Seen")
        elif op == "archive":
            I.check(M.uid("STORE", uid, "+FLAGS.SILENT", "(\\Seen)"), "STORE +Seen")
            I.move(M, caps, uid, dest)
        elif op == "trash":
            I.move(M, caps, uid, dest)
        elif op == "restore":
            I.move(M, caps, uid, inbox)
        res.append({"id": i, "ok": True})
    if op == "restore" and mark_unread:
        I.check(M.select(I.quoted(inbox)), f"SELECT {inbox}")
        for r in res:
            uid = r["ok"] and find_uid(M, r["id"])
            if uid:
                M.uid("STORE", uid, "-FLAGS.SILENT", "(\\Seen)")
    return res


def from_name(name):
    """The display name on outgoing mail: the account's `from_name` in Inbox's settings, else `display_name`."""
    try:
        s = json.load(open(SETTINGS, encoding="utf-8"))
    except Exception:
        return ""
    return ((s.get("accounts") or {}).get(name) or {}).get("from_name") or s.get("display_name") or ""


def send(M, c, block, name, p):
    if not (p.get("to") or "").strip():
        raise ValueError("no recipient")
    address = block["address"]
    msg = EmailMessage()
    sender = from_name(name)
    msg["From"] = formataddr((sender, address)) if sender else address
    msg["To"] = p["to"]
    if (p.get("cc") or "").strip():
        msg["Cc"] = p["cc"]
    msg["Subject"] = p.get("subject") or ""
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=address.split("@", 1)[1])
    if p.get("in_reply_to"):
        msg["In-Reply-To"] = p["in_reply_to"]
    if p.get("references"):
        msg["References"] = p["references"]
    msg.set_content(p.get("body") or "")
    # No smtp_host: most providers serve SMTP at smtp.<domain> beside imap.<domain>, or on the IMAP host itself.
    host = c.get("smtp_host") or re.sub(r"^imap\.", "smtp.", c["host"])
    port = int(c.get("smtp_port", 465))
    if port == 465:
        s = smtplib.SMTP_SSL(host, port, timeout=40)
    else:  # 587 and friends: STARTTLS, never a plaintext login
        s = smtplib.SMTP(host, port, timeout=40)
        s.starttls()
    with s:
        s.login(c["username"], I.password(c))
        s.send_message(msg)
    out = {"message_id": msg["Message-ID"]}
    sent = I.special_folder(M, c, "sent")
    try:
        I.check(M.append(I.quoted(sent), "(\\Seen)", imaplib.Time2Internaldate(time.time()), msg.as_bytes()), f"APPEND {sent}")
    except Exception as e:  # the mail is out either way; say so rather than fail
        out["warning"] = f"sent, but not copied to {sent}: {e}"
    if p.get("in_reply_to"):
        try:
            M.select(I.quoted(c.get("mailbox", "INBOX")))
            uid = find_uid(M, p["in_reply_to"])
            if uid:
                M.uid("STORE", uid, "+FLAGS.SILENT", "(\\Answered)")
        except Exception:
            pass
    return out


def handle(name, op, p):
    out = {"request_id": p.get("request_id"), "account": name, "op": op, "ids": p.get("ids") or []}
    try:
        M, c, block = I.connect(name)
    except KeyError as e:
        out.update(ok=False, error=f"credential {e} is not available to this process: check `credential_env` in the account's imap block, or re-run configure_email")
        return out
    except ValueError as e:  # not an IMAP account, or its imap block is incomplete
        out.update(ok=False, error=str(e))
        return out
    except Exception as e:
        out.update(ok=False, error=f"login failed: {e}")
        return out
    try:
        if op in WRITE_OPS:
            out["results"] = act(M, c, op, out["ids"], p.get("from_folder"), bool(p.get("mark_unread")))
            out["ok"] = bool(out["results"]) and all(r["ok"] for r in out["results"])
            if not out["ok"]:
                out["error"] = "; ".join(f"{r['id']}: {r.get('error')}" for r in out["results"] if not r["ok"]) or "no ids"
        elif op == "send":
            out.update(send(M, c, block, name, p))
            out["ok"] = True
        elif op == "folders":
            out["folders"] = list_folders(M, slug_for(name))
            out["ok"] = True
        elif op == "folder":
            out.update(fetch_folder(M, name, p))
            out["ok"] = True
        elif op == "sync":
            out["ok"] = True
        else:
            out.update(ok=False, error=f"unknown op {op!r}")
        if op not in FOLDER_OPS:  # browsing a folder changes nothing, so INBOX needs no fresh snapshot
            try:
                out["count"], out["synced"] = sync(M, c, name), True
            except Exception as e:
                out["sync_error"] = str(e)[:200]
                if op == "sync":
                    out.update(ok=False, error=f"sync failed: {e}")
    except Exception as e:
        out.update(ok=False, error=str(e)[:300])
    finally:
        try:
            M.logout()
        except Exception:
            pass
    return out


def main():
    raw = json.loads(os.environ.get("TRIGGER_EVENT_PAYLOAD") or "{}")
    ours = any(k in raw for k in ("op", "request_id", "account", "account_results"))
    p = raw if ours or not isinstance(raw.get("payload"), dict) else raw["payload"]
    etype = os.environ.get("TRIGGER_EVENT_TYPE") or ""
    op = p.get("op") or ("sync" if etype in ("InboxImapSyncRequested", "EmailTriageCompleted") else "")
    # The trigger only fires actions for a device (the Inbox app); refuse here too, so a bridge trigger registered
    # without that condition still won't move or send mail for an agent or script. `actor` is the engine's, never
    # the emitter's. A payload with no actor at all is left to the trigger's condition.
    kind = (p.get("actor") or {}).get("kind")
    if op in WRITE_OPS | {"send"} and kind and kind != "device":
        emit({"request_id": p.get("request_id"), "account": p.get("account"), "op": op, "ok": False,
              "error": f"refused: only the Inbox app can ask the bridge to change or send mail, not a {kind} emit"})
        return
    ensure_cache()
    served = I.imap_accounts()
    if etype == "EmailTriageCompleted":
        # Fires on every triage run; only an IMAP account's run needs a resync, and the rest exit silently.
        targets = [n for n in (p.get("account_results") or {}) if n in served]
    elif p.get("account"):
        targets = [p["account"]]
    elif op == "sync":
        targets = served
    else:
        emit({"request_id": p.get("request_id"), "op": op, "ok": False, "error": "the request names no account"})
        return
    if not targets or not first_time(p.get("request_id")):
        return
    for name in targets:
        emit(handle(name, op, p))


if __name__ == "__main__":
    main()
