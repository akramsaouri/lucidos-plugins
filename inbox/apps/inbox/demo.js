/* Demo mode, for screenshots: made-up accounts and mail, never the workspace's own.
 * Entered when the app opens at #demo, or a view of it:
 *   #demo           the inbox list (Needs you / Not triaged yet)
 *   #demo/all       All inboxes: every account's mail in one list
 *   #demo/open      the list with one conversation open
 *   #demo/reply     that conversation with a reply drafted by Suggest
 *   #demo/triage    the Triage pane for the first account: health, rule chain, suggestions, run history
 * install() swaps the lucidos.* calls the apps make (data, proxy, events, triggers, sse, storage, startThread) for
 * in-memory fakes before mail.js loads, so the normal code paths render the fixture and nothing reaches the
 * workspace: no proxy, bridge, data or event call, and no write. The inbox-glance widget calls install() itself
 * when its params say { "demo": true }. */
(function () {
  'use strict';

  const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const NOW = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const ago = ms => NOW - ms;

  const ACCOUNTS = [
    { name: 'Personal', address: 'alex@example.com', proxy: 'demo-personal', lastRun: ago(35 * MIN) },
    { name: 'Work', address: 'alex@acme.example', proxy: 'demo-work', lastRun: ago(50 * MIN) },
    { name: 'Side project', address: 'hello@studio.example', proxy: 'demo-studio', lastRun: ago(3 * DAY), paused: true },
  ];
  const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const CONFIG = {
    accounts: {
      Personal: {
        address: 'alex@example.com', fetch: 'gmail-api', oauth_provider: 'google', no_action_clear: 'archive',
        rules: [
          { _comment: 'Newsletters I never read', action: 'delete', condition: { field: 'from', operator: 'contains', value: 'newsletter@' } },
          { action: 'label', label: 'Receipts', condition: { field: 'subject', operator: 'regex', value: '(?i)receipt|order confirmation' } },
          { action: 'notify', condition: { field: 'from', operator: 'equals', value: 'jamie.chen@example.com' } },
        ],
      },
      Work: {
        address: 'alex@acme.example', fetch: 'gmail-api', oauth_provider: 'google-work', no_action_clear: 'read',
        rules: [
          { action: 'read', condition: { field: 'from', operator: 'contains', value: 'calendar@acme.example' } },
          { action: 'notify', condition: { field: 'from', operator: 'contains', value: '@northwind.example' } },
        ],
      },
      'Side project': { address: 'hello@studio.example', fetch: 'gmail-api', oauth_provider: 'google-studio', paused: true, rules: [] },
    },
  };
  const SETTINGS = {
    display_name: 'Alex Rivera',
    voice: 'Warm and direct. Short sentences, no corporate filler.',
    accounts: { Personal: { proxy: 'demo-personal' }, Work: { proxy: 'demo-work' }, 'Side project': { proxy: 'demo-studio' } },
  };

  /* Each thread: its messages oldest first, and for a kept one the reason triage kept it. A message dated after
   * the account's last run lands in Not triaged yet. */
  const ME = { 'demo-personal': 'Alex Rivera <alex@example.com>', 'demo-work': 'Alex Rivera <alex@acme.example>', 'demo-studio': 'Alex Rivera <hello@studio.example>' };
  const THREADS = {
    'demo-personal': [
      { id: 'dinner', subject: 'Dinner Saturday? Need a headcount by Thursday', reason: 'Jamie asks you a direct question and needs an answer by Thursday', messages: [
        { from: 'Jamie Chen <jamie.chen@example.com>', at: ago(2 * DAY + 3 * HOUR), labels: ['INBOX'], text: "Hey Alex,\n\nWe're doing a small dinner at ours on Saturday, around 7. Nothing fancy, just pasta and too much wine.\n\nAre you in? Bring Sam if you like.\n\nJamie" },
        { from: 'me', to: 'Jamie Chen <jamie.chen@example.com>', at: ago(2 * DAY), labels: ['SENT'], text: 'Sounds great, count me in. Let me check with Sam and get back to you.\n\nAlex' },
        { from: 'Jamie Chen <jamie.chen@example.com>', at: ago(3 * HOUR), labels: ['INBOX', 'UNREAD'], text: "Hi again!\n\nI need a final headcount by Thursday so I know how much to cook. Is Sam coming too? And does anyone have allergies I should know about?\n\nAlso, could you bring dessert? Nothing fancy, the bakery on Elm Street is great.\n\nThanks!\nJamie" },
      ] },
      { id: 'dentist', subject: 'Please confirm your appointment on Nov 3', reason: 'Asks you to confirm before Friday or the slot goes to someone else', messages: [
        { from: 'Maple Street Dental <appointments@dental.example>', at: ago(5 * HOUR), labels: ['INBOX', 'UNREAD'], text: 'Hello Alex,\n\nThis is a reminder of your check-up on Monday, November 3 at 9:30.\n\nPlease reply YES to confirm by Friday. Unconfirmed slots are offered to the waiting list.\n\nMaple Street Dental' },
      ] },
      { id: 'lease', subject: 'Lease renewal for next year', reason: 'Your landlord needs a yes or no on renewing by Nov 15', messages: [
        { from: 'Priya Nair <priya.nair@example.com>', at: ago(DAY + 2 * HOUR), labels: ['INBOX'], text: "Hi Alex,\n\nYour lease is up at the end of December. I'd be happy to renew for another year at the same rent.\n\nCould you let me know by November 15 whether you'd like to stay?\n\nBest,\nPriya" },
      ] },
      { id: 'bank', subject: 'New sign-in to your account', reason: 'Security alert on your bank account: check it was you', messages: [
        { from: 'Harbor Bank <alerts@bank.example>', at: ago(DAY + 6 * HOUR), labels: ['INBOX'], text: "We noticed a new sign-in to your account from Safari on macOS.\n\nIf this was you, there's nothing to do. If not, reset your password from the app right away." },
      ] },
      { id: 'trip', subject: 'Your trip to Lisbon: check-in opens tomorrow', messages: [
        { from: 'FlyAway <trips@flyaway.example>', at: ago(20 * MIN), labels: ['INBOX', 'UNREAD'], text: 'Check-in for your flight to Lisbon on Friday opens tomorrow at 08:00. Add your passport details now to skip the queue.' },
      ] },
      { id: 'weekly', subject: 'This week in design: 12 tools worth a look', messages: [
        { from: 'Design Weekly <newsletter@weekly.example>', at: ago(10 * MIN), labels: ['INBOX', 'UNREAD'], text: 'Twelve tools, three essays and one very good font. Read it in five minutes.' },
      ] },
    ],
    'demo-work': [
      { id: 'roadmap', subject: 'Q4 roadmap review: your slides by Wednesday?', reason: 'Your manager asks for your slides before Wednesday', messages: [
        { from: 'Morgan Lee <morgan.lee@acme.example>', at: ago(4 * HOUR), labels: ['INBOX', 'UNREAD'], text: "Hi Alex,\n\nFor Thursday's roadmap review, could you send me your three slides by Wednesday noon? Mostly the onboarding numbers and what's next.\n\nThanks,\nMorgan" },
      ] },
      { id: 'contract', subject: 'Contract redlines for the pilot', reason: 'Northwind wants your sign-off on two contract changes', messages: [
        { from: 'Dana Ortiz <dana@northwind.example>', at: ago(DAY), labels: ['INBOX'], text: 'Hi Alex,\n\nAttached are our redlines. Two changes: payment terms move to 45 days, and the pilot starts December 1. Can you confirm both work for you?\n\nDana' },
      ] },
      { id: 'sync', subject: 'Invitation: Design sync, Tue 14:00', messages: [
        { from: 'Acme Calendar <calendar@acme.example>', at: ago(15 * MIN), labels: ['INBOX', 'UNREAD'], text: 'Morgan Lee invited you to Design sync on Tuesday at 14:00.' },
      ] },
    ],
    'demo-studio': [
      { id: 'beta', subject: 'Feedback on the beta', messages: [
        { from: 'Riley Park <riley@example.net>', at: ago(2 * DAY), labels: ['INBOX', 'UNREAD'], text: 'Loved the beta! Two small things: the export button is hard to find, and dark mode forgets my choice.' },
      ] },
    ],
  };
  const LABELS = {
    'demo-personal': ['Family', 'Receipts', 'Travel'],
    'demo-work': ['Clients', 'Clients/Northwind', 'Hiring'],
    'demo-studio': ['Beta'],
  };

  /* ---------- the Gmail API, as mail.js reads it ---------- */
  const b64url = s => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function gmailThread(proxy, t) {
    return {
      id: t.id, historyId: '1',
      messages: t.messages.map((m, i) => {
        const from = m.from === 'me' ? ME[proxy] : m.from;
        const headers = [['From', from], ['To', m.to || ME[proxy]], ['Subject', t.subject], ['Message-ID', `<${t.id}-${i}@mail.example>`]];
        return {
          id: `${t.id}-${i}`, threadId: t.id, internalDate: String(m.at), labelIds: m.labels, snippet: m.text.replace(/\s+/g, ' ').slice(0, 140),
          payload: { mimeType: 'text/plain', headers: headers.map(([name, value]) => ({ name, value })), body: { data: b64url(m.text) } },
        };
      }),
    };
  }
  function gmail(proxy, path, method) {
    if (method !== 'GET') return {};
    const threads = THREADS[proxy] || [];
    const [route, query] = path.replace('/gmail/v1/users/me', '').split('?');
    if (route === '/profile') return { emailAddress: ACCOUNTS.find(a => a.proxy === proxy).address };
    if (route === '/labels') {
      return { labels: ['INBOX', 'STARRED', 'SENT', 'DRAFT', 'IMPORTANT', 'SPAM', 'TRASH'].map(id => ({ id, name: id, type: 'system' }))
        .concat(LABELS[proxy].map(name => ({ id: 'Label_' + slug(name), name, type: 'user' }))) };
    }
    if (route === '/threads') {
      const label = new URLSearchParams(query).get('labelIds');
      const hit = threads.filter(t => !label || t.messages.some(m => m.labels.includes(label)));
      return { threads: hit.map(t => ({ id: t.id, historyId: '1' })) };
    }
    const one = route.match(/^\/threads\/([^/]+)$/);
    const t = one && threads.find(x => x.id === one[1]);
    if (t) return gmailThread(proxy, t);
    return null;
  }

  /* ---------- what Email Triage left behind ---------- */
  function files() {
    const out = new Map([['artifacts/email-triage/config.json', JSON.stringify(CONFIG, null, 2)], ['artifacts/inbox/settings.json', JSON.stringify(SETTINGS)],
      /* The engine files the triage pane checks for, so the demo never shows the missing-engine banner. */
      ['triggers/inbox-triage/intents/triage.md', ''], ['knowhow/inbox-triage.md', '']]);
    for (const a of ACCOUNTS) {
      const s = slug(a.name), kept = (THREADS[a.proxy] || []).filter(t => t.reason);
      out.set(`artifacts/email-triage/state-${s}.json`, JSON.stringify({ last_run: iso(a.lastRun) }));
      out.set(`artifacts/email-triage/triage-${s}.json`, JSON.stringify({ triaged_at: iso(a.lastRun), emails: [] }));
      out.set(`artifacts/email-triage/notified-${s}.json`, JSON.stringify({ notified: [] }));
      out.set(`artifacts/email-triage/kept-${s}.json`, JSON.stringify({
        kept: kept.map(t => ({ id: `${t.id}-${t.messages.length - 1}`, thread_id: t.id, reason: t.reason, from: t.messages[t.messages.length - 1].from })),
      }));
    }
    return out;
  }
  const RUNS = [
    [35 * MIN, 'Personal', 'Personal: 1 needs you, 6 cleared', { actionable: 1, fyi: 2, noise: 4 }, ['Three newsletters from shop.example this week: a rule could delete them']],
    [50 * MIN, 'Work', 'Work: 1 needs you, 3 cleared', { actionable: 1, fyi: 3, noise: 0 }],
    [3 * HOUR + 35 * MIN, 'Personal', 'Personal: 1 needs you, 2 cleared', { actionable: 1, fyi: 1, noise: 1 }],
    [3 * HOUR + 50 * MIN, 'Work', 'Work: nothing needs you, 5 cleared', { actionable: 0, fyi: 4, noise: 1 }, ['Build notifications from ci.acme.example are always noise: mark them read with a rule']],
    [6 * HOUR + 35 * MIN, 'Personal', 'Personal: nothing needs you, 3 cleared', { actionable: 0, fyi: 1, noise: 2 }],
    [DAY + 35 * MIN, 'Personal', 'Personal: 2 need you, 4 cleared', { actionable: 2, fyi: 2, noise: 2 }],
    [3 * DAY, 'Side project', 'Side project: nothing needs you, 1 cleared', { actionable: 0, fyi: 1, noise: 0 }],
  ];
  const events = () => RUNS.map(([back, acc, summary, counts, notes], i) => ({
    id: 'demo-run-' + i, event_type: 'EmailTriageCompleted', created: iso(NOW - back),
    payload: Object.assign({ summary, account_results: { [acc]: counts } }, notes ? { run_notes: notes } : {}),
  }));
  const triggers = () => ACCOUNTS.map(a => ({
    id: 'demo-trg-' + slug(a.name), name: 'Email Triage — ' + a.name, cron_expressions: ['0 0 7-21 * * *'], paused: !!a.paused,
    next_run: a.paused ? null : iso(Math.ceil(NOW / HOUR) * HOUR), last_run_status: 'ok',
  })).concat([{ id: 'demo-trg-on-demand', name: 'Inbox — triage on demand', slug: 'inbox-triage-on-demand', cron_expressions: [], paused: false }]);

  /* ---------- AI: a canned answer per prompt ---------- */
  function aiText(system, user) {
    if (/summarize/i.test(system)) {
      return '• Jamie is hosting dinner on Saturday around 7 and needs a final headcount by Thursday.\n• Asks whether Sam is coming and about any allergies.\n• Would like you to bring dessert from the bakery on Elm Street.\nNeeds from you: confirm who is coming by Thursday and bring dessert.';
    }
    if (/copy editor/i.test(system)) return (user.split('The draft:\n')[1] || '').trim();
    if (/headcount/i.test(user)) {
      return "Hi Jamie,\n\nSam's coming too, so put us down for two. No allergies on our side.\n\nHappy to bring dessert, I'll grab something from the bakery on Elm Street. See you Saturday at 7!\n\nAlex";
    }
    return 'Hi,\n\nThanks for the note. I will get back to you by [day].\n\nAlex';
  }
  function aiReply(path, body) {
    const req = JSON.parse(body || '{}');
    const system = req.system || ((req.messages || []).find(m => m.role === 'system') || {}).content || '';
    const user = ((req.messages || []).filter(m => m.role === 'user').pop() || {}).content || '';
    const text = aiText(system, user);
    return path === '/chat/completions' ? { choices: [{ message: { content: text } }] } : { content: [{ type: 'text', text }] };
  }

  /* ---------- the fakes ---------- */
  function memStore() {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } };
  }
  function install() {
    const real = window.lucidos, store = files(), handlers = {};
    const json = (status, body) => { const s = body == null ? '' : JSON.stringify(body); return { ok: status < 400, status, text: async () => s, json: async () => JSON.parse(s) }; };
    const fire = (type, data) => (handlers[type] || []).forEach(fn => { try { fn(data); } catch (e) { /* listener bug */ } });
    const later = (fn, ms) => new Promise((resolve, reject) => setTimeout(() => { try { resolve(fn()); } catch (e) { reject(e); } }, ms || 120));
    window.lucidos = Object.assign({}, real, {
      data: {
        read: p => later(() => { if (store.has(p)) return store.get(p); throw new Error('not found: ' + p); }, 40),
        /* Kept in memory so an edited rule shows; the workspace's files are never touched. */
        write: (p, content) => later(() => { store.set(p, content); return { success: true }; }, 40),
      },
      events: {
        query: q => later(() => (!q || q.event_type === 'EmailTriageCompleted' ? events() : []), 40),
        /* Triage now gets a made-up result, so its spinner settles the way a real run's does. */
        emit: (type, payload) => {
          if (type === 'EmailTriageRequested' && payload && payload.account) {
            setTimeout(() => fire('EmailTriageCompleted', { payload: { summary: payload.account + ': nothing new needs you', account_results: { [payload.account]: { actionable: 0, fyi: 1, noise: 0 } } } }), 2500);
          }
          return later(() => ({ success: true }));
        },
      },
      triggers: { list: () => later(triggers, 40), update: () => later(() => ({ success: true })) },
      proxy: name => ({
        fetch: (path, init) => later(() => {
          const method = String((init && init.method) || 'GET').toUpperCase();
          if (!THREADS[name]) return json(200, aiReply(path, init && init.body));
          const body = gmail(name, path, method);
          return body ? json(200, body) : json(404, { error: { message: 'not in the demo' } });
        }, THREADS[name] ? 60 : 900),
      }),
      sse: { connect() {}, on: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); }, onOpen: fn => { setTimeout(fn, 0); }, off() {} },
      storage: { ready: Promise.resolve(), local: memStore(), session: memStore() },
      ui: Object.assign({}, real.ui, {
        startThread: () => real.ui.toast('Demo mode: this would start a Lucidos thread', 'info'),
      }),
    });
  }

  /* ---------- the views ---------- */
  function until(fn, ms) {
    return new Promise((resolve, reject) => {
      const end = Date.now() + (ms || 8000);
      (function poll() {
        const v = fn();
        if (v) resolve(v); else if (Date.now() > end) reject(new Error('demo: timed out')); else setTimeout(poll, 50);
      })();
    });
  }
  const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const q = sel => document.querySelector(sel);
  async function show(view) {
    await until(() => q('#list .row[data-key]') && !q('#list .sk-row'));
    if (view === 'triage') {
      const acc = slug(ACCOUNTS[0].name);
      if (!q(`[data-triage="${acc}"]`)) click(await until(() => q(`[data-folders="${acc}"]`)));
      click(await until(() => q(`[data-triage="${acc}"]`)));
      return;
    }
    if (view === 'all') { click(await until(() => q('[data-filter="all"]'))); return; }
    if (view !== 'open' && view !== 'reply') return;
    click(await until(() => q('#list .row[data-key="personal:dinner"]')));
    await until(() => q('#reader .msg-text'));
    if (view !== 'reply') return;
    click(await until(() => q('#reader [data-act="reply"]')));
    click(await until(() => q('[data-act="suggest"]')));
  }

  window.InboxDemo = { install, show };
  const m = /^#demo(?:\/([\w-]+))?$/.exec(location.hash);
  if (!m) return;
  install();
  addEventListener('DOMContentLoaded', () => { show(m[1] || 'inbox').catch(e => console.warn(e.message)); });
})();
