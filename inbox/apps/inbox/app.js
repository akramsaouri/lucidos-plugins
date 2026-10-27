/* Inbox UI: a mailbox sidebar, one list in two zones (Needs you / Not triaged yet), a reader, and a reply composer.
 * Folders and labels open from the sidebar into the same list, outside the triage zones. */
(function () {
  'use strict';
  const M = window.Mail;
  const A = M.ACCOUNTS;
  const $ = id => document.getElementById(id);
  const esc = s => lucidos.utils.escapeHtml(String(s == null ? '' : s));
  const attr = s => lucidos.utils.escapeHtmlAttr(String(s == null ? '' : s));
  const listEl = $('list'), readerEl = $('reader');
  const KEYS = 'j/k move (next/previous email while reading) · ⏎ open · e archive · s summarize · # delete · r reply · R reply all · a ask Lucidos · z undo · / filter';
  const CACHE = 'inbox-cache-v2', DRAFTS = 'inbox-drafts-v1', OUTBOX = 'inbox-outbox-v1';
  const SETUP_PROMPT = 'Set up the Inbox app for me. Run the setup of the inbox plugin: set up triage for each mailbox I want, record a Gmail proxy for each Gmail account, check the IMAP bridge for each IMAP account, and ask me for my display name and reply voice.';
  const REMOTE = /<img[^>]+src\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:/i;
  const QUOTE_HTML = /class=["'][^"']*\b(gmail_quote|yahoo_quoted)\b|<blockquote[^>]*type=["']?cite/i;
  /* The mail document is third-party content designed for white paper, so it gets its own fixed palette. */
  const MAIL_CSS = 'html,body{margin:0;background:#fff;color:#1f1f1f}body{padding:16px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%!important}pre{white-space:pre-wrap}a{color:#1a5fd6}html,body{height:auto!important;min-height:0!important}';
  const HIDE_QUOTES = '.gmail_quote,.gmail_extra,.yahoo_quoted,blockquote[type=cite],#appendonsend,#divRplyFwdMsg,#divRplyFwdMsg~*{display:none!important}';
  /* Runs inside every mail frame, allowed by that frame's CSP nonce (DOMPurify has already removed the mail's own
   * scripts). The app frame has an opaque origin, so a mail frame is cross-origin to it whatever its sandbox says:
   * the parent can never reach in, so the frame reports its height, link clicks and shortcut keys by postMessage. */
  const FRAME_JS = `(function () {
    var tok = __TOK__, last = -1;
    function post(m) { m.inboxFrame = tok; try { parent.postMessage(m, '*'); } catch (e) {} }
    function fit() {
      var d = document.documentElement, b = document.body;
      var h = Math.ceil(Math.max(d.scrollHeight, b ? b.scrollHeight : 0));
      if (h !== last) { last = h; post({ h: h }); }
    }
    document.addEventListener('DOMContentLoaded', fit);
    window.addEventListener('load', fit);
    document.addEventListener('load', fit, true);
    if (window.ResizeObserver) new ResizeObserver(fit).observe(document.documentElement);
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      e.preventDefault();
      var href = a.getAttribute('href') || '';
      if (/^(https?:|mailto:)/i.test(href)) post({ open: href });
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') e.preventDefault();
      post({ key: e.key });
    });
  })();`;

  lucidos.ui.applyPreferences();
  lucidos.ui.watchPreferences();
  lucidos.sse.connect();

  const S = {
    threads: [], ctx: null, settings: {}, errors: {}, filter: null, q: '', sel: null, open: null, thread: null, threadErr: null,
    hidden: new Map(), undo: [], drafts: {}, outbox: {}, composer: null, busy: null, images: new Set(), quoted: new Set(), expanded: new Map(),
    loading: false, loadedAt: 0, imapSyncedAt: {}, configured: true,
    /* Folders are browsed on demand: `view` is the open one (null = the account's inbox), `mbx` the phone's
     * mailbox screen. Lists and contents are cached briefly per account and per folder. */
    view: null, mbx: false, folderLists: new Map(), folderData: new Map(), foldersOpen: new Set(), moreOpen: new Set(), listScroll: 0,
    /* Threads archived from a folder view: hidden from the inbox, still listed in their folder. */
    keepInFolder: new Set(),
    /* The triage pane in the list's place: 'all', an account, or null. triage.js draws it. */
    triage: null,
  };
  const FOLDERS_TTL = 10 * 60e3, FOLDER_TTL = 2 * 60e3;

  /* ---------- formatting ---------- */
  const fmtTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
  const fmtDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
  const fmtFull = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  function when(ms) {
    if (!ms) return '';
    const d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString()) return fmtTime.format(d);
    return now - d < 6 * 864e5 ? fmtDay.format(d) : fmtDate.format(d);
  }
  function ago(ms) {
    if (!ms) return 'never';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago';
  }
  const size = n => (!n ? '' : n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  /* Lucide-style 24px stroke icons, drawn in currentColor. */
  const ICONS = {
    archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    reply: '<path d="M9 17l-5-5 5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    replyAll: '<path d="M7 17l-5-5 5-5"/><path d="M12 17l-5-5 5-5"/><path d="M22 18v-2a4 4 0 0 0-4-4H7"/>',
    summary: '<path d="M15 18H3"/><path d="M17 6H3"/><path d="M21 12H3"/>',
    ask: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15v4"/><path d="M17 17h4"/>',
    wand: '<path d="m3 21 9-9"/><path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8 19 13"/><path d="M17.8 6.2 19 5"/><path d="M12.2 6.2 11 5"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    cc: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    tag: '<path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1"/>',
    star: '<path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.3l-5.8 3.1 1.1-6.5L2.6 9.3l6.5-.9z"/>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    draft: '<path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M13.4 15.6a1 1 0 1 0-3-3l-5 5a2 2 0 0 0-.5.85l-.84 2.87a.5.5 0 0 0 .62.62l2.87-.84a2 2 0 0 0 .85-.5z"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
    spam: '<path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.31 2a2 2 0 0 1 1.42.59l4.68 4.68A2 2 0 0 1 22 8.69v6.62a2 2 0 0 1-.59 1.42l-4.68 4.68a2 2 0 0 1-1.42.59H8.69a2 2 0 0 1-1.42-.59l-4.68-4.68A2 2 0 0 1 2 15.31V8.69a2 2 0 0 1 .59-1.42l4.68-4.68A2 2 0 0 1 8.69 2z"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    chevL: '<path d="m15 18-6-6 6-6"/>',
    chevD: '<path d="m6 9 6 6 6-6"/>',
  };
  const ic = n => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
  const wide = () => matchMedia('(min-width: 56rem)').matches;
  const three = () => matchMedia('(min-width: 72rem)').matches;
  const initial = s => { const m = String(s || '').match(/[\p{L}\p{N}]/u); return m ? m[0].toUpperCase() : '•'; };
  const viewKey = () => S.view && S.view.account + '|' + S.view.id;
  const folderNow = () => (S.view && S.folderData.get(viewKey())) || null;
  const folderThreads = () => { const f = folderNow(); return (f && f.threads) || []; };
  const anyFolderThreads = () => [].concat(...[...S.folderData.values()].map(f => f.threads || []));
  /* The open folder's copy first: a Gmail thread can sit in a label and the inbox under the same key. */
  const byKey = k => (S.view && folderThreads().find(t => t.key === k)) || S.threads.find(t => t.key === k) || anyFolderThreads().find(t => t.key === k);
  const isImap = t => (A[t.account] || {}).kind === 'imap';
  /* The colour slot an account wears (index.html's --acct-0 … --acct-4), shared with the triage pane and the Home widget. */
  const slot = acc => (A[acc] || {}).slot || '';
  /* One mailbox is always picked: an account, or 'all' (every account merged, offered once there are two). The
   * pick survives a reopen; one that no longer exists falls back to the first account. */
  const PICK = 'inbox.filter';
  const hasAll = () => M.ORDER.length > 1;
  const isAll = () => S.filter === 'all' && hasAll();
  const ensureFilter = () => { if (!A[S.filter] && !isAll()) S.filter = M.ORDER[0] || null; };
  function pick(f) {
    S.filter = f;
    try { lucidos.storage.local.setItem(PICK, f); } catch (e) { /* quota */ }
  }
  const folderName = t => { const l = S.folderLists.get(t.account), f = l && l.items && l.items.find(x => x.id === t.folder); return f ? f.name : t.folder; };
  /* Folder rows only offer what means something there: IMAP folders are read-only (the bridge writes to INBOX
   * only), archiving needs the thread to still be in the inbox, and deleting from Trash would only bounce it. */
  function canAct(t, op) {
    if (!t.folder) return true;
    if (isImap(t)) return false;
    if (op === 'done') return t.inboxMsgIds.length > 0;
    if (op === 'delete') return t.folder !== 'TRASH';
    return true;
  }
  const undoSecs = () => { const n = Number(S.settings.undo_send_seconds); return Number.isFinite(n) && n >= 0 ? n : 8; };

  /* ---------- loading ---------- */
  function liteCtx() {
    const per = {};
    for (const a of M.ORDER) { const c = (S.ctx && S.ctx.per && S.ctx.per[a]) || {}; per[a] = { lastRun: c.lastRun, nextRun: c.nextRun, paused: c.paused, windowed: c.windowed }; }
    return { per, clearedToday: S.ctx && S.ctx.clearedToday, settings: S.settings };
  }
  function saveCache() {
    try {
      const threads = S.threads.map(t => Object.assign({}, t, t.imap ? { imap: Object.assign({}, t.imap, { html: null, text: null }) } : {}));
      lucidos.storage.local.setItem(CACHE, JSON.stringify({ at: S.loadedAt, threads, ctx: liteCtx(), imapSyncedAt: S.imapSyncedAt, accounts: M.snapshot() }));
    } catch (e) { /* over quota: the next open just loads live */ }
  }
  /* A reply waiting out its undo window is persisted here, not held in a timer alone: if the Inbox closes before
   * the reply goes out, the next open hands it back as a draft instead of losing it. */
  function persistOutbox() {
    try { lucidos.storage.local.setItem(OUTBOX, JSON.stringify(S.outbox)); } catch (e) { /* quota */ }
  }
  let dT = null;
  function persistDrafts(now) {
    clearTimeout(dT);
    const write = () => { try { lucidos.storage.local.setItem(DRAFTS, JSON.stringify(S.drafts)); } catch (e) { /* quota */ } };
    if (now) write(); else dT = setTimeout(write, 400);
  }

  async function load() {
    if (S.loading) return;
    S.loading = true;
    renderFresh();
    try {
      const ctx = await M.loadContext();
      S.ctx = ctx;
      S.settings = ctx.settings || {};
      S.configured = ctx.configured;
      ensureFilter();
      /* An account Inbox can't read (no proxy recorded, an unsupported fetch mode) fails like a load error:
       * a red dot in the sidebar and the reason in its empty list, never a silently empty inbox. */
      const accs = M.ORDER.slice();
      const res = await Promise.allSettled(accs.map(k => A[k].problem ? Promise.reject(new Error(A[k].problem))
        : A[k].kind === 'imap' ? M.listImap(k) : M.listGmail(k)));
      const threads = [], errors = {};
      res.forEach((r, i) => {
        const acc = accs[i];
        if (r.status === 'fulfilled') {
          if (A[acc].kind === 'imap') { S.imapSyncedAt[acc] = r.value.syncedAt; threads.push(...r.value.threads); } else threads.push(...r.value);
        } else {
          errors[acc] = (r.reason && r.reason.message) || String(r.reason);
          threads.push(...S.threads.filter(t => t.account === acc));
        }
      });
      S.errors = errors;
      S.threads = threads.map(t => M.classify(t, ctx)).sort((a, b) => b.date - a.date);
      const keys = new Set(S.threads.map(t => t.key).concat(anyFolderThreads().map(t => t.key)));
      for (const [k, until] of [...S.hidden]) if (!keys.has(k) || until < Date.now()) S.hidden.delete(k);
      for (const k of [...S.keepInFolder]) if (!S.hidden.has(k)) S.keepInFolder.delete(k);
      S.loadedAt = Date.now();
      saveCache();
      if (S.open && !keys.has(S.open)) closeReader(true);
    } catch (e) {
      lucidos.ui.toast('Could not load the inbox: ' + e.message, 'error');
    } finally {
      S.loading = false;
      render();
      lucidos.ui.ready();
    }
  }

  /* Ask the bridge to resync IMAP accounts: every one, or only those whose snapshot is older than `staleMs`. */
  const imapSyncing = new Set(), imapT = {};
  function requestImapSync(staleMs) {
    for (const k of M.ORDER) {
      const a = A[k], at = Date.parse(S.imapSyncedAt[k] || '') || 0;
      if (a.kind !== 'imap' || a.problem || imapSyncing.has(k) || (staleMs && Date.now() - at < staleMs)) continue;
      imapSyncing.add(k);
      M.imap(k, {}).catch(e => { S.errors[k] = e.message; renderSide(); renderFresh(); }).finally(() => { imapSyncing.delete(k); });
    }
  }
  M.onImap(p => {
    const acc = p.synced && M.keyOf(p.account);
    if (!acc) return;
    clearTimeout(imapT[acc]);
    imapT[acc] = setTimeout(async () => {
      if (!S.ctx || !S.ctx.full) { load(); return; }
      try {
        const r = await M.listImap(acc);
        S.imapSyncedAt[acc] = r.syncedAt;
        delete S.errors[acc];
        S.threads = S.threads.filter(t => t.account !== acc).concat(r.threads.map(t => M.classify(t, S.ctx))).sort((a, b) => b.date - a.date);
        saveCache();
        render();
      } catch (e) { /* keep what we have */ }
    }, 400);
  });

  /* ---------- folders ---------- */
  async function loadFolders(acc, force) {
    const c = S.folderLists.get(acc);
    if (c && c.loading) return;
    if (!force && c && c.items && Date.now() - c.at < FOLDERS_TTL) return;
    S.folderLists.set(acc, Object.assign({}, c, { loading: true, err: null }));
    renderSide();
    try {
      S.folderLists.set(acc, { items: await M.listFolders(acc), at: Date.now() });
    } catch (e) {
      S.folderLists.set(acc, Object.assign({}, c, { loading: false, err: e.message }));
    }
    renderSide();
  }
  function toggleFolders(acc) {
    if (S.foldersOpen.has(acc)) S.foldersOpen.delete(acc);
    else { S.foldersOpen.add(acc); loadFolders(acc); }
    renderSide();
  }

  function openFolder(acc, id) {
    const l = S.folderLists.get(acc), f = l && l.items && l.items.find(x => x.id === id);
    if (!f) return;
    Object.assign(S, { view: { account: acc, id: f.id, name: f.name, folder: f }, filter: acc, sel: null, triage: null });
    closeMbx();
    render();
    toListTop();
    loadFolder();
  }
  /* ---------- triage pane ---------- */
  function openTriage(scope) {
    if (scope !== 'all' && !A[scope]) return;
    if (S.open) closeReader(true);
    Object.assign(S, { triage: scope, view: null, sel: null });
    closeMbx();
    render();
    const pane = $('triage');
    if (wide()) pane.scrollTop = 0; else window.scrollTo(0, 0);
  }
  function exitTriage() {
    if (!S.triage) return;
    S.triage = null;
    render();
    toListTop();
  }
  function renderTriage() {
    /* A config edit can drop the open account: fall back to the inbox rather than draw a pane for nothing. */
    if (S.triage && S.triage !== 'all' && !A[S.triage]) S.triage = null;
    document.body.classList.toggle('triage', !!S.triage);
    if (S.triage) Triage.render(S.triage, { tap: !three() });
  }
  /* triage.js wrote config.json (or reloaded it): put each account's rules, pause and window through the same
   * configCtx path loadContext uses, and re-run classify so reasons and hints follow without a reload. A context
   * from the cache has no reasons to classify with; the live load that follows it does. */
  function applyConfig(config, triggers) {
    if (!S.ctx || !S.ctx.full) return;
    for (const a of M.ORDER) S.ctx.per[a] = Object.assign(S.ctx.per[a] || {}, M.configCtx(a, config, triggers));
    S.threads = S.threads.map(t => M.classify(t, S.ctx));
    saveCache();
    /* An open reader keeps its why line until it is reopened: redrawing it would reload the mail frames. */
    renderList();
  }

  function exitFolder() {
    if (!S.view) return;
    Object.assign(S, { view: null, sel: null });
    render();
    toListTop();
  }
  /* Opens paint from the cache; a stale or missing entry refetches. An IMAP account also paints the bridge's last
   * snapshot while its server answers, since a bridge round trip takes a few seconds. */
  async function loadFolder(force) {
    const v = S.view;
    if (!v) return;
    const k = viewKey(), paint = () => { if (viewKey() === k) { renderHead(); renderList(); } };
    let c = S.folderData.get(k);
    if (c && c.loading) return;
    if (!force && c && c.threads && Date.now() - c.at < FOLDER_TTL) return;
    S.folderData.set(k, Object.assign({}, c, { loading: true, err: null }));
    paint();
    if (!c && (A[v.account] || {}).kind === 'imap') {
      const snap = await M.readImapFolder(v.account, v.folder).catch(() => null);
      if (snap) {
        c = { threads: snap.threads.sort((x, y) => y.date - x.date), at: Date.parse(snap.syncedAt) || 0, syncedAt: snap.syncedAt };
        const fresh = !force && Date.now() - c.at < FOLDER_TTL;
        S.folderData.set(k, Object.assign({}, c, { loading: !fresh }));
        paint();
        if (fresh) return;
      }
    }
    try {
      const r = await M.listFolder(v.account, v.folder);
      S.folderData.set(k, { threads: r.threads.sort((x, y) => y.date - x.date), at: Date.now(), syncedAt: r.syncedAt });
    } catch (e) {
      S.folderData.set(k, Object.assign({}, c, { loading: false, err: e.message }));
    }
    paint();
  }

  /* The phone and two-pane layouts show the mailboxes in the list's place; three panes always show them. */
  function openMbx() {
    if (three()) return;
    S.mbx = true;
    document.body.classList.add('mbx');
    renderSide();
    window.scrollTo(0, 0);
    const first = $('side').querySelector('.mbx-row.sel .mbx-main, .fold.sel') || $('side').querySelector('.mbx-main');
    if (first) first.focus({ preventScroll: true });
  }
  function closeMbx() {
    if (!S.mbx) return;
    S.mbx = false;
    document.body.classList.remove('mbx');
  }
  function toListTop() {
    const pane = document.querySelector('.pane-list');
    if (wide()) pane.scrollTop = 0; else if (!S.open) window.scrollTo(0, 0);
  }

  /* ---------- list ---------- */
  function visible() {
    const q = S.q.trim().toLowerCase();
    const src = S.view ? folderThreads() : S.threads.filter(t => isAll() || t.account === S.filter);
    return src.filter(t => (!S.hidden.has(t.key) || (S.view && S.keepInFolder.has(t.key))) &&
      (!q || [t.from, t.fromAddr, t.subject, t.snippet, t.why].join(' ').toLowerCase().includes(q)));
  }
  function ordered() {
    const v = visible();
    if (S.view) return { kept: [], fresh: [], all: v };
    const kept = v.filter(t => t.zone === 'kept'), fresh = v.filter(t => t.zone === 'new');
    return { kept, fresh, all: kept.concat(fresh) };
  }

  function render() { renderSide(); renderHead(); renderFilters(); renderFresh(); renderList(); renderTriage(); if (!S.open) renderReader(); }

  function counts() {
    const n = {};
    for (const t of S.threads) if (!S.hidden.has(t.key)) n[t.account] = (n[t.account] || 0) + 1;
    return n;
  }

  function renderSide() {
    const n = counts();
    $('side').innerHTML = `<div class="side-head"><button class="back-link narrow-only" data-act="mbx-close">${ic('chevL')}Back</button><h2 class="side-title">Mailboxes</h2></div>` +
      (M.ORDER.length ? Triage.engineBannerHtml() + Triage.sideAllHtml(S.triage === 'all') : '') +
      sideAllInboxesHtml(n) +
      M.ORDER.map(a => {
        const sel = S.filter === a && !S.view && !S.triage, open = S.foldersOpen.has(a), l = A[a].label;
        return `<div class="mbx-acct" data-acct="${slot(a)}">
          <div class="mbx-row${sel ? ' sel' : ''}">
            <button class="mbx-main" data-filter="${a}"${sel ? ' aria-current="page"' : ''}><span class="chip" aria-hidden="true">${esc(initial(l))}</span><span class="mbx-name">${esc(l)}</span>${S.errors[a] ? `<span class="mbx-err" data-tooltip="${attr(S.errors[a])}" aria-label="Not loaded"></span>` : ''}${n[a] ? `<span class="mbx-n">${n[a]}</span>` : ''}</button>
            <button class="mbx-disc" data-folders="${a}" aria-expanded="${open}" aria-label="${attr(l)} folders" data-tooltip="Folders">${ic('chevR')}</button>
          </div>
          ${open ? foldersHtml(a) : ''}
        </div>`;
      }).join('');
  }

  /* All inboxes leads the accounts. It has no folders or Triage entry of its own: those belong to one account. */
  const failed = () => M.ORDER.filter(a => S.errors[a] && A[a].kind !== 'none');
  function sideAllInboxesHtml(n) {
    if (!hasAll()) return '';
    const sel = isAll() && !S.view && !S.triage, total = M.ORDER.reduce((s, a) => s + (n[a] || 0), 0), bad = failed();
    return `<div class="mbx-acct mbx-all">
      <div class="mbx-row${sel ? ' sel' : ''}">
        <button class="mbx-main" data-filter="all"${sel ? ' aria-current="page"' : ''}><span class="chip chip-all" aria-hidden="true">${ic('inbox')}</span><span class="mbx-name">All inboxes</span>${bad.length ? `<span class="mbx-err" data-tooltip="${attr('Not loaded: ' + bad.map(a => A[a].label).join(', '))}" aria-label="Some accounts not loaded"></span>` : ''}${total ? `<span class="mbx-n">${total}</span>` : ''}</button>
      </div>
    </div>`;
  }

  /* The account's Triage entry leads its group and never waits on the folder list. */
  function foldersHtml(a) {
    const c = S.folderLists.get(a) || {}, tri = Triage.sideEntryHtml(a, S.triage === a);
    if (!c.items) {
      if (c.err) return `<div class="mbx-folders">${tri}<div class="fold-note">Couldn't list folders: ${esc(c.err)} · <button class="accent-link" data-folders-retry="${a}">Retry</button></div></div>`;
      return `<div class="mbx-folders" aria-busy="true">${tri}<div class="fold-sk"></div><div class="fold-sk"></div><div class="fold-sk"></div>${A[a].kind === 'imap' ? '<div class="fold-note">Asking the mail server…</div>' : ''}</div>`;
    }
    const main = c.items.filter(f => f.group === 'main'), more = c.items.filter(f => f.group === 'more'), moreOpen = S.moreOpen.has(a);
    return `<div class="mbx-folders" role="group" aria-label="${attr(A[a].label)} folders">${tri}${main.map(f => foldHtml(a, f)).join('')}` +
      (more.length ? `<button class="fold fold-more" data-more="${a}" aria-expanded="${moreOpen}">${ic('chevR')}<span class="fold-name">More</span><span class="fold-n">${more.length}</span></button>${moreOpen ? more.map(f => foldHtml(a, f)).join('') : ''}` : '') +
      (c.items.length ? '' : '<div class="fold-note">No folders</div>') +
      (c.err ? `<div class="fold-note">Refresh failed: ${esc(c.err)}</div>` : '') + '</div>';
  }
  function foldHtml(a, f) {
    const sel = S.view && S.view.account === a && S.view.id === f.id;
    return `<button class="fold${sel ? ' sel' : ''}${f.unread ? ' unread' : ''}" data-folder="${attr(a + '|' + f.id)}"${sel ? ' aria-current="page"' : ''}${f.depth ? ` style="padding-left: calc(var(--space-sm) + ${f.depth} * var(--space-lg))"` : ''}>${ic(f.icon || 'folder')}<span class="fold-name">${esc(f.name)}</span>${f.unread ? `<span class="fold-n" aria-label="${f.unread} unread">${f.unread}</span>` : ''}</button>`;
  }

  function countText() {
    if (S.view) {
      const c = folderNow() || {};
      if (!c.threads) return c.loading ? 'loading…' : '';
      const n = visible().length;
      return `${n} recent` + ((A[S.view.account] || {}).kind === 'imap' && c.syncedAt ? ` · synced ${ago(Date.parse(c.syncedAt))}` : '');
    }
    if ((!S.loadedAt && !S.threads.length) || !S.configured) return '';
    const { kept, fresh } = ordered();
    return `${kept.length} need you · ${fresh.length} not triaged`;
  }
  /* Eyebrow = the account, title = the mailbox. Below three panes the block opens the mailbox screen. */
  function renderHead() {
    const a = S.filter, tap = !three();
    const inner = `<span class="eyebrow" data-acct="${slot(a)}"><span class="adot"></span><span class="eyebrow-text">${esc((A[a] || {}).label || 'All inboxes')}</span>${tap ? ic('chevD') : ''}</span>` +
      `<span class="title-line"><span class="title app-title" role="heading" aria-level="1">${esc(S.view ? S.view.name : 'Inbox')}</span><span id="count" class="top-count">${esc(countText())}</span></span>`;
    $('head').innerHTML = tap ? `<button class="view-title" data-act="mbx-open" aria-haspopup="true" data-tooltip="Mailboxes and folders" data-tooltip-below>${inner}</button>` : `<div class="view-title">${inner}</div>`;
  }

  function renderFilters() {
    const n = counts();
    /* Tabs, not toggles: exactly one mailbox is always selected, All first when there is more than one account. */
    const total = M.ORDER.reduce((s, k) => s + (n[k] || 0), 0);
    $('filters').innerHTML = (hasAll() ? `<button class="pill-bar-btn" data-filter="all" aria-pressed="${isAll()}">All${total ? ` <span class="n">${total}</span>` : ''}</button>` : '') +
      M.ORDER.map(k =>
      `<button class="pill-bar-btn" data-filter="${k}" data-acct="${slot(k)}" aria-pressed="${S.filter === k}"><span class="adot" aria-hidden="true"></span>${esc(A[k].label)}${n[k] ? ` <span class="n">${n[k]}</span>` : ''}</button>`).join('');
    /* The bar scrolls sideways on a phone: keep the picked account in view (a later account sits past the edge). */
    const bar = $('filters'), on = bar.querySelector('[aria-pressed="true"]');
    if (on && bar.clientWidth) {
      const b = bar.getBoundingClientRect(), r = on.getBoundingClientRect();
      if (r.right > b.right) bar.scrollLeft += r.right - b.right + 8; else if (r.left < b.left) bar.scrollLeft -= b.left - r.left + 8;
    }
  }

  function renderFresh() {
    /* Triage freshness lives in the reader now, for the open email's account only. This strip only speaks up
     * when an account failed to load or a refresh is running. */
    const bits = [];
    for (const a of failed()) bits.push(`<span class="fresh-err" data-tooltip="${attr(S.errors[a])}">${esc(A[a].label)}: not loaded</span>`);
    if (S.loading) bits.push('<span>refreshing…</span>');
    $('fresh').innerHTML = bits.join('');
    $('fresh').hidden = !bits.length;
  }

  function rowHtml(t) {
    let lines = '';
    if (t.folder) lines = t.snippet ? `<div class="row-why one">${esc(t.snippet)}</div>` : '';
    else if (t.zone === 'kept') lines = t.why ? `<div class="row-why">${esc(t.why)}</div>` : '';
    else lines = (t.snippet ? `<div class="row-why one">${esc(t.snippet)}</div>` : '') +
      `<div class="row-status"><b>${esc(t.why || 'Arrived ' + ago(t.inboxDate))}</b>${t.hint ? ' · ' + esc(t.hint) : ''}</div>`;
    return `<div class="row${t.unread ? ' unread' : ''}${t.key === S.sel ? ' sel' : ''}${t.key === S.open ? ' open' : ''}" data-key="${attr(t.key)}" data-acct="${slot(t.account)}">
      <div class="row-bg" aria-hidden="true"><span>Archive</span><span>Delete</span></div>
      <div class="row-slide">
        ${t.unread ? '<span class="udot" aria-label="Unread"></span>' : ''}<span class="av" aria-hidden="true">${esc(initial(t.from))}</span>
        <div class="row-body">
          <div class="row-top"><span class="row-from">${esc(t.from)}</span>${t.count > 1 ? `<span class="row-n">${t.count}</span>` : ''}${isAll() && !S.view ? `<span class="row-acct"><span class="adot" aria-hidden="true"></span><span class="row-acct-name">${esc((A[t.account] || {}).label || t.account)}</span></span>` : ''}<span class="row-date">${esc(when(t.date))}</span></div>
          <div class="row-subject">${esc(t.subject)}</div>
          ${lines}
          ${t.repliedByUs ? '<div class="row-meta"><span class="label label-success pill">You replied</span></div>' : ''}
        </div>
      </div>
    </div>`;
  }
  const COLLAPSED = 'inbox.collapsed';
  const isCollapsed = id => !!(S.collapsedSecs && S.collapsedSecs[id]);
  const section = (id, title, sub, items) => {
    if (!items.length) return '';
    const shut = isCollapsed(id);
    return `<section class="sec${shut ? ' shut' : ''}"><button type="button" class="sec-head sec-toggle" data-sec="${id}" aria-expanded="${!shut}">` +
      `<svg class="sec-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>` +
      `<span class="title">${esc(title)}</span><span class="sec-n">${items.length}</span></button>` +
      (shut ? '' : `<div class="sec-sub">${esc(sub)}</div>${items.map(rowHtml).join('')}`) + `</section>`;
  };
  function toggleSection(id) {
    S.collapsedSecs = Object.assign({}, S.collapsedSecs, { [id]: !isCollapsed(id) });
    try { lucidos.storage.local.setItem(COLLAPSED, JSON.stringify(S.collapsedSecs)); } catch (e) { /* quota */ }
    renderList();
  }
  /* Rows hidden inside a collapsed section are skipped by j/k. */
  const visibleRows = () => { const o = ordered(); return S.view ? o.all : [...(isCollapsed('kept') ? [] : o.kept), ...(isCollapsed('fresh') ? [] : o.fresh)]; };
  const skeleton = n => '<div class="sec">' + '<div class="sk-row"><div class="sk-av"></div><div class="sk-lines"><span></span><span></span><span></span></div></div>'.repeat(n) + '</div>';

  function renderList() {
    const count = $('count');
    if (count) count.textContent = countText();
    if (S.view) { renderFolderList(); return; }
    const { kept, fresh, all } = ordered();
    if (!S.threads.length && !S.loadedAt) { listEl.innerHTML = skeleton(5); return; }
    if (S.sel && !all.some(t => t.key === S.sel)) S.sel = null;
    if (!all.length) { listEl.innerHTML = emptyHtml(); return; }
    listEl.innerHTML = section('kept', 'Needs you', 'Survived triage — why each one was kept is under it.', kept) +
      section('fresh', 'Not triaged yet', 'Arrived since the last run, or never seen by triage.', fresh);
  }

  function renderFolderList() {
    const c = folderNow() || {}, v = visible(), imapView = (A[S.view.account] || {}).kind === 'imap';
    if (S.sel && !v.some(t => t.key === S.sel)) S.sel = null;
    const status = c.loading ? `<span>${c.threads ? 'refreshing…' : imapView ? 'asking the mail server, this takes a few seconds…' : 'loading…'}</span>` : '';
    const bar = `<div class="folder-bar"><button class="accent-link" data-act="inbox">← ${esc(A[S.view.account].label)} inbox</button>${imapView ? '<span>·</span><span>read-only</span>' : ''}${status}</div>`;
    let body;
    if (!c.threads && c.err) body = `<div class="list-empty"><p class="error-text">Couldn't open ${esc(S.view.name)}: ${esc(c.err)}</p><button class="action-btn action-btn-secondary" data-act="folder-retry">Try again</button></div>`;
    else if (!c.threads) body = skeleton(4);
    else if (!v.length) body = `<div class="list-empty">${ic(S.view.folder.icon || 'folder')}<div class="title">${S.q ? 'Nothing matches.' : 'Nothing in ' + esc(S.view.name)}</div></div>`;
    else body = (c.err ? `<p class="fresh fresh-err">Refresh failed: ${esc(c.err)}</p>` : '') + `<div class="sec">${v.map(rowHtml).join('')}</div>`;
    listEl.innerHTML = bar + body;
  }

  function emptyHtml() {
    if (S.q) return '<div class="list-empty"><div class="title">Nothing matches.</div></div>';
    if (!S.configured) return `<div class="list-empty">${ic('inbox')}<div class="title">No mailboxes yet</div><div class="muted">Setup connects your mailboxes and schedules triage for each.</div><button class="action-btn" data-act="setup">Set up Inbox</button></div>`;
    /* All inboxes blanks only when every account failed; one failure stays a quiet line in the strip above. */
    if (isAll() && M.ORDER.every(a => S.errors[a])) return `<div class="list-empty">${ic('inbox')}<div class="title">Couldn't load any mailbox</div><p class="muted">Each account's reason is on its red dot.</p><button class="action-btn action-btn-secondary" data-act="refresh">Try again</button></div>`;
    if (S.filter && S.errors[S.filter]) return `<div class="list-empty">${ic('inbox')}<div class="title">Couldn't load ${esc(A[S.filter].label)}</div><p class="error-text">${esc(S.errors[S.filter])}</p>${A[S.filter].kind === 'none' ? '' : A[S.filter].problem ? '<button class="action-btn action-btn-secondary" data-act="setup">Run Inbox setup</button>' : '<button class="action-btn action-btn-secondary" data-act="refresh">Try again</button>'}</div>`;
    const cleared = S.ctx && S.ctx.clearedToday;
    return `<div class="list-empty">${ic('inbox')}<div class="title">Nothing on hold</div>${cleared ? `<div class="muted">Triage cleared ${cleared} email${cleared === 1 ? '' : 's'} today</div>` : ''}</div>`;
  }

  function move(d) {
    const all = visibleRows();
    if (!all.length) return;
    let i = all.findIndex(t => t.key === S.sel);
    i = i < 0 ? 0 : Math.min(all.length - 1, Math.max(0, i + d));
    S.sel = all[i].key;
    renderList();
    const el = listEl.querySelector('.row.sel');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- undo ---------- */
  let undoTimer = null;
  function pushUndo(text, fn, ms) {
    const entry = { text, fn, dead: false };
    S.undo.push(entry);
    if (S.undo.length > 20) S.undo.shift();
    $('undo-text').textContent = text;
    $('undo').hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { $('undo').hidden = true; }, ms || 8000);
    return entry;
  }
  async function popUndo() {
    let e;
    while ((e = S.undo.pop()) && e.dead) { /* skip spent entries (a reply that already went out) */ }
    $('undo').hidden = true;
    clearTimeout(undoTimer);
    if (e) await e.fn();
  }

  /* ---------- actions ---------- */
  const VERBS = { done: 'Archived', delete: 'Deleted', read: 'Marked read', unread: 'Marked unread' };
  async function act(key, op) {
    const t = byKey(key);
    if (!t || !canAct(t, op)) return;
    if (op === 'done' && t.folder) return archiveInFolder(t);
    if (op === 'done' || op === 'delete') {
      const all = ordered().all, i = all.findIndex(x => x.key === key);
      const next = all[i + 1] || all[i - 1];
      const wasOpen = S.open === key;
      S.hidden.set(key, Date.now() + 180e3);
      S.sel = next ? next.key : null;
      if (wasOpen) { if (wide() && next) openThread(next.key); else closeReader(true); }
      render();
      const p = M.act(t, op);
      pushUndo(`${VERBS[op]}: ${t.subject}`, async () => {
        S.hidden.delete(key);
        S.sel = key;
        render();
        try { await p.catch(() => {}); await M.undo(t, op); } catch (e) { lucidos.ui.toast('Undo failed: ' + e.message, 'error'); }
        setTimeout(() => { load(); if (S.view) loadFolder(true); }, 800);
      });
      try { await p; } catch (e) { S.hidden.delete(key); render(); lucidos.ui.toast(`${VERBS[op]} failed: ${e.message}`, 'error'); }
      /* The folder's cached list still holds the thread; the next open refetches. */
      const fd = t.folder && S.folderData.get(t.account + '|' + t.folder);
      if (fd) fd.at = 0;
      return;
    }
    /* A thread can be listed in a folder and the inbox at once: both copies show the same state. */
    const copies = [t].concat(S.threads.filter(x => x.key === key && x !== t), anyFolderThreads().filter(x => x.key === key && x !== t));
    const prev = t.unread;
    copies.forEach(x => { x.unread = op === 'unread'; });
    render();
    if (S.open === key) renderActions();
    try { await M.act(t, op); } catch (e) { copies.forEach(x => { x.unread = prev; }); render(); if (S.open === key) renderActions(); lucidos.ui.toast(`${VERBS[op]} failed: ${e.message}`, 'error'); }
  }

  /* Archiving from a folder takes the thread out of the inbox but leaves it in the folder, so its row stays put and
   * only loses the Archive action. The inbox copy hides as usual. */
  async function archiveInFolder(t) {
    const key = t.key, before = { inboxMsgIds: t.inboxMsgIds, unreadIds: t.unreadIds, unread: t.unread }, sent = Object.assign({}, t);
    const restore = () => { S.hidden.delete(key); S.keepInFolder.delete(key); Object.assign(t, before); render(); if (S.open === key) renderActions(); };
    S.hidden.set(key, Date.now() + 180e3);
    S.keepInFolder.add(key);
    Object.assign(t, { inboxMsgIds: [], unreadIds: [], unread: false });
    render();
    if (S.open === key) renderActions();
    const p = M.act(sent, 'done');
    pushUndo(`${VERBS.done}: ${t.subject}`, async () => {
      restore();
      try { await p.catch(() => {}); await M.undo(sent, 'done'); } catch (e) { lucidos.ui.toast('Undo failed: ' + e.message, 'error'); }
      setTimeout(load, 800);
    });
    try { await p; } catch (e) { restore(); lucidos.ui.toast(`${VERBS.done} failed: ${e.message}`, 'error'); }
  }

  async function ask(t) {
    const extra = await lucidos.ui.prompt({
      title: 'Ask Lucidos',
      message: 'What do you want done with this email? Leave empty to just hand it over.',
      placeholder: 'e.g. draft a polite no, or file it under Cars',
      okLabel: 'Ask', multiline: true,
    });
    if (extra === null) return;
    const a = A[t.account];
    const lines = [
      `About this email in my ${a.label} ${t.folder ? `mailbox, folder "${folderName(t)}"` : 'inbox'} (${a.address}, ${isImap(t) ? 'Message-ID ' + t.threadId : 'Gmail thread ' + t.threadId}):`,
      `From: ${t.from}${t.fromAddr && t.fromAddr !== t.from ? ' <' + t.fromAddr + '>' : ''}`,
      `Subject: ${t.subject}`,
    ];
    if (t.why) lines.push(`Triage: ${t.why}`);
    lucidos.ui.startThread({ prompt: lines.join('\n') + '\n\n' + (extra.trim() ? extra.trim() : '') });
  }

  /* ---------- reader ---------- */
  async function openThread(key) {
    const t = byKey(key);
    if (!t) return;
    saveDraft();
    if (!wide() && !S.open) S.listScroll = window.scrollY;
    /* A saved draft waits behind the reader's draft strip; the composer only opens when asked. */
    Object.assign(S, { sel: key, open: key, thread: null, threadErr: null, composer: null });
    closeMbx();
    document.body.classList.add('reading');
    if (!wide()) window.scrollTo(0, 0);
    renderList();
    renderReader();
    try {
      if (isImap(t) && !t.folder && t.imap && t.imap.html == null && t.imap.text == null) {
        const f = (await M.listImap(t.account)).threads.find(x => x.key === key);
        if (f) t.imap = f.imap;
      }
      const full = await M.loadThread(t);
      await M.inlineImages(t, full);
      if (S.open !== key) return;
      S.thread = full;
    } catch (e) {
      if (S.open === key) S.threadErr = e.message;
    }
    if (S.open !== key) return;
    renderMsgs();
    /* An account triaged unread-only must keep an untriaged mail unread when it is opened, or triage would never
     * see it. Windowed (shared) accounts triage by date, so opening one there is safe. */
    const pc = (S.ctx && S.ctx.per && S.ctx.per[t.account]) || {};
    if (t.unread && canAct(t, 'read') && (t.zone === 'kept' || pc.windowed)) act(key, 'read');
  }

  /* Step to the neighbouring conversation from inside the reader, in list order (folded sections included). */
  function step(d) {
    const all = ordered().all;
    const i = all.findIndex(t => t.key === S.open);
    const n = all[i + d];
    if (i < 0 || !n) return;
    openThread(n.key).then(() => readerEl.scrollTop = 0);
  }

  function closeReader(silent) {
    saveDraft();
    Object.assign(S, { open: null, thread: null, composer: null });
    document.body.classList.remove('reading');
    if (!silent) renderList();
    renderReader();
    if (!wide()) window.scrollTo(0, S.listScroll || 0);
  }

  function renderReader() {
    const t = S.open && byKey(S.open);
    if (!t) {
      const any = ordered().all.length;
      readerEl.innerHTML = `<div class="reader-empty">${ic(S.view ? (S.view.folder.icon || 'folder') : 'inbox')}<div class="title">${any ? 'Pick a conversation' : S.view ? 'Nothing here' : 'Nothing on hold'}</div><div class="keys">j / k to move · ⏎ to open</div></div>`;
      return;
    }
    const pc = (S.ctx && S.ctx.per && S.ctx.per[t.account]) || {}, a = A[t.account];
    const meta = t.folder ? `In ${folderName(t)}`
      : pc.paused ? 'Triage paused' : [`Last triaged ${ago(pc.lastRun)}`, pc.nextRun && `next run ${fmtTime.format(new Date(pc.nextRun))}`].filter(Boolean).join(' · ');
    readerEl.innerHTML = `
      <div class="reader-top"><button class="back-link back" data-act="back">${ic('chevL')}${esc(S.view && t.folder ? S.view.name : 'Inbox')}</button>${navHtml(t)}</div>
      <div class="reader-head" data-acct="${slot(t.account)}">
        <h2 class="reader-subject">${esc(t.subject)}</h2>
        <div class="reader-meta"><span class="acct-pill acct-label" tabindex="0" data-tooltip="${attr(a.address)}" data-tooltip-tap data-tooltip-below><span class="adot"></span>${esc(a.label)}</span><span>${esc(meta)}</span></div>
      </div>
      ${whyHtml(t)}
      <div id="actions" class="actions"></div>
      <div id="draft"></div>
      <div id="summary"></div>
      <div id="msgs"></div>`;
    renderActions();
    renderDraft();
    renderSummary();
    renderMsgs();
    renderComposer();
  }

  /* The reason a mail is still here, the same line its row shows, given room to breathe. */
  function whyHtml(t) {
    if (t.folder) return '';
    if (t.zone === 'kept') return t.why ? `<div class="why" data-acct="${slot(t.account)}">${ic('pin')}<span>${esc(t.why)}</span></div>` : '';
    return `<div class="why" data-acct="${slot(t.account)}">${ic('clock')}<span><b>${esc(t.why || 'Not triaged yet')}</b>${t.hint ? ' · ' + esc(t.hint) : ''}</span></div>`;
  }

  function navHtml(t) {
    const all = ordered().all, i = all.findIndex(x => x.key === t.key);
    if (i < 0 || all.length < 2) return '';
    const chev = d => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>`;
    return `<span class="nav"><button class="icon-btn nav-btn" data-act="prev" ${i === 0 ? 'disabled' : ''} data-tooltip="Previous (k)" aria-label="Previous email">${chev('M10 3L5 8l5 5')}</button><span class="nav-pos muted">${i + 1} / ${all.length}</span><button class="icon-btn nav-btn" data-act="next" ${i === all.length - 1 ? 'disabled' : ''} data-tooltip="Next (j)" aria-label="Next email">${chev('M6 3l5 5-5 5')}</button></span>`;
  }

  /* Archive leads, Reply sits beside it, everything else lives behind ⋯ so the row never wraps on a phone. A folder
   * row without a meaningful archive leads with Reply instead. */
  function renderActions() {
    const t = S.open && byKey(S.open), el = $('actions');
    if (!t || !el) return;
    const item = (act, icon, label, key, cls) => `<button class="menu-item${cls ? ' ' + cls : ''}" role="menuitem" data-act="${act}"><span class="menu-label">${ic(icon)}${label}</span><span class="kbd">${key}</span></button>`;
    const archive = canAct(t, 'done');
    el.innerHTML = (archive ? `<button class="action-btn btn-ic archive-btn" data-act="done" data-tooltip="Archive (e)">${ic('archive')}Archive</button>` : '') +
      `<button class="action-btn${archive ? ' action-btn-secondary' : ''} btn-ic" data-act="reply" data-tooltip="Reply (r)">${ic('reply')}Reply</button>
      <div class="more-wrap">
        <button class="action-btn action-btn-secondary btn-ic more-btn" data-act="more" aria-haspopup="menu" aria-expanded="${S.menu ? 'true' : 'false'}" aria-label="More actions">${ic('more')}</button>
        ${S.menu ? `<div class="menu" role="menu">${item('replyall', 'replyAll', 'Reply all', 'R')}${item('summarize', 'summary', 'Summarize', 's')}${item('ask', 'ask', 'Ask Lucidos', 'a')}${canAct(t, 'delete') ? item('delete', 'trash', 'Delete', '#', 'danger') : ''}</div>` : ''}
      </div>`;
    if (S.menu) { const first = el.querySelector('.menu-item'); if (first) first.focus(); }
  }

  function renderSummary() {
    const el = $('summary'), sm = S.summary;
    if (!el) return;
    if (!sm || sm.key !== S.open) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="summary">
      <div class="summary-head"><span class="label label-neutral">Summary</span>${sm.busy ? '' : `<button class="icon-btn" data-act="summary-close" data-tooltip="Hide summary" aria-label="Hide summary">${ic('x')}</button>`}</div>
      ${sm.busy ? '<div class="muted"><span class="mini-spinner" aria-hidden="true"></span> Summarizing…</div>' : `<div class="summary-text">${esc(sm.text)}</div>`}
    </div>`;
  }

  /* Who the AI writes for: settings.display_name, or a neutral stand-in. */
  function me() {
    const n = String(S.settings.display_name || '').trim();
    return n ? { name: n, short: n.split(/\s+/)[0], own: n.split(/\s+/)[0] + "'s" } : { name: 'the user', short: 'the user', own: "the user's" };
  }

  async function summarize() {
    const t = S.open && byKey(S.open);
    if (!t) return;
    if (!S.thread) { lucidos.ui.toast('Still loading this conversation', 'info'); return; }
    if (S.summary && S.summary.key === t.key && S.summary.busy) return;
    S.summary = { key: t.key, busy: true };
    renderSummary();
    try {
      const who = me();
      const system = `You summarize email conversations for ${who.name}. Write in English whatever language the mail is in. Give 2-4 short lines, each starting with "• ", covering who wants what and any dates, amounts or deadlines. Then one final line starting "Needs from you: " saying what ${who.short} has to do, or "Needs from you: nothing". Never invent facts. Plain text, no markdown.`;
      const out = await M.ai(system, `The conversation, oldest first:\n\n${threadForAi(12000)}\n\nSummarize it.`, S.settings.ai);
      if (!out) throw new Error('the model returned nothing');
      if (S.summary && S.summary.key === t.key) S.summary = { key: t.key, text: out };
    } catch (e) {
      if (S.summary && S.summary.key === t.key) S.summary = null;
      lucidos.ui.toast('Summarize failed: ' + e.message, 'error');
    }
    renderSummary();
  }

  function splitQuote(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const attribution = /^(On .{4,300}wrote:|Den .{4,300}skrev:?|Le .{4,300}a écrit ?:|Il .{4,300}ha scritto:|Am .{4,300}schrieb.{0,80}:|-{2,} ?Original Message ?-{2,}|-{5,} ?Forwarded message ?-{5,})$/i;
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i].trim(), two = (l + ' ' + (lines[i + 1] || '').trim()).trim();
      if (attribution.test(l) || attribution.test(two) || (/^>/.test(l) && lines.slice(i).every(x => /^\s*(>|$)/.test(x)))) {
        return { head: lines.slice(0, i).join('\n').replace(/\s+$/, ''), tail: lines.slice(i).join('\n') };
      }
    }
    return { head: String(text || '').replace(/\s+$/, ''), tail: '' };
  }
  const linkify = s => esc(s).replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, u => `<a href="${u}" target="_blank" rel="noopener" class="accent-link">${u}</a>`);
  const quoteBtn = (id, shown) => `<button class="accent-link quote-btn" data-act="quoted" data-id="${attr(id)}">${shown ? 'Hide quoted text' : '··· Show quoted text'}</button>`;

  function bodyHtml(m, id) {
    const shown = S.quoted.has(id);
    if (m.html) return `<div class="paper"><iframe class="mail-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" data-frame="${attr(id)}" title="Message"></iframe></div>${QUOTE_HTML.test(m.html) ? quoteBtn(id, shown) : ''}`;
    const { head, tail } = splitQuote(m.text || m.snippet || '');
    if (!head) return `<div class="msg-text">${linkify(tail)}</div>`;
    return `<div class="msg-text">${linkify(head)}${tail && shown ? '\n\n' + linkify(tail) : ''}</div>${tail ? quoteBtn(id, shown) : ''}`;
  }

  function attsHtml(m) {
    const atts = (m.attachments || []).filter(a => !a.inline);
    if (!atts.length) return '';
    return `<div class="atts">${atts.map((a, i) => `<button class="action-btn action-btn-secondary" data-act="att" data-mid="${attr(m.id)}" data-i="${i}">📎 ${esc(a.name)} <span class="muted">${esc(size(a.size))}</span></button>`).join('')}</div>`;
  }

  function renderMsgs() {
    const t = S.open && byKey(S.open), el = $('msgs');
    if (!t || !el) return;
    if (S.threadErr) { el.innerHTML = `<p class="error-text">Couldn't load this conversation: ${esc(S.threadErr)}</p>`; return; }
    if (!S.thread) { el.innerHTML = '<div class="sk tall"></div>'; return; }
    const ms = S.thread.messages, last = ms.length - 1;
    const blocked = ms.some(m => m.html && REMOTE.test(m.html)) && !S.images.has(t.key);
    el.innerHTML = (blocked ? `<div class="img-banner"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="7" r="1.2"/><path d="M3 12l3.5-3.5 2.5 2.5 2-2 2 2"/></svg><span>Images hidden to block tracking</span><button class="accent-link" data-act="images">Show</button></div>` : '') +
      ms.map((m, i) => {
        /* The last and unread messages start open; a click on any header overrides that either way. */
        const id = t.key + '#' + m.id, f = M.parseAddr(m.from);
        const open = S.expanded.has(id) ? S.expanded.get(id) : i === last || !!m.unread;
        return `<article class="msg">
          <div class="msg-head" data-act="toggle" data-id="${attr(id)}" data-open="${open}">
            <span class="av${m.mine ? ' mine' : ''}" data-acct="${slot(t.account)}" aria-hidden="true">${esc(initial(f.name || f.addr))}</span>
            <span class="msg-from">${esc(f.name || f.addr)} ${m.mine ? '<span class="muted">(you)</span>' : f.name ? `<span class="muted">${esc(f.addr)}</span>` : ''}</span>
            <span class="msg-date">${esc(m.date ? fmtFull.format(new Date(m.date)) : '')}</span>
            <span class="msg-sub">${open ? 'to ' + esc(m.to) + (m.cc ? ' · cc ' + esc(m.cc) : '') : esc(m.snippet || '')}</span>
          </div>
          ${open ? `<div class="msg-body">${bodyHtml(m, id)}</div>${attsHtml(m)}` : ''}
        </article>`;
      }).join('');
    mountFrames(t);
  }

  function mailDoc(html, images, quotes, tok) {
    const root = DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: true, RETURN_DOM: true,
      FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'option', 'meta', 'link', 'base', 'iframe', 'frame', 'object', 'embed', 'audio', 'video', 'script'],
      FORBID_ATTR: ['srcset', 'ping'],
    });
    const doc = root.ownerDocument;
    let head = root.querySelector('head');
    if (!head) { head = doc.createElement('head'); root.insertBefore(head, root.firstChild); }
    const nonce = randomToken();
    const slot = 'data-n' + nonce; // stamped into the serialized string, so no DOM nonce-hiding can blank it
    const net = images ? ' https: http:' : '';
    const el = (tag, attrs, text) => {
      const n = doc.createElement(tag);
      Object.keys(attrs).forEach(k => n.setAttribute(k, attrs[k]));
      if (text) n.textContent = text;
      return n;
    };
    [
      el('meta', { 'http-equiv': 'Content-Security-Policy', content: `default-src 'none'; script-src 'nonce-${nonce}'; img-src data: blob:${net}; style-src 'unsafe-inline'${images ? ' https:' : ''}; font-src data:${images ? ' https:' : ''}` }),
      el('meta', { name: 'referrer', content: 'no-referrer' }),
      el('style', {}, MAIL_CSS + (quotes ? '' : HIDE_QUOTES)),
      el('script', { [slot]: '' }, FRAME_JS.replace('__TOK__', String(tok))),
    ].reverse().forEach(n => head.insertBefore(n, head.firstChild));
    return '<!doctype html>' + root.outerHTML.replace(slot + '=""', `nonce="${nonce}"`);
  }

  function randomToken() {
    try { return Array.from(crypto.getRandomValues(new Uint32Array(3)), n => n.toString(36)).join(''); }
    catch (e) { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
  }

  let frameTok = 0;
  function mountFrames(t) {
    readerEl.querySelectorAll('iframe[data-frame]').forEach(f => {
      const id = f.dataset.frame, mid = id.slice(t.key.length + 1);
      const m = S.thread && S.thread.messages.find(x => x.id === mid);
      if (!m) return;
      f.dataset.tok = String(++frameTok);
      f.dataset.fits = '0';
      f.srcdoc = mailDoc(m.html, S.images.has(t.key), S.quoted.has(id), f.dataset.tok);
    });
  }

  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.inboxFrame == null) return;
    const f = Array.from(readerEl.querySelectorAll('iframe[data-frame]')).find(x => x.contentWindow === e.source);
    if (!f || f.dataset.tok !== String(d.inboxFrame)) return;
    if (typeof d.h === 'number' && isFinite(d.h)) {
      const n = Number(f.dataset.fits || 0) + 1;
      f.dataset.fits = String(n);
      // A mail laid out against the viewport grows with its own frame; stop following after 40 resizes.
      if (n <= 40) f.style.height = Math.min(40000, Math.max(32, Math.ceil(d.h))) + 'px';
    } else if (typeof d.open === 'string') {
      if (/^(https?:|mailto:)/i.test(d.open)) lucidos.ui.openExternal(d.open);
    } else if (typeof d.key === 'string' && !$('comp').open) {
      const run = shortcut(d.key);
      if (run) run();
    }
  });

  async function openAtt(mid, i) {
    const t = S.open && byKey(S.open);
    const m = S.thread && S.thread.messages.find(x => x.id === mid);
    const a = m && (m.attachments || []).filter(x => !x.inline)[i];
    if (!t || !a) return;
    if (isImap(t)) {
      if (!a.path) { lucidos.ui.toast('Too large to cache: open it in your webmail', 'warning'); return; }
      lucidos.ui.previewFile({ file_path: a.path }).catch(() => lucidos.ui.navigate('file', { file_path: a.path }));
      return;
    }
    lucidos.ui.toast('Fetching ' + a.name + '…', 'info', { key: 'att', spinning: true });
    try {
      const url = await M.attachmentUrl(t, mid, a);
      const link = Object.assign(document.createElement('a'), { href: url, download: a.name });
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60e3);
      lucidos.ui.dismissToast('att');
    } catch (e) {
      lucidos.ui.toast('Download failed: ' + e.message, 'error', { key: 'att' });
    }
  }

  /* ---------- composer ---------- */
  function syncComposer() {
    const c = S.composer;
    if (!c) return;
    const to = $('c-to'), cc = $('c-cc'), body = $('c-body');
    if (to) c.to = to.value;
    if (cc) c.cc = cc.value;
    if (body) c.body = body.value;
  }
  /* The words of a reply without the account's signature; empty means there is nothing worth keeping. */
  function draftText(key, d) {
    const t = byKey(key), sig = t ? M.voiceOf(t.account, S.settings).signature : '', body = String(d.body || '');
    return (sig ? body.replace(sig, '') : body).trim();
  }
  function saveDraft() {
    if (!S.open) return;
    syncComposer();
    if (S.composer) {
      if (draftText(S.open, S.composer)) S.drafts[S.open] = Object.assign({}, S.composer);
      else delete S.drafts[S.open];
    }
    persistDrafts();
  }
  const spin = label => `<span class="mini-spinner" style="--spinner-color: currentColor" aria-hidden="true"></span> ${label}`;

  /* The composer is a modal <dialog>: a centred card on a wide screen, a full-screen sheet on a phone. Send and
   * Close sit in its header so the on-screen keyboard never covers them. No data-tooltip inside it: the dialog
   * paints in the top layer, above the SDK's tooltip. */
  function renderComposer() {
    const t = S.open && byKey(S.open), el = $('comp'), c = S.composer;
    if (!t || !c) {
      if (el.open) el.close();
      el.innerHTML = '';
      document.body.classList.remove('composing');
      return;
    }
    const a = A[t.account], b = S.busy ? 'disabled' : '';
    const fromName = M.voiceOf(t.account, S.settings).fromName;
    const tool = (act, icon, label, extra) => `<button class="action-btn action-btn-secondary btn-ic" data-act="${act}" ${extra || ''}>${ic(icon)}${label}</button>`;
    el.innerHTML = `<div class="composer">
      <div class="comp-head">
        <button class="icon-btn" data-act="comp-close" aria-label="Close and keep the draft">${ic('x')}</button>
        <div class="comp-title"><span class="title">${c.all ? 'Reply all' : 'Reply'}</span><span class="comp-subj">${esc(c.subject)}</span></div>
        <button class="action-btn btn-ic" data-act="send" ${b}>${ic('send')}Send</button>
      </div>
      <div class="comp-main">
        <div class="comp-row"><label for="c-to">To</label><input id="c-to" class="text-input" value="${attr(c.to)}" autocomplete="off"></div>
        ${c.showCc || c.cc ? `<div class="comp-row"><label for="c-cc">Cc</label><input id="c-cc" class="text-input" value="${attr(c.cc)}" autocomplete="off"></div>` : ''}
        <div class="comp-tools">
          <button class="action-btn action-btn-secondary btn-ic" data-act="suggest" ${b}>${S.busy === 'suggest' ? spin('Writing…') : ic('sparkles') + 'Suggest'}</button>
          <button class="action-btn action-btn-secondary btn-ic" data-act="polish" ${b}>${S.busy === 'polish' ? spin('Polishing…') : ic('wand') + 'Polish'}</button>
          ${c.prev != null ? tool('ai-undo', 'undo', 'Undo AI', b) : ''}
          ${c.canAll ? (c.all ? tool('replyone', 'reply', 'Sender only') : tool('replyall', 'replyAll', 'Reply all')) : ''}
          ${c.showCc || c.cc ? '' : tool('cc', 'cc', 'Cc')}
          <button class="action-btn action-btn-secondary btn-ic comp-discard" data-act="discard" ${b}>${ic('trash')}Discard</button>
        </div>
        <textarea id="c-body" class="text-input comp-body" placeholder="Write your reply, or press Suggest" autofocus>${esc(c.body)}</textarea>
        <div class="comp-hint">From ${fromName ? `${esc(fromName)} &lt;${esc(a.address)}&gt;` : esc(a.address)} · <span class="keys">⌘⏎ sends · Esc keeps a draft · </span>${undoSecs()} s to undo a send</div>
      </div>
    </div>`;
    if (!el.open) el.showModal();
    document.body.classList.add('composing');
  }

  /* Closing keeps the reply as a draft (unless it has no words yet); the reader offers it back until sent. */
  function closeComposer() {
    saveDraft();
    S.composer = null;
    renderComposer();
    renderDraft();
  }

  function renderDraft() {
    const el = $('draft'), d = S.open && !S.composer && S.drafts[S.open];
    if (!el) return;
    if (!d) { el.innerHTML = ''; return; }
    const first = draftText(S.open, d).split('\n')[0];
    el.innerHTML = `<button class="draft" data-act="resume">${ic('pencil')}<span class="draft-text"><b>Draft reply</b>${first ? ' · ' + esc(first) : ''}</span><span class="draft-go">Continue</span></button>`;
  }

  function reply(all) {
    const key = S.sel || S.open;
    const t = key && byKey(key);
    if (!t) return;
    if (S.open !== key) { openThread(key).then(() => reply(all)); return; }
    if (!S.thread) { lucidos.ui.toast('Still loading the conversation…', 'info'); return; }
    syncComposer();
    /* A saved draft comes back with its own recipients; only an explicit reply-all rewrites them. */
    const resumed = !S.composer && S.drafts[key];
    if (resumed) S.composer = Object.assign({}, resumed);
    const d = M.replyDraft(t, S.thread, all, S.settings);
    const dAll = all ? d : M.replyDraft(t, S.thread, true, S.settings);
    const one = all ? M.replyDraft(t, S.thread, false, S.settings) : d;
    const canAll = (dAll.to || '') !== (one.to || '') || !!dAll.cc;
    const recip = { to: d.to, cc: d.cc, showCc: d.showCc, all: !!all, canAll };
    S.composer = S.composer ? Object.assign({}, S.composer, (all || (S.composer.all && !resumed)) ? recip : { canAll }) : Object.assign(d, recip);
    renderComposer();
    renderDraft();
    const body = $('c-body');
    if (!body) return;
    body.focus();
    /* Caret at the end of the words already written, above the signature; a fresh reply starts at the top. */
    const words = resumed ? draftText(key, S.composer) : '', i = words ? body.value.indexOf(words) : -1;
    const at = i >= 0 ? i + words.length : resumed ? body.value.length : 0;
    body.setSelectionRange(at, at);
  }

  function send() {
    syncComposer();
    const t = S.open && byKey(S.open), c = S.composer;
    if (!t || !c || S.busy) return;
    if (!/@/.test(c.to)) { lucidos.ui.toast('Add a recipient first', 'warning'); return; }
    if (!c.body.trim()) { lucidos.ui.toast('The reply is empty', 'warning'); return; }
    const draft = Object.assign({}, c, { prev: null }), key = t.key, who = M.displayName(draft.to);
    const oid = key + '|' + Date.now();
    S.outbox[oid] = { key, draft, phase: 'waiting', at: Date.now() };
    persistOutbox();
    S.composer = null;
    delete S.drafts[key];
    persistDrafts(true);
    renderComposer();
    renderDraft();
    /* Undo reopens the composer on the reply; a failed send only puts it back behind the draft strip. */
    const backToDraft = reopen => {
      delete S.outbox[oid];
      persistOutbox();
      S.drafts[key] = draft;
      persistDrafts(true);
      if (S.open !== key) return;
      if (reopen && !S.composer) { S.composer = Object.assign({}, draft); renderComposer(); } else renderDraft();
    };
    let timer = null;
    const entry = pushUndo(`Sending to ${who}…`, async () => { clearTimeout(timer); backToDraft(true); }, undoSecs() * 1000);
    timer = setTimeout(async () => {
      entry.dead = true;
      if (!S.outbox[oid]) return;
      S.outbox[oid].phase = 'sending';
      persistOutbox();
      lucidos.ui.toast('Sending…', 'info', { key: 'send-' + oid, spinning: true, dismissable: false });
      try {
        await M.sendReply(t, draft);
        delete S.outbox[oid];
        persistOutbox();
        lucidos.ui.toast('Sent to ' + who, 'success', { key: 'send-' + oid });
        setTimeout(load, 1500);
      } catch (e) {
        backToDraft(false);
        lucidos.ui.toast('Not sent: ' + e.message, 'error', { key: 'send-' + oid });
      }
    }, undoSecs() * 1000);
  }

  function threadForAi(budget) {
    const ms = (S.thread && S.thread.messages) || [], out = [];
    for (let i = ms.length - 1; i >= 0 && budget > 0; i--) {
      const m = ms[i];
      const body = (m.text ? splitQuote(m.text).head : M.htmlText(m.html || '')).slice(0, Math.min(4000, budget));
      budget -= body.length;
      out.unshift(`From: ${m.from}${m.mine ? ' (us)' : ''}\nDate: ${m.date ? fmtFull.format(new Date(m.date)) : ''}\n\n${body}`);
    }
    return out.join('\n\n-----\n\n');
  }

  async function assist(kind) {
    syncComposer();
    const t = S.open && byKey(S.open), c = S.composer;
    if (!t || !c || S.busy) return;
    const v = M.voiceOf(t.account, S.settings), sig = v.signature, key = t.key, who = me();
    const notes = draftText(key, c);
    if (kind === 'polish' && !notes) { lucidos.ui.toast('Write something first, then Polish it', 'info'); return; }
    S.busy = kind;
    renderComposer();
    try {
      let out;
      if (kind === 'suggest') {
        const system = `You draft email replies for ${who.name}. ${v.voice}\nRules: reply in the language of the latest incoming message. Answer what the conversation actually needs, briefly. Never invent facts, numbers, dates, prices or promises: write a [bracketed placeholder] where ${who.short} must fill something in. Plain text only, no markdown, no subject line.${sig ? '\nEnd with this signature exactly:\n' + sig : ''}\nOutput only the reply body.`;
        out = await M.ai(system, `The conversation, oldest first:\n\n${threadForAi(12000)}${notes ? `\n\n${who.own.charAt(0).toUpperCase() + who.own.slice(1)} notes on what to say:\n${notes}` : ''}\n\nWrite the reply.`, S.settings.ai);
      } else {
        const system = `You are a careful copy editor for ${who.own} emails. Fix grammar, spelling, punctuation and unclear phrasing in the draft. Keep the writer's meaning, tone, register, language and roughly their length. Do not add facts, pleasantries or new sentences. ${v.voice}\nPlain text only. Output only the revised draft${sig ? ', ending with the same signature' : ''}.`;
        const last = ((S.thread && S.thread.messages) || []).filter(m => !m.mine).pop();
        const ctxText = last ? (last.text ? splitQuote(last.text).head : M.htmlText(last.html || '')).slice(0, 2500) : '';
        out = await M.ai(system, `${ctxText ? `For context, the email being replied to:\n${ctxText}\n\n` : ''}The draft:\n${c.body}`, S.settings.ai);
      }
      if (!out) throw new Error('the model returned nothing');
      /* Closing the composer mid-call must not lose the text: it lands in the reopened composer or the draft. */
      const live = S.composer === c ? c : (S.open === key && S.composer) || S.drafts[key] || (S.drafts[key] = Object.assign({}, c));
      live.prev = live.body;
      live.body = out;
      if (live !== S.composer) { persistDrafts(true); renderDraft(); }
    } catch (e) {
      lucidos.ui.toast(`${kind === 'suggest' ? 'Suggest' : 'Polish'} failed: ${e.message}`, 'error');
    } finally {
      S.busy = null;
      renderComposer();
      const body = $('c-body');
      if (body) body.focus();
    }
  }

  /* ---------- input ---------- */
  document.addEventListener('click', e => {
    if (S.menu && !e.target.closest('[data-act="more"]')) { S.menu = false; renderActions(); }
    const tri = e.target.closest('[data-triage]');
    if (tri) { openTriage(tri.dataset.triage); return; }
    const f = e.target.closest('[data-filter]');
    if (f) { pick(f.dataset.filter); Object.assign(S, { view: null, triage: null }); closeMbx(); render(); toListTop(); return; }
    const fo = e.target.closest('[data-folder]');
    if (fo) { const v = fo.dataset.folder, i = v.indexOf('|'); openFolder(v.slice(0, i), v.slice(i + 1)); return; }
    const disc = e.target.closest('[data-folders]');
    if (disc) { toggleFolders(disc.dataset.folders); return; }
    const retry = e.target.closest('[data-folders-retry]');
    if (retry) { loadFolders(retry.dataset.foldersRetry, true); return; }
    const more = e.target.closest('[data-more]');
    if (more) { const a = more.dataset.more; S.moreOpen.has(a) ? S.moreOpen.delete(a) : S.moreOpen.add(a); renderSide(); return; }
    const sec = e.target.closest('[data-sec]');
    if (sec) { toggleSection(sec.dataset.sec); return; }
    const row = e.target.closest('.row');
    if (row && listEl.contains(row)) {
      if (row.dataset.swiped) { delete row.dataset.swiped; return; }
      openThread(row.dataset.key);
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const t = S.open && byKey(S.open), id = b.dataset.id;
    switch (b.dataset.act) {
      case 'refresh': load(); requestImapSync(); if (S.view) loadFolder(true); break;
      case 'setup': lucidos.ui.startThread({ prompt: SETUP_PROMPT }); break;
      case 'mbx-open': openMbx(); break;
      case 'mbx-close': closeMbx(); break;
      case 'inbox': exitFolder(); break;
      case 'triage-exit': if (S.triage !== 'all') S.filter = S.triage; exitTriage(); break;
      case 'folder-retry': loadFolder(true); break;
      case 'undo': popUndo(); break;
      case 'back': closeReader(); break;
      case 'done': case 'delete': case 'read': case 'unread': if (t) act(t.key, b.dataset.act); break;
      case 'reply': case 'resume': S.sel = S.open; reply(false); break;
      case 'comp-close': closeComposer(); break;
      case 'replyall': S.sel = S.open; reply(true); break;
      case 'replyone': if (t && S.composer && S.thread) { syncComposer(); const d = M.replyDraft(t, S.thread, false, S.settings); Object.assign(S.composer, { to: d.to, cc: d.cc, showCc: !!d.cc, all: false }); S.drafts[t.key] = Object.assign({}, S.composer); persistDrafts(); renderComposer(); } break;
      case 'prev': step(-1); break;
      case 'next': step(1); break;
      case 'ask': if (t) ask(t); break;
      case 'more': S.menu = !S.menu; renderActions(); break;
      case 'summarize': summarize(); break;
      case 'summary-close': S.summary = null; renderSummary(); break;
      case 'images': if (t) { S.images.add(t.key); renderMsgs(); } break;
      case 'toggle': S.expanded.set(id, b.dataset.open !== 'true'); renderMsgs(); break;
      case 'quoted': S.quoted.has(id) ? S.quoted.delete(id) : S.quoted.add(id); renderMsgs(); break;
      case 'att': openAtt(b.dataset.mid, Number(b.dataset.i)); break;
      case 'send': send(); break;
      case 'suggest': assist('suggest'); break;
      case 'polish': assist('polish'); break;
      case 'ai-undo': if (S.composer && S.composer.prev != null) { S.composer.body = S.composer.prev; S.composer.prev = null; renderComposer(); } break;
      case 'cc': if (S.composer) { syncComposer(); S.composer.showCc = true; renderComposer(); const cc = $('c-cc'); if (cc) cc.focus(); } break;
      case 'discard': S.composer = null; if (t) delete S.drafts[t.key]; persistDrafts(); renderComposer(); renderDraft(); break;
    }
  });

  /* Esc and a press on the backdrop close the composer the same way its ✕ does, keeping the draft. A text
   * selection dragged out of the dialog ends on the backdrop too, so the press has to start there as well. */
  const compEl = $('comp');
  let pressOnBackdrop = false;
  compEl.addEventListener('cancel', e => { e.preventDefault(); closeComposer(); });
  compEl.addEventListener('pointerdown', e => { pressOnBackdrop = e.target === compEl; });
  compEl.addEventListener('click', e => { if (pressOnBackdrop && e.target === compEl) closeComposer(); pressOnBackdrop = false; });
  /* On the phone sheet, a downward drag with nothing above to scroll back to would be the SDK's pull to
   * refresh, reloading the app mid-reply. Claim it. */
  let touch0 = null;
  compEl.addEventListener('touchstart', e => { touch0 = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
  compEl.addEventListener('touchmove', e => {
    if (!touch0 || e.touches.length > 1) return;
    const dx = e.touches[0].clientX - touch0.x, dy = e.touches[0].clientY - touch0.y;
    const atTop = [e.target.closest('textarea'), e.target.closest('.comp-main')].every(x => !x || x.scrollTop <= 0);
    if (atTop && dy > Math.abs(dx)) e.preventDefault();
  }, { passive: false });

  document.addEventListener('input', e => {
    if (e.target.id === 'search') { S.q = e.target.value; renderList(); return; }
    if (e.target.closest && e.target.closest('.composer') && S.open && S.composer) {
      syncComposer();
      S.drafts[S.open] = Object.assign({}, S.composer);
      persistDrafts();
    }
  });

  function shortcut(k) {
    const key = S.sel || S.open, t = key && byKey(key);
    return {
      j: () => S.open ? step(1) : move(1), ArrowDown: () => move(1), k: () => S.open ? step(-1) : move(-1), ArrowUp: () => move(-1),
      Enter: () => S.sel && S.sel !== S.open && openThread(S.sel), o: () => S.sel && S.sel !== S.open && openThread(S.sel),
      Escape: () => { if (S.menu) { S.menu = false; renderActions(); } else if (S.open) closeReader(); else if (S.mbx) closeMbx(); else if (S.triage) exitTriage(); else if (S.view) exitFolder(); },
      e: () => t && act(t.key, 'done'), '#': () => t && act(t.key, 'delete'), Delete: () => t && act(t.key, 'delete'),
      r: () => reply(false), R: () => reply(true), a: () => t && ask(t), s: () => S.open && summarize(), z: () => popUndo(),
      '/': () => $('search').focus(), '?': () => lucidos.ui.toast(KEYS, 'info', { title: 'Keys', durationMs: 8000 }),
    }[k];
  }

  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
    if (compEl.open) {
      /* The composer is modal: list and reader keys stay off, and the dialog handles Esc itself. */
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
      return;
    }
    if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    /* The triage pane hides the list: its keys would act on rows nobody can see. */
    if (S.triage && e.key !== 'Escape' && e.key !== 'z') return;
    const run = shortcut(e.key);
    if (run) { e.preventDefault(); run(); }
  });

  /* Touch: swipe right = Done, swipe left = Delete. Rows set touch-action: pan-y, which claims the
   * sideways drag from the host's pane swipe. */
  (function swipe() {
    let st = null;
    listEl.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      const row = e.target.closest('.row');
      if (row) st = { row, x: e.clientX, y: e.clientY, dx: 0, lock: null, id: e.pointerId, w: row.offsetWidth };
    });
    listEl.addEventListener('pointermove', e => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!st.lock) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        st.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (st.lock === 'x') try { st.row.setPointerCapture(e.pointerId); } catch (err) { /* already gone */ }
      }
      if (st.lock !== 'x') return;
      st.dx = dx;
      const slide = st.row.querySelector('.row-slide');
      slide.style.transition = 'none';
      slide.style.transform = `translateX(${dx}px)`;
      st.row.dataset.swipe = dx > 0 ? 'done' : 'trash';
    });
    const end = e => {
      if (!st || e.pointerId !== st.id) return;
      const s = st;
      st = null;
      if (s.lock !== 'x') return;
      s.row.dataset.swiped = '1';
      const slide = s.row.querySelector('.row-slide');
      slide.style.transition = '';
      const op = s.dx > 0 ? 'done' : 'delete', t = byKey(s.row.dataset.key);
      if (Math.abs(s.dx) > s.w * 0.3 && t && canAct(t, op)) {
        slide.style.transform = `translateX(${s.dx > 0 ? '100%' : '-100%'})`;
        setTimeout(() => act(s.row.dataset.key, op), 160);
      } else {
        slide.style.transform = '';
        setTimeout(() => { delete s.row.dataset.swipe; delete s.row.dataset.swiped; }, 250);
      }
    };
    listEl.addEventListener('pointerup', end);
    listEl.addEventListener('pointercancel', end);
  })();


  matchMedia('(min-width: 72rem)').addEventListener('change', () => { if (three()) closeMbx(); renderHead(); renderTriage(); });

  lucidos.sse.on('EmailTriageCompleted', () => setTimeout(load, 1500));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - S.loadedAt > 120e3) load(); });
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, 5 * 60e3);

  /* Replies left in the outbox by a closed Inbox come back as drafts. One that never started is safe to resend;
   * one cut off mid-send may already have gone out, and the toast says so. */
  function restoreOutbox() {
    let box = {};
    try { box = JSON.parse(lucidos.storage.local.getItem(OUTBOX) || '{}') || {}; } catch (e) { box = {}; }
    const items = Object.values(box).filter(o => o && o.key && o.draft);
    if (!items.length) return;
    let unsure = 0;
    for (const o of items.sort((x, y) => x.at - y.at)) {
      if (o.phase === 'sending') unsure++;
      S.drafts[o.key] = Object.assign({}, o.draft, { prev: null });
    }
    S.outbox = {};
    persistOutbox();
    persistDrafts(true);
    const one = items.length === 1;
    const what = one ? 'A reply' : items.length + ' replies';
    const back = one ? "It's back as a draft" : "They're back as drafts";
    lucidos.ui.toast(unsure
      ? `${what} may not have gone out: the Inbox closed while sending. ${back}, so check Sent before you resend.`
      : `${what} didn't go out: the Inbox closed during the undo window. ${back}.`, 'warning');
  }

  /* ---------- start: cached list first (instant), then live ---------- */
  (async function init() {
    $('keys-line').textContent = KEYS;
    try { await lucidos.storage.ready; } catch (e) { /* no storage: live only */ }
    try { S.drafts = JSON.parse(lucidos.storage.local.getItem(DRAFTS) || '{}') || {}; } catch (e) { S.drafts = {}; }
    try { S.collapsedSecs = JSON.parse(lucidos.storage.local.getItem(COLLAPSED) || '{}') || {}; } catch (e) { S.collapsedSecs = {}; }
    try { S.filter = lucidos.storage.local.getItem(PICK) || null; } catch (e) { /* no storage */ }
    restoreOutbox();
    try {
      const c = JSON.parse(lucidos.storage.local.getItem(CACHE) || 'null');
      if (c && Array.isArray(c.threads) && Array.isArray(c.accounts)) {
        M.useAccounts(c.accounts);
        Object.assign(S, { threads: c.threads, ctx: c.ctx, settings: (c.ctx && c.ctx.settings) || {}, loadedAt: c.at || 0, imapSyncedAt: c.imapSyncedAt || {} });
        ensureFilter();
      }
    } catch (e) { /* corrupt cache */ }
    render();
    renderReader();
    if (S.threads.length) lucidos.ui.ready();
    /* The triage pane reads per-account files by Mail's account list, which the first live load may change. */
    const accountsBefore = M.ORDER.join('\n');
    const triageReady = Triage.init({ el: $('triage'), refresh: () => { renderSide(); renderTriage(); }, onConfig: applyConfig });
    await load();
    if (M.ORDER.join('\n') !== accountsBefore) triageReady.then(() => Triage.load());
    requestImapSync(3 * 60e3);
  })();
})();
