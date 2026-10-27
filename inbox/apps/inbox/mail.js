/* Inbox data layer.
 * Accounts are triage's, read from artifacts/email-triage/config.json in its order, with per-account
 * overrides from artifacts/inbox/settings.json (knowhow/inbox.md has the schema).
 * A Gmail account ("fetch": "gmail-api") goes through the engine proxy its settings name, and every list first
 * checks /profile so a token mix-up can never act on the wrong inbox.
 * A password IMAP account ("fetch": "imap") has no API: the app emits InboxImap*Requested, the "Inbox — IMAP
 * bridge" script trigger answers InboxImapResult and rewrites artifacts/inbox/cache/imap-<slug>.json.
 * Folders and labels are browsed on demand, never triaged: see knowhow/folders.md. */
(function () {
  'use strict';

  const CONFIG = 'artifacts/email-triage/config.json', SETTINGS = 'artifacts/inbox/settings.json', CACHE = 'artifacts/inbox/cache/';
  /* How many account colours index.html defines, picked by the account's position in config order. */
  const COLOURS = 5;
  /* key -> account, and the keys in config order. Filled in place by useAccounts, so app.js can hold on to them. */
  const ACCOUNTS = {};
  const ORDER = [];
  const KEEP = new Set(['read', 'flag', 'todo', 'notify']);
  const ZW = /[\u034f\u00ad\u180e\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff]/g;

  async function readJson(path, fallback) {
    try { return JSON.parse(await lucidos.data.read(path)); } catch (e) { return fallback; }
  }

  /* ---------- accounts ---------- */
  /* Triage's sidecar slug: lowercased and hyphenated, with only a "Gmail - " prefix dropped. */
  const slugFor = name => String(name).replace(/^Gmail\s*-\s*/i, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const shortName = name => String(name).replace(/^Gmail\s*-\s*/i, '');

  function kindOf(name, b) {
    if (b.fetch === 'gmail-api') return 'gmail';
    if (b.fetch === 'imap') return 'imap';
    /* Older configs carry no `fetch`; a Gmail one still reads over the API. */
    if (!b.fetch && (/^gmail\b/i.test(name) || /@(gmail|googlemail)\.com$/i.test(b.address || ''))) return 'gmail';
    return 'none';
  }

  /* One serialisable record per account, so a cached list can paint before the config is read again. */
  function buildAccounts(config, settings) {
    const blocks = (config && config.accounts) || {};
    const over = (settings && settings.accounts) || {};
    const out = [], used = new Set();
    Object.keys(blocks).forEach((name, i) => {
      const b = blocks[name] || {}, o = over[name] || {};
      if (typeof b !== 'object') return;
      let key = slugFor(name) || 'account';
      while (used.has(key)) key += '-' + i;
      used.add(key);
      const kind = kindOf(name, b);
      let problem = null;
      if (kind === 'none') problem = `Inbox can't read ${b.fetch ? `"${b.fetch}"` : 'this kind of'} account yet, only Gmail ("gmail-api") and password IMAP ("imap")`;
      else if (kind === 'gmail' && !o.proxy) problem = `No Gmail proxy is recorded for this account. Run the Inbox setup, or set accounts["${name}"].proxy in ${SETTINGS}`;
      out.push({
        key, cfg: name, slug: slugFor(name), label: o.label || shortName(name), slot: String(i % COLOURS), kind,
        address: String(b.address || '').toLowerCase(), proxy: o.proxy || null, fromName: o.from_name || (settings && settings.display_name) || '',
        problem,
      });
    });
    return out;
  }

  function useAccounts(list) {
    for (const k of Object.keys(ACCOUNTS)) delete ACCOUNTS[k];
    ORDER.length = 0;
    for (const a of list || []) { ACCOUNTS[a.key] = a; ORDER.push(a.key); }
  }
  const snapshot = () => ORDER.map(k => ACCOUNTS[k]);
  const keyOf = cfgName => ORDER.find(k => ACCOUNTS[k].cfg === cfgName) || null;

  /* Reply voice for one account: its own settings, falling back to the global ones. */
  function voiceOf(acc, settings) {
    const s = settings || {}, o = ((s.accounts || {})[(ACCOUNTS[acc] || {}).cfg]) || {};
    return { voice: o.voice || s.voice || '', signature: o.signature || '', fromName: (ACCOUNTS[acc] || {}).fromName || '' };
  }

  async function gmail(acc, path, init) {
    const a = ACCOUNTS[acc];
    if (!a || !a.proxy) throw new Error(`${a ? a.label : acc}: no Gmail proxy configured`);
    const res = await lucidos.proxy(a.proxy).fetch('/gmail/v1/users/me' + path, init);
    const txt = await res.text();
    let body = null;
    try { body = txt ? JSON.parse(txt) : null; } catch (e) { /* non-JSON error page */ }
    if (!res.ok) throw new Error(`${a.label}: ${(body && body.error && body.error.message) || 'HTTP ' + res.status}`);
    return body;
  }
  const post = (acc, path, body) => gmail(acc, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; try { out[i] = await fn(items[i]); } catch (e) { out[i] = { _error: e }; } } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
  }

  /* ---------- text, addresses, bytes ---------- */
  function clean(s) {
    if (!s) return '';
    const t = new DOMParser().parseFromString(String(s), 'text/html').documentElement.textContent || '';
    return t.replace(ZW, '').replace(/\s+/g, ' ').trim();
  }
  function htmlText(html) {
    const d = new DOMParser().parseFromString(html || '', 'text/html');
    d.querySelectorAll('style,script,title,.gmail_quote,.yahoo_quoted,blockquote').forEach(n => n.remove());
    d.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
    d.querySelectorAll('p,div,tr,li,h1,h2,h3,h4').forEach(n => n.append('\n'));
    return (d.body ? d.body.textContent : '').replace(ZW, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function splitAddrs(s) {
    const out = [];
    let cur = '', quoted = false, angle = 0;
    for (const ch of String(s || '')) {
      if (ch === '"') quoted = !quoted;
      else if (ch === '<') angle++;
      else if (ch === '>') angle = Math.max(0, angle - 1);
      if (ch === ',' && !quoted && !angle) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function parseAddr(s) {
    s = String(s || '').trim();
    const m = s.match(/^(.*?)\s*<([^>]+)>\s*$/);
    if (m) return { name: m[1].replace(/^"+|"+$/g, '').trim(), addr: m[2].trim().toLowerCase() };
    return { name: '', addr: s.replace(/^"+|"+$/g, '').toLowerCase() };
  }
  const displayName = s => { const p = parseAddr(splitAddrs(s)[0] || s); return p.name || p.addr; };
  const ascii = s => /^[\x20-\x7e]*$/.test(s);
  function b64urlToBytes(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(b) {
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const utf8 = s => new TextEncoder().encode(s);
  const b64url = bytes => bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const charsetOf = ct => ((ct || '').match(/charset="?([^";\s]+)"?/i) || [])[1];
  function decodeText(data, charset) {
    const bytes = b64urlToBytes(data);
    try { return new TextDecoder(charset || 'utf-8').decode(bytes); } catch (e) { return new TextDecoder('utf-8').decode(bytes); }
  }
  const encWord = s => (ascii(s) ? s : `=?UTF-8?B?${bytesToB64(utf8(s))}?=`);
  const encAddrList = s => splitAddrs(s).map(a => {
    const p = parseAddr(a);
    if (!p.addr || !p.addr.includes('@')) return '';
    if (!p.name) return p.addr;
    return `${ascii(p.name) ? '"' + p.name.replace(/["\\]/g, '') + '"' : encWord(p.name)} <${p.addr}>`;
  }).filter(Boolean).join(', ');
  function headerMap(payload) {
    const h = {};
    for (const x of (payload && payload.headers) || []) { const k = x.name.toLowerCase(); if (!(k in h)) h[k] = x.value; }
    return h;
  }

  /* ---------- triage context: last run, reasons, rules ---------- */
  function indexReasons(kept, triage) {
    const m = new Map();
    const put = (e, text) => { const r = { text: text || '', action: e.action, from: e.from || '' }; if (e.id) m.set(String(e.id), r); if (e.thread_id) m.set(String(e.thread_id), r); };
    for (const e of (triage && triage.emails) || []) put(e, e.summary);
    for (const e of (kept && kept.kept) || []) put(e, e.reason);
    return m;
  }

  /* Which cron trigger is whose: punctuation-blind, cron triggers only (the on-demand one serves every account), and
   * never a trigger naming a longer account name that contains this one. Matching on "triage" finds both setup's
   * `Inbox triage — <Account>` and the `Email Triage — <Account>` it named crons before 1.0.0. The triage pane
   * pauses and resumes what this finds. */
  const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function triggerFor(name, triggers, names) {
    const short = words(shortName(name));
    const longer = names.map(n => words(shortName(n))).filter(s => s !== short && s.includes(short));
    return (triggers || []).find(t => {
      const n = words(t.name);
      return n.includes('triage') && (t.cron_expressions || []).length && n.includes(short) && !longer.some(s => n.includes(s));
    });
  }

  /* What one account's config block and cron trigger say about it. loadContext uses it, and so does the triage
   * pane after it writes config.json, so an edited rule chain reaches classify() without a reload. */
  function configCtx(acc, config, triggers) {
    const a = ACCOUNTS[acc];
    const trig = triggerFor(a.cfg, triggers, ORDER.map(k => ACCOUNTS[k].cfg));
    const cfg = ((config && config.accounts) || {})[a.cfg] || {};
    return {
      nextRun: trig && !trig.paused && trig.next_run ? Date.parse(trig.next_run) : null,
      paused: !!(cfg.paused || (trig && trig.paused)),
      /* Shared accounts fetch a date window instead of the unread set, so read state doesn't decide what triage sees. */
      windowed: !!(cfg.shared || cfg.fetch_scope === 'window'),
      rules: cfg.rules || [],
    };
  }

  /* Reads the config and settings, refreshes ACCOUNTS / ORDER, then everything triage left behind per account.
   * `kept-<slug>.json` (why triage left each mail in the inbox) is optional: without it a kept row shows the
   * triage snapshot's summary, or a generic reason. */
  async function loadContext() {
    const [config, settings, events, triggers] = await Promise.all([
      readJson(CONFIG, { accounts: {} }),
      readJson(SETTINGS, {}),
      lucidos.events.query({ event_type: 'EmailTriageCompleted', limit: 100 }).catch(() => []),
      lucidos.triggers.list().catch(() => []),
    ]);
    useAccounts(buildAccounts(config, settings || {}));
    const per = {};
    await Promise.all(ORDER.map(async acc => {
      const a = ACCOUNTS[acc];
      const [state, triage, notified, kept] = await Promise.all(['state', 'triage', 'notified', 'kept'].map(k => readJson(`artifacts/email-triage/${k}-${a.slug}.json`, {})));
      const ev = (events || []).find(e => e.payload && e.payload.account_results && e.payload.account_results[a.cfg]);
      const times = [state.last_run, triage.triaged_at, ev && ev.created].filter(Boolean).map(t => Date.parse(t)).filter(n => !isNaN(n));
      per[acc] = Object.assign({
        lastRun: times.length ? Math.max(...times) : null,
      }, configCtx(acc, config, triggers), {
        reasons: indexReasons(kept, triage),
        notified: new Set(((notified && notified.notified) || []).map(n => String(n.id))),
        processed: new Set(((state && state.processed) || []).flatMap(p => [p.id, p.uid]).filter(x => x != null).map(String)),
      });
    }));
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    let cleared = 0;
    for (const e of events || []) {
      if (Date.parse(e.created) < midnight.getTime()) continue;
      for (const r of Object.values((e.payload && e.payload.account_results) || {})) cleared += (r.fyi || 0) + (r.noise || 0);
    }
    return { full: true, per, settings: settings || {}, clearedToday: cleared, configured: ORDER.length > 0 };
  }

  function matchRule(rules, input) {
    for (const r of rules || []) {
      const c = r.condition || {};
      if (c.field === 'body') return null; // the list has no bodies: stop rather than guess past it
      const v = String(input[c.field] || '');
      let ok = false;
      try {
        if (c.operator === 'contains') ok = v.toLowerCase().includes(String(c.value).toLowerCase());
        else if (c.operator === 'equals') ok = v.trim().toLowerCase() === String(c.value).trim().toLowerCase();
        else if (c.operator === 'regex') {
          let src = String(c.value), flags = '';
          if (src.startsWith('(?i)')) { src = src.slice(4); flags = 'i'; }
          ok = new RegExp(src, flags).test(v);
        }
      } catch (e) { ok = false; }
      if (ok) return r;
    }
    return null;
  }
  const VERB = { delete: 'delete it', read: 'mark it read and keep it', flag: 'flag it', todo: 'make it a reminder', notify: 'push it to you', skip: 'leave it alone' };
  function ruleText(r, kept) {
    const c = r.condition || {};
    let v = String(c.value || '').replace(/^\(\?i\)/, '');
    if (v.length > 38) v = v.slice(0, 37) + '…';
    const what = `${c.field} ${c.operator === 'regex' ? 'matches' : c.operator} “${v}”`;
    if (r.action === 'triage') return kept ? 'Kept by triage' : 'AI triage will decide';
    return kept ? `Kept by a rule (${r.action}): ${what}` : `Your rules would ${VERB[r.action] || r.action} (${what})`;
  }

  /* Needs you (survived triage) vs Not triaged yet, from the newest message still in the inbox. */
  function classify(t, ctx) {
    const c = (ctx && ctx.per && ctx.per[t.account]) || {};
    const reasons = c.reasons || new Map(), notified = c.notified || new Set();
    const after = c.lastRun == null || t.inboxDate > c.lastRun;
    const direct = reasons.get(String(t.lastInboxId));
    const hit = direct || (!after && [t.threadId].concat(t.msgIds).map(id => reasons.get(String(id))).find(Boolean));
    const rule = matchRule(c.rules, t.ruleInput);
    const out = Object.assign({}, t, { zone: 'kept', why: '', hint: '' });
    /* A sender with no display name (Apple's private relay, for one) borrows the name triage wrote down for it. */
    const named = hit && hit.from && t.from === t.fromAddr && parseAddr(hit.from).name;
    if (named) out.from = named;
    if (hit && hit.text) { out.why = hit.text; return out; }
    if (notified.has(String(t.lastInboxId)) || (!after && t.msgIds.some(id => notified.has(String(id))))) { out.why = 'Triage flagged it and notified you'; return out; }
    if (hit) { out.why = 'Kept by triage'; return out; }
    if (!after) {
      if (!c.windowed && !t.unread && !(rule && KEEP.has(rule.action))) {
        return Object.assign(out, { zone: 'new', why: 'Read before triage saw it — triage only checks unread mail', hint: rule ? ruleText(rule, false) : "triage won't revisit it" });
      }
      if (rule && rule.action === 'delete') return Object.assign(out, { zone: 'new', why: 'Triage missed this one', hint: ruleText(rule, false) });
      /* Windowed accounts record every message they triage in state.processed, pruned at 30 days. Inside that
       * window, a message missing from it was never triaged, however old the last run is. */
      if (c.windowed && c.processed && c.processed.size && Date.now() - t.inboxDate < 28 * 864e5 &&
          !t.msgIds.some(id => c.processed.has(String(id)))) {
        return Object.assign(out, { zone: 'new', why: "Triage hasn't looked at this one yet", hint: c.paused ? 'triage is paused for this account' : (rule ? ruleText(rule, false) : 'AI triage will decide') });
      }
      out.why = rule && KEEP.has(rule.action) ? ruleText(rule, true) : (c.windowed ? 'Kept by triage' : 'Left unread by triage');
      return out;
    }
    return Object.assign(out, { zone: 'new', why: '', hint: c.paused ? 'triage is paused for this account' : (rule ? ruleText(rule, false) : 'AI triage will decide') });
  }

  /* ---------- lists ---------- */
  /* A thread's historyId moves on every new message and every label change, so an unchanged id means the
   * metadata we already have is still exact: a refresh then costs one list call per account, not one per thread. */
  const metaCache = new Map();
  const META_Q = ['From', 'To', 'Cc', 'Subject', 'Reply-To'].map(h => 'metadataHeaders=' + h).join('&');
  async function threadMeta(acc, ref) {
    const ck = acc + ':' + ref.id, hit = metaCache.get(ck);
    if (hit && hit.historyId === ref.historyId) return hit.norm;
    const t = await gmail(acc, `/threads/${ref.id}?format=metadata&${META_Q}`);
    if (!t || !t.messages || !t.messages.length) return null;
    const norm = normGmail(acc, t);
    metaCache.set(ck, { historyId: t.historyId || ref.historyId, norm });
    return norm;
  }
  /* The /profile check, remembered for a while so browsing folders doesn't pay for it on every click. */
  const verified = new Map();
  function checkProfile(acc, prof) {
    const a = ACCOUNTS[acc];
    if (String(prof.emailAddress || '').toLowerCase() !== a.address) throw new Error(`${a.label}: the "${a.proxy}" proxy reads ${prof.emailAddress}, not ${a.address}`);
    verified.set(acc, Date.now());
  }
  async function verify(acc) {
    if (Date.now() - (verified.get(acc) || 0) < 10 * 60e3) return;
    checkProfile(acc, await gmail(acc, '/profile'));
  }
  async function listGmail(acc) {
    const [prof, first] = await Promise.all([gmail(acc, '/profile'), gmail(acc, '/threads?labelIds=INBOX&maxResults=100')]);
    checkProfile(acc, prof);
    let refs = (first && first.threads) || [];
    if (first && first.nextPageToken) {
      const more = await gmail(acc, `/threads?labelIds=INBOX&maxResults=100&pageToken=${encodeURIComponent(first.nextPageToken)}`);
      refs = refs.concat((more && more.threads) || []);
    }
    const out = await pool(refs, 6, ref => threadMeta(acc, ref));
    return out.filter(t => t && !t._error);
  }

  function normGmail(acc, t) {
    const a = ACCOUNTS[acc];
    const msgs = t.messages.slice().sort((x, y) => +x.internalDate - +y.internalDate);
    const labels = m => m.labelIds || [];
    const inbox = msgs.filter(m => labels(m).includes('INBOX'));
    const lastIn = inbox[inbox.length - 1] || msgs[msgs.length - 1];
    const last = msgs[msgs.length - 1];
    const mine = m => labels(m).includes('SENT') || parseAddr(headerMap(m.payload).from).addr === a.address;
    const theirs = msgs.filter(m => !mine(m));
    const ref = theirs[theirs.length - 1] || lastIn;
    const h = headerMap(lastIn.payload), rh = headerMap(ref.payload);
    return {
      key: acc + ':' + t.id, account: acc, threadId: t.id,
      subject: clean(h.subject) || '(no subject)', from: displayName(rh.from), fromAddr: parseAddr(rh.from).addr,
      date: +last.internalDate, inboxDate: +lastIn.internalDate,
      unread: msgs.some(m => labels(m).includes('UNREAD')), count: msgs.length, snippet: clean(last.snippet),
      msgIds: msgs.map(m => m.id), inboxMsgIds: inbox.map(m => m.id), unreadIds: msgs.filter(m => labels(m).includes('UNREAD')).map(m => m.id),
      lastInboxId: lastIn.id, lastId: last.id, repliedByUs: msgs.length > 1 && mine(last),
      ruleInput: { from: h.from || '', to: h.to || '', cc: h.cc || '', subject: h.subject || '' },
    };
  }

  /* The bridge's last snapshot of one IMAP account's INBOX. */
  async function listImap(acc) {
    const snap = await readJson(`${CACHE}imap-${ACCOUNTS[acc].slug}.json`, null);
    if (!snap) return { syncedAt: null, threads: [] };
    return { syncedAt: snap.synced_at, threads: (snap.messages || []).map(m => normImap(acc, m)) };
  }
  function normImap(acc, m) {
    return {
      key: acc + ':' + m.id, account: acc, threadId: m.id,
      subject: m.subject || '(no subject)', from: displayName(m.from), fromAddr: parseAddr(m.from).addr,
      date: m.date, inboxDate: m.date, unread: !m.seen, count: 1, snippet: clean(m.snippet),
      msgIds: [m.id], inboxMsgIds: [m.id], unreadIds: m.seen ? [] : [m.id], lastInboxId: m.id, lastId: m.id,
      repliedByUs: !!m.answered, ruleInput: { from: m.from || '', to: m.to || '', cc: m.cc || '', subject: m.subject || '' },
      imap: m,
    };
  }

  /* ---------- folders and labels: browsed on demand, never triaged ---------- */
  /* Gmail system labels worth opening, in display order; `main` shows when the account's folders are expanded,
   * `more` waits behind a second disclosure. INBOX is the main view, and CHAT, UNREAD and the superstar labels
   * (YELLOW_STAR and friends) are hidden. `__all` is a virtual label: no labelIds, so All Mail minus spam and trash. */
  const GMAIL_SYS = [
    ['STARRED', 'Starred', 'main', 'star'], ['SENT', 'Sent', 'main', 'send'], ['__all', 'All mail', 'main', 'mail'],
    ['DRAFT', 'Drafts', 'more', 'draft'], ['IMPORTANT', 'Important', 'more', 'flag'],
    ['CATEGORY_PERSONAL', 'Primary', 'more', 'tag'], ['CATEGORY_UPDATES', 'Updates', 'more', 'tag'], ['CATEGORY_PROMOTIONS', 'Promotions', 'more', 'tag'],
    ['CATEGORY_SOCIAL', 'Social', 'more', 'tag'], ['CATEGORY_FORUMS', 'Forums', 'more', 'tag'],
    ['SPAM', 'Spam', 'more', 'spam'], ['TRASH', 'Trash', 'more', 'trash'],
  ];
  /* IMAP special-use folders (RFC 6154, or the name when the server sends no flag). */
  const IMAP_SPECIAL = { archive: ['main', 0, 'archive'], sent: ['main', 1, 'send'], drafts: ['more', 2, 'draft'], junk: ['more', 3, 'spam'], trash: ['more', 4, 'trash'] };
  const FOLDER_MAX = 30;

  /* One nesting level per path segment whose parent is listed in the same group, so "Clients/Acme" sits under "Clients". */
  function nest(items, sep) {
    const byGroup = {};
    for (const f of items) (byGroup[f.group] = byGroup[f.group] || new Set()).add(f.full);
    for (const f of items) {
      const parts = sep ? f.full.split(sep) : [f.full];
      let depth = 0;
      for (let i = 1; i < parts.length; i++) if (byGroup[f.group].has(parts.slice(0, i).join(sep))) depth = i;
      f.depth = depth;
      f.name = depth ? parts.slice(depth).join(sep) : f.full;
    }
    return items;
  }
  const byName = (x, y) => x.full.localeCompare(y.full, undefined, { sensitivity: 'base' });

  async function listFolders(acc) {
    if (ACCOUNTS[acc].kind === 'imap') {
      const p = await imap(acc, { op: 'folders' }, 90000);
      const rows = (p.folders || []).filter(f => f && f.path && f.path.toUpperCase() !== 'INBOX');
      const special = rows.filter(f => IMAP_SPECIAL[f.special]).sort((x, y) => IMAP_SPECIAL[x.special][1] - IMAP_SPECIAL[y.special][1]);
      const user = rows.filter(f => !IMAP_SPECIAL[f.special]);
      const mk = (f, group, icon) => ({ id: f.path, full: f.name || f.path, group, icon, path: f.path, cache: f.cache, unread: f.unseen || 0, total: f.messages });
      const users = nest(user.map(f => mk(f, 'main', 'folder')).sort(byName), (user[0] && user[0].delim) || '/');
      return special.filter(f => IMAP_SPECIAL[f.special][0] === 'main').map(f => mk(f, 'main', IMAP_SPECIAL[f.special][2]))
        .concat(users, special.filter(f => IMAP_SPECIAL[f.special][0] === 'more').map(f => mk(f, 'more', IMAP_SPECIAL[f.special][2])))
        .map(f => Object.assign(f, { name: f.name || f.full, depth: f.depth || 0 }));
    }
    await verify(acc);
    const labels = ((await gmail(acc, '/labels')) || {}).labels || [];
    const ids = new Set(labels.map(l => l.id));
    const sys = GMAIL_SYS.filter(([id]) => id === '__all' || ids.has(id)).map(([id, full, group, icon]) => ({ id, full, name: full, group, icon, depth: 0 }));
    const users = nest(labels.filter(l => l.type === 'user')
      .map(l => ({ id: l.id, full: l.name, group: l.labelListVisibility === 'labelHide' ? 'more' : 'main', icon: 'tag' })).sort(byName), '/');
    return sys.filter(f => f.group === 'main').concat(users.filter(f => f.group === 'main'), sys.filter(f => f.group === 'more'), users.filter(f => f.group === 'more'));
  }

  function imapFolderThreads(acc, snap, f) {
    return { syncedAt: snap.synced_at, threads: (snap.messages || []).map(m => Object.assign(normImap(acc, m), { key: `${acc}:${f.id}:${m.id}`, folder: f.id })) };
  }
  /* The bridge's last snapshot of an IMAP folder, if it has one, so a reopen paints before the server answers. */
  async function readImapFolder(acc, f) {
    const snap = f.cache && await readJson(CACHE + f.cache, null);
    return snap && snap.folder === f.path ? imapFolderThreads(acc, snap, f) : null;
  }
  /* The newest conversations in one folder or label -> {syncedAt, threads}. Rows carry `folder`, which the UI
   * reads to keep them out of the triage zones and to decide which actions make sense. */
  async function listFolder(acc, f) {
    if (ACCOUNTS[acc].kind === 'imap') {
      const p = await imap(acc, { op: 'folder', folder: f.path, limit: FOLDER_MAX }, 120000);
      const snap = await readJson(CACHE + (p.file || f.cache), null);
      if (!snap || snap.folder !== f.path) throw new Error('the IMAP bridge wrote no snapshot of ' + f.name);
      return imapFolderThreads(acc, snap, f);
    }
    await verify(acc);
    const label = f.id === '__all' ? '' : '&labelIds=' + encodeURIComponent(f.id);
    const spamTrash = f.id === 'SPAM' || f.id === 'TRASH' ? '&includeSpamTrash=true' : '';
    const d = await gmail(acc, `/threads?maxResults=${FOLDER_MAX}${label}${spamTrash}`);
    const out = await pool((d && d.threads) || [], 6, ref => threadMeta(acc, ref));
    return { syncedAt: new Date().toISOString(), threads: out.filter(t => t && !t._error).map(t => Object.assign({}, t, { folder: f.id })) };
  }

  /* ---------- actions (optimistic in the UI; these only talk to the server) ---------- */
  const isImap = t => (ACCOUNTS[t.account] || {}).kind === 'imap';
  function act(t, op) {
    if (isImap(t)) return imap(t.account, { op: { done: 'archive', delete: 'trash', read: 'read', unread: 'unread' }[op], ids: [t.threadId] });
    const th = `/threads/${t.threadId}`;
    if (op === 'done') return post(t.account, th + '/modify', { removeLabelIds: ['INBOX', 'UNREAD'] });
    if (op === 'delete') return post(t.account, th + '/trash');
    if (op === 'read') return post(t.account, th + '/modify', { removeLabelIds: ['UNREAD'] });
    if (op === 'unread') return post(t.account, `/messages/${t.lastInboxId}/modify`, { addLabelIds: ['UNREAD'] });
    return Promise.reject(new Error('unknown action ' + op));
  }
  async function undo(t, op) {
    if (isImap(t)) {
      if (op === 'done' || op === 'delete') return imap(t.account, { op: 'restore', ids: [t.threadId], from_folder: op === 'done' ? 'archive' : 'trash', mark_unread: t.unread });
      return act(t, op === 'read' ? 'unread' : 'read');
    }
    if (op === 'delete') await post(t.account, `/threads/${t.threadId}/untrash`);
    /* A thread opened from a label may never have been in the inbox: there is nothing to put back. */
    if ((op === 'done' || op === 'delete') && t.inboxMsgIds.length) await post(t.account, '/messages/batchModify', { ids: t.inboxMsgIds, addLabelIds: ['INBOX'] });
    if ((op === 'done' || op === 'read') && t.unreadIds.length) await post(t.account, '/messages/batchModify', { ids: t.unreadIds, addLabelIds: ['UNREAD'] });
    if (op === 'unread') await post(t.account, `/messages/${t.lastInboxId}/modify`, { removeLabelIds: ['UNREAD'] });
  }

  /* ---------- one conversation, in full ---------- */
  function walk(p, out) {
    const h = headerMap(p), ct = (p.mimeType || '').toLowerCase();
    if (p.parts && p.parts.length) { p.parts.forEach(c => walk(c, out)); return; }
    const disp = (h['content-disposition'] || '').toLowerCase();
    const cid = (h['content-id'] || '').replace(/[<>]/g, '').trim();
    const body = p.body || {};
    if (!p.filename && (ct === 'text/html' || ct === 'text/plain') && !disp.startsWith('attachment')) {
      const txt = body.data ? decodeText(body.data, charsetOf(h['content-type'])) : '';
      if (ct === 'text/html' && out.html == null) out.html = txt;
      else if (ct === 'text/plain' && out.text == null) out.text = txt;
      return;
    }
    if (cid && ct.startsWith('image/')) out.cids.push({ cid, type: ct, attachmentId: body.attachmentId, data: body.data });
    if (p.filename) out.attachments.push({ name: p.filename, type: ct, size: body.size || 0, attachmentId: body.attachmentId, data: body.data, inline: !!cid && !disp.startsWith('attachment') });
  }

  async function loadThread(t) {
    const a = ACCOUNTS[t.account];
    if (isImap(t)) {
      const m = t.imap;
      return { messages: [{ id: m.id, from: m.from, to: m.to, cc: m.cc, replyTo: m.reply_to, date: m.date, subject: m.subject, html: m.html, text: m.text, snippet: clean(m.snippet), attachments: m.attachments || [], cids: [], mine: parseAddr(m.from).addr === a.address, unread: !m.seen, messageId: m.message_id, references: m.references }] };
    }
    const d = await gmail(t.account, `/threads/${t.threadId}?format=full`);
    const messages = (d.messages || []).slice().sort((x, y) => +x.internalDate - +y.internalDate).map(m => {
      const h = headerMap(m.payload);
      const parts = { html: null, text: null, attachments: [], cids: [] };
      walk(m.payload || {}, parts);
      const labels = m.labelIds || [];
      return Object.assign(parts, {
        id: m.id, from: h.from || '', to: h.to || '', cc: h.cc || '', replyTo: h['reply-to'] || '', date: +m.internalDate, subject: h.subject || '',
        snippet: clean(m.snippet), mine: labels.includes('SENT') || parseAddr(h.from).addr === a.address, unread: labels.includes('UNREAD'),
        messageId: h['message-id'] || '', references: h.references || '',
      });
    });
    return { messages };
  }

  async function inlineImages(t, thread) {
    if (isImap(t)) return;
    for (const m of thread.messages) {
      if (!m.html || !/cid:/i.test(m.html)) continue;
      for (const c of m.cids.slice(0, 8)) {
        try {
          const data = c.data || (await gmail(t.account, `/messages/${m.id}/attachments/${c.attachmentId}`)).data;
          let std = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
          while (std.length % 4) std += '=';
          if (std) m.html = m.html.split('cid:' + c.cid).join(`data:${c.type};base64,${std}`);
        } catch (e) { /* leave the broken image */ }
      }
    }
  }

  async function attachmentUrl(t, msgId, att) {
    const data = att.data || (await gmail(t.account, `/messages/${msgId}/attachments/${att.attachmentId}`)).data;
    return URL.createObjectURL(new Blob([b64urlToBytes(data)], { type: att.type || 'application/octet-stream' }));
  }

  /* ---------- replies ---------- */
  function replyDraft(t, thread, all, settings) {
    const a = ACCOUNTS[t.account];
    const msgs = thread.messages;
    const theirs = msgs.filter(m => !m.mine);
    const ref = theirs[theirs.length - 1] || msgs[msgs.length - 1];
    const to = ref.mine ? ref.to : (ref.replyTo || ref.from);
    let cc = '';
    if (all) {
      const seen = new Set([a.address].concat(splitAddrs(to).map(x => parseAddr(x).addr)));
      cc = splitAddrs([ref.to, ref.cc].filter(Boolean).join(', ')).filter(x => {
        const p = parseAddr(x).addr;
        if (!p || seen.has(p)) return false;
        seen.add(p);
        return true;
      }).join(', ');
    }
    const subj = String(ref.subject || t.subject || '').trim();
    const voice = voiceOf(t.account, settings);
    return {
      to: to || '', cc, showCc: !!cc,
      subject: /^(re|sv|aw|ang)\s*:/i.test(subj) ? subj : 'Re: ' + subj,
      body: voice.signature ? '\n\n' + voice.signature : '',
      inReplyTo: ref.messageId || '', references: [ref.references, ref.messageId].filter(Boolean).join(' ').trim(),
    };
  }

  async function sendReply(t, d) {
    if (isImap(t)) {
      return imap(t.account, { op: 'send', to: d.to, cc: d.cc || '', subject: d.subject, body: d.body, in_reply_to: d.inReplyTo, references: d.references });
    }
    const a = ACCOUNTS[t.account];
    const head = [
      ['From', a.fromName ? `${encWord(a.fromName)} <${a.address}>` : a.address], ['To', encAddrList(d.to)], d.cc ? ['Cc', encAddrList(d.cc)] : null,
      ['Subject', encWord(d.subject)], d.inReplyTo ? ['In-Reply-To', d.inReplyTo] : null, d.references ? ['References', d.references] : null,
      ['MIME-Version', '1.0'], ['Content-Type', 'text/plain; charset=UTF-8'], ['Content-Transfer-Encoding', 'base64'],
    ].filter(Boolean);
    if (!head[1][1]) throw new Error('no valid recipient');
    const body = bytesToB64(utf8(d.body.replace(/\r?\n/g, '\r\n'))).replace(/.{76}/g, '$&\r\n');
    const raw = head.map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n' + body;
    return post(t.account, '/messages/send', { raw: b64url(utf8(raw)), threadId: t.threadId });
  }

  /* ---------- IMAP bridge ---------- */
  const waiting = new Map();
  const listeners = [];
  lucidos.sse.on('InboxImapResult', data => {
    const p = (data && data.payload) || data || {};
    const w = waiting.get(p.request_id);
    if (w) {
      waiting.delete(p.request_id);
      clearTimeout(w.timer);
      p.ok ? w.resolve(p) : w.reject(new Error(p.error || 'the IMAP bridge failed'));
    }
    listeners.forEach(fn => { try { fn(p); } catch (e) { /* listener bug */ } });
  });
  /* One request to the bridge for one account; no op means a resync of its INBOX. */
  function imap(acc, payload, timeoutMs) {
    const a = ACCOUNTS[acc];
    const id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('the IMAP bridge did not answer: is the "Inbox — IMAP bridge" trigger live?')); }, timeoutMs || 120000);
      waiting.set(id, { resolve, reject, timer });
      const type = payload.op ? 'InboxImapActionRequested' : 'InboxImapSyncRequested';
      lucidos.events.emit(type, Object.assign({ summary: `Inbox: ${payload.op || 'sync'} for ${a.label}`, request_id: id, account: a.cfg }, payload))
        .catch(e => { clearTimeout(timer); waiting.delete(id); reject(e); });
    });
  }

  /* ---------- AI, through one of the engine's built-in model proxies ----------
   * settings.ai = {provider, model}. With none set, try Anthropic then Vertex (both Claude), moving on only when
   * the engine answers 404, which is how a provider it has no credential for replies. */
  const AI_DEFAULT_MODEL = 'claude-sonnet-5-5';
  let aiWorking = null;
  async function aiCall(provider, model, system, user) {
    const json = { 'Content-Type': 'application/json' };
    let path, body, headers = json;
    if (provider === 'vertex') {
      path = `/publishers/anthropic/models/${model}:rawPredict`;
      body = { anthropic_version: 'vertex-2023-10-16', max_tokens: 1200, system, messages: [{ role: 'user', content: user }] };
    } else if (provider === 'anthropic') {
      path = '/messages';
      headers = Object.assign({ 'anthropic-version': '2023-06-01' }, json);
      body = { model, max_tokens: 1200, system, messages: [{ role: 'user', content: user }] };
    } else {
      path = '/chat/completions';  // openai, openrouter, xai, local: the OpenAI chat shape
      body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    }
    const res = await lucidos.proxy(provider).fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) { const e = new Error(`model call failed (${provider}, HTTP ${res.status})`); e.status = res.status; throw e; }
    const j = await res.json();
    if (j && j.choices) return String((((j.choices[0] || {}).message) || {}).content || '').trim();
    return ((j && j.content) || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  }
  async function ai(system, user, cfg) {
    const c = cfg || {};
    const chain = c.provider ? [c.provider] : aiWorking ? [aiWorking] : ['anthropic', 'vertex'];
    let last = null;
    for (const p of chain) {
      if (!c.model && !/^(anthropic|vertex)$/.test(p)) throw new Error(`set ai.model in ${SETTINGS} for the "${p}" provider`);
      try {
        const out = await aiCall(p, c.model || AI_DEFAULT_MODEL, system, user);
        aiWorking = p;
        return out;
      } catch (e) {
        last = e;
        if (e.status !== 404 || c.provider) break;
      }
    }
    throw new Error(last && last.status === 404 ? `no model provider answered: set ai.provider and ai.model in ${SETTINGS}` : (last ? last.message : 'model call failed'));
  }

  window.Mail = {
    ACCOUNTS, ORDER, useAccounts, snapshot, keyOf, voiceOf, loadContext, configCtx, triggerFor, classify, listGmail, listImap, listFolders, listFolder, readImapFolder,
    act, undo, loadThread, inlineImages, attachmentUrl, replyDraft, sendReply, imap, onImap: fn => listeners.push(fn), ai, clean, htmlText,
    parseAddr, displayName,
  };
})();
