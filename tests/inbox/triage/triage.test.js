/* The Inbox's triage controls under jsdom: index.html with purify.min.js, mail.js, triage.js and app.js loaded,
 * lucidos.* stubbed. Writes, emits, trigger updates and non-GET proxy calls are recorded, never performed.
 *
 * fixtures/ holds a made-up workspace: three accounts (two Gmail, one password IMAP whose name contains another
 * account's), their cron triggers plus the shared on-demand and bridge triggers, and a few EmailTriageCompleted
 * payloads. config.json is written the way triage writes it (Python's json.dump, indent 2).
 *
 *   cd tests/inbox/triage && npm install && npm test */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP = path.resolve(__dirname, '../../../inbox/apps/inbox');
const CFG = 'artifacts/email-triage/config.json';
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const CONFIG = fixture('config.json');
const EVENTS = JSON.parse(fixture('events.json'));
const TRIGGERS = JSON.parse(fixture('triggers.json'));
const SCRIPTS = ['purify.min.js', 'demo.js', 'mail.js', 'triage.js', 'app.js'].map(f => fs.readFileSync(path.join(APP, f), 'utf8'));
const SETTINGS = JSON.stringify({ accounts: { 'Gmail - Personal': { proxy: 'gmail-personal' }, 'Gmail - Work': { proxy: 'gmail-work' } } });
const ADDRESS = { 'gmail-personal': 'me@example.com', 'gmail-work': 'work@example.org' };
const ACCOUNTS = ['personal', 'work', 'mailhost-work'];
/* The engine files Inbox ships; the triage pane warns when one is gone. */
const ENGINE = ['triggers/inbox-triage/intents/triage.md', 'knowhow/inbox-triage.md'];

/* Recorded values come from the jsdom realm; a JSON copy compares cleanly with this one. */
const clone = v => JSON.parse(JSON.stringify(v));
const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function memStore() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

/* One inbox thread in Gmail's metadata shape. */
function gmailThread(id, from, subject) {
  return {
    id, historyId: '1',
    messages: [{
      id: id + '-m1', threadId: id, internalDate: String(Date.now() - 3600e3), labelIds: ['INBOX', 'UNREAD'], snippet: subject,
      payload: { headers: [{ name: 'From', value: from }, { name: 'To', value: 'someone@example.com' }, { name: 'Subject', value: subject }] },
    }],
  };
}

async function boot(opts = {}) {
  const files = new Map([[CFG, opts.config || CONFIG], ['artifacts/inbox/settings.json', SETTINGS], ...ENGINE.map(p => [p, ''])]);
  for (const p of opts.drop || []) files.delete(p);
  for (const [p, text] of Object.entries(opts.files || {})) files.set(p, text);
  const triggers = (opts.triggers || (t => t))(JSON.parse(JSON.stringify(TRIGGERS)));
  const calls = [], toasts = [], sse = {};
  const inbox = opts.inbox || {};
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8').replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://lucidos.test/app/inbox/' });
  const w = dom.window;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.scrollTo = () => {};
  if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
  w.lucidos = {
    ui: {
      applyPreferences() {}, watchPreferences() {}, ready() {}, navigate() {}, startThread() {}, openExternal() {}, previewFile() {}, dismissToast() {},
      toast: (m, kind) => toasts.push({ m, kind }), confirm: async () => true, prompt: async () => null, enhanceSelects: () => [],
    },
    utils: { escapeHtml, escapeHtmlAttr: escapeHtml, timeAgo: () => 'a while ago', formatDate: t => String(t) },
    sse: { connect() {}, on: (type, fn) => (sse[type] = sse[type] || []).push(fn) },
    storage: { ready: Promise.resolve(), local: memStore(), session: memStore() },
    data: {
      read: async p => { if (files.has(p)) return files.get(p); throw new Error('not found: ' + p); },
      write: async (p, content) => { calls.push({ kind: 'data.write', path: p, content }); files.set(p, content); return { success: true }; },
    },
    events: {
      query: async q => (q.event_type === 'EmailTriageCompleted' ? JSON.parse(JSON.stringify(EVENTS)) : []),
      emit: async (type, payload) => { calls.push({ kind: 'events.emit', type, payload: clone(payload) }); return { success: true }; },
    },
    triggers: {
      list: async () => { if (opts.failList) throw new Error('refused'); return JSON.parse(JSON.stringify(triggers)); },
      update: async (id, patch) => {
        calls.push({ kind: 'triggers.update', id, patch: clone(patch) });
        if (opts.failTrigger) throw new Error('refused');
        Object.assign(triggers.find(t => t.id === id), patch);
        return { success: true };
      },
    },
    proxy: name => ({
      fetch: async (p, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        if (method !== 'GET') { calls.push({ kind: 'proxy', name, method, path: p }); return res(200, {}); }
        const rest = p.replace('/gmail/v1/users/me', ''), threads = inbox[name] || [];
        if (rest === '/profile') return res(200, { emailAddress: ADDRESS[name] });
        if (rest.startsWith('/threads?')) return res(200, { threads: threads.map(t => ({ id: t.id, historyId: t.historyId })) });
        const m = rest.match(/^\/threads\/([^?]+)\?format=metadata/);
        if (m) return res(200, threads.find(t => t.id === m[1]));
        if (rest === '/labels') return res(200, { labels: [{ id: 'STARRED', type: 'system' }, { id: 'SENT', type: 'system' }] });
        return res(404, { error: { message: 'no stub for ' + p } });
      },
    }),
  };
  for (const src of SCRIPTS) w.eval(src);
  const $ = sel => w.document.querySelector(sel);
  const click = el => { assert.ok(el, 'element to click exists'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
  const app = {
    w, $, click, calls, toasts, files, triggers,
    writes: () => calls.filter(c => c.kind === 'data.write' && c.path === CFG),
    emits: type => calls.filter(c => c.kind === 'events.emit' && c.type === type),
    async until(fn, what) {
      for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 10)); }
      throw new Error('timed out waiting for ' + what);
    },
    async openTriage(acc) {
      if (!$(`[data-triage="${acc}"]`)) click($(`[data-folders="${acc}"]`));
      click(await app.until(() => $(`[data-triage="${acc}"]`), `the ${acc} triage entry`));
      await app.until(() => $('#triage .tri-body .tri-sec'), 'the triage pane');
    },
    fire(type, payload) { (sse[type] || []).forEach(fn => fn(payload)); },
    async close() { await new Promise(r => setTimeout(r, 60)); w.close(); },
  };
  /* Ready once triage has loaded config for every account and the inbox has a live context. */
  await app.until(() => $('.tri-all .tri-dot') && $('.tri-all-sub') && !/All accounts$/.test($('.tri-all-sub').textContent) &&
    !$('#list .sk-row') && w.Mail.ORDER.length === ACCOUNTS.length, 'the app to load');
  return app;
}

const ruleIndex = (text, acc, pred) => JSON.parse(text).accounts[acc].rules.findIndex(pred);
/* Lines that differ between two texts of the same line count. */
function changedLines(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  assert.equal(y.length, x.length, 'same number of lines');
  return x.map((l, i) => [l, y[i]]).filter(([l, r]) => l !== r);
}

test('serializeLike round-trips config.json byte for byte', async () => {
  const app = await boot();
  try {
    const out = app.w.Triage.serializeLike(CONFIG, JSON.parse(CONFIG));
    assert.equal(out, CONFIG);
  } finally { await app.close(); }
});

test('sidebar has an All accounts strip and a Triage entry for every account', async () => {
  const app = await boot();
  try {
    const all = app.$('#side [data-triage="all"]');
    assert.ok(all, 'All accounts entry');
    assert.equal(all.querySelectorAll('.tri-dot').length, ACCOUNTS.length);
    for (const acc of ACCOUNTS) app.click(app.$(`[data-folders="${acc}"]`));
    for (const acc of ACCOUNTS) {
      const el = await app.until(() => app.$(`#side .mbx-folders [data-triage="${acc}"]`), acc);
      assert.match(el.textContent, /Triage/);
    }
    /* Opening one swaps the list for the pane, scoped to that account. */
    app.click(app.$('[data-triage="mailhost-work"]'));
    await app.until(() => app.$('#triage .tri-body .tri-sec'), 'pane');
    assert.ok(app.w.document.body.classList.contains('triage'));
    assert.match(app.$('#triage .eyebrow').textContent, /Mailhost - Work/);
    assert.match(app.$('#triage').textContent, /Rule chain/);
    /* The All accounts view: health for every account, suggestions and runs, no rule editor. */
    app.click(app.$('[data-triage="all"]'));
    await app.until(() => app.$('#triage .tri-card'), 'all view');
    assert.equal(app.$('#triage').querySelectorAll('.tri-card').length, ACCOUNTS.length);
    assert.match(app.$('#triage').textContent, /Suggestions from runs/);
    assert.match(app.$('#triage').textContent, /a rule could delete them/);
    assert.match(app.$('#triage').textContent, /Run history/);
    assert.doesNotMatch(app.$('#triage').textContent, /Rule chain/);
    assert.equal(app.$('#triage').querySelectorAll('.tri-run').length, EVENTS.length);
    /* Esc leaves the pane. */
    app.w.document.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await app.until(() => !app.w.document.body.classList.contains('triage'), 'pane closes');
  } finally { await app.close(); }
});

test('an unreachable rule is flagged under the rule that shadows it', async () => {
  const app = await boot();
  try {
    await app.openTriage('personal');
    const dead = app.$('#triage .tri-rule.dead');
    assert.ok(dead, 'a dimmed rule');
    assert.match(dead.textContent, /rule 2 already matches/);
  } finally { await app.close(); }
});

test('pause writes paused: true, pauses only that account\'s cron trigger, and resume restores the file exactly', async () => {
  const app = await boot();
  try {
    await app.openTriage('work');
    app.click(app.$('[data-t-pause="work"]'));
    const [w1] = await app.until(() => app.writes().length === 1 && app.writes(), 'pause write');
    const cfg = JSON.parse(w1.content);
    assert.equal(cfg.accounts['Gmail - Work'].paused, true);
    for (const n of ['Gmail - Personal', 'Mailhost - Work']) assert.equal('paused' in cfg.accounts[n], false, n);
    delete cfg.accounts['Gmail - Work'].paused;
    assert.equal(app.w.Triage.serializeLike(CONFIG, cfg), CONFIG, 'nothing else changed');
    await app.until(() => app.calls.some(c => c.kind === 'triggers.update'), 'trigger update');
    const ups = app.calls.filter(c => c.kind === 'triggers.update');
    /* "Inbox triage — Mailhost Work" also names Work, but belongs to the longer account name. */
    assert.deepEqual(ups.map(u => [TRIGGERS.find(t => t.id === u.id).name, u.patch]), [['Inbox triage — Work', { paused: true }]]);
    await app.until(() => /Paused/.test(app.$('[data-triage="work"]').textContent), 'sidebar shows paused');
    assert.ok(app.$('[data-t-run="work"]').disabled, 'Triage now is off while paused');

    app.click(app.$('[data-t-pause="work"]'));
    const w2 = await app.until(() => app.writes()[1], 'resume write');
    assert.equal(w2.content, CONFIG, 'resume deletes the key: the file is back byte for byte');
    await app.until(() => app.calls.filter(c => c.kind === 'triggers.update').length === 2, 'trigger resume');
    assert.deepEqual(app.calls.filter(c => c.kind === 'triggers.update')[1].patch, { paused: false });
  } finally { await app.close(); }
});

test('pause still finds a cron named the way setup named them before 1.0.0', async () => {
  const app = await boot({ triggers: list => list.map(t => (t.id === 'trg-work' ? Object.assign(t, { name: 'Email Triage — Work' }) : t)) });
  try {
    await app.openTriage('work');
    app.click(app.$('[data-t-pause="work"]'));
    await app.until(() => app.calls.some(c => c.kind === 'triggers.update'), 'trigger update');
    assert.deepEqual(app.calls.filter(c => c.kind === 'triggers.update').map(u => [u.id, u.patch]), [['trg-work', { paused: true }]]);
  } finally { await app.close(); }
});

test('pause all pauses every account but never the on-demand trigger', async () => {
  const app = await boot();
  try {
    await app.openTriage('all');
    app.click(app.$('[data-t-pause-all]'));
    const w1 = await app.until(() => app.writes()[0], 'write');
    const cfg = JSON.parse(w1.content);
    for (const n of Object.keys(cfg.accounts)) assert.equal(cfg.accounts[n].paused, true, n);
    await app.until(() => app.calls.filter(c => c.kind === 'triggers.update').length === 3, 'three trigger updates');
    const ids = app.calls.filter(c => c.kind === 'triggers.update').map(u => u.id).sort();
    assert.deepEqual(ids, ['trg-mailhost-work', 'trg-personal', 'trg-work']);
  } finally { await app.close(); }
});

test('a refused trigger update warns and keeps the config pause', async () => {
  const app = await boot({ failTrigger: true });
  try {
    await app.openTriage('personal');
    app.click(app.$('[data-t-pause="personal"]'));
    await app.until(() => app.toasts.some(t => t.kind === 'warning' && /couldn't pause the schedule for Personal/.test(t.m)), 'warning toast');
    assert.equal(JSON.parse(app.writes()[0].content).accounts['Gmail - Personal'].paused, true);
  } finally { await app.close(); }
});

test('pause re-reads config.json and keeps keys another writer added since load', async () => {
  const app = await boot();
  try {
    await app.openTriage('mailhost-work');
    const changed = JSON.parse(CONFIG);
    changed.accounts['Gmail - Personal'].added_elsewhere = 'keep me';
    app.files.set(CFG, app.w.Triage.serializeLike(CONFIG, changed));
    app.click(app.$('[data-t-pause="mailhost-work"]'));
    const w1 = await app.until(() => app.writes()[0], 'write');
    const cfg = JSON.parse(w1.content);
    assert.equal(cfg.accounts['Gmail - Personal'].added_elsewhere, 'keep me');
    assert.equal(cfg.accounts['Mailhost - Work'].paused, true);
  } finally { await app.close(); }
});

test('Triage now emits EmailTriageRequested with the payload the on-demand trigger matches, and the run releases the button', async () => {
  const app = await boot();
  try {
    await app.openTriage('work');
    app.click(app.$('[data-t-run="work"]'));
    await app.until(() => app.emits('EmailTriageRequested').length, 'emit');
    assert.deepEqual(app.emits('EmailTriageRequested').map(e => e.payload), [{ summary: 'Manual triage run for Work', account: 'Gmail - Work', source: 'inbox-app' }]);
    await app.until(() => app.$('[data-t-run="work"]').disabled, 'button busy');
    const done = EVENTS.find(e => Object.keys(e.payload.account_results || {}).join() === 'Gmail - Work');
    app.fire('EmailTriageCompleted', done.payload);
    await app.until(() => !app.$('[data-t-run="work"]').disabled, 'button released');

    await app.openTriage('mailhost-work');
    app.click(app.$('[data-t-run="mailhost-work"]'));
    await app.until(() => app.emits('EmailTriageRequested').length === 2, 'IMAP account emit');
    assert.deepEqual(app.emits('EmailTriageRequested')[1].payload, { summary: 'Manual triage run for Mailhost - Work', account: 'Mailhost - Work', source: 'inbox-app' });
  } finally { await app.close(); }
});

test('a rule edit saves config.json losslessly: one line changes, escapes and every other byte survive', async () => {
  const app = await boot();
  try {
    await app.openTriage('personal');
    /* A regex rule whose value holds non-ASCII, which the file stores as \u escapes. */
    const i = ruleIndex(CONFIG, 'Gmail - Personal', r => /[^\x00-\x7f]/.test(r.condition.value));
    assert.ok(i >= 0, 'fixture has a rule with non-ASCII in its value');
    assert.match(CONFIG, /\\u00e7/, 'fixture stores it escaped');
    const before = JSON.parse(CONFIG).accounts['Gmail - Personal'].rules[i];
    app.click(app.$(`[data-t-edit="${i}"]`));
    const input = await app.until(() => app.$('#t-ed-value'), 'editor');
    assert.equal(input.value, before.condition.value);
    assert.equal(app.$('#t-ed-action').value, before.action);
    input.value = before.condition.value + '|faktura';
    app.click(app.$('[data-t-save]'));
    const w1 = await app.until(() => app.writes()[0], 'write');

    const diff = changedLines(CONFIG, w1.content);
    assert.equal(diff.length, 1, 'exactly one line changed');
    assert.equal(diff[0][1], diff[0][0].replace(/"$/, '|faktura"'));
    const after = JSON.parse(w1.content).accounts['Gmail - Personal'].rules[i];
    assert.deepEqual(Object.keys(after), Object.keys(before), 'rule keys and their order kept');
    assert.equal(after._comment, before._comment);
    assert.deepEqual(Object.keys(after.condition), ['field', 'operator', 'value']);
    await app.until(() => !app.$('#t-ed-value'), 'editor closes');
  } finally { await app.close(); }
});

test('saving a rule unchanged writes nothing', async () => {
  const app = await boot();
  try {
    await app.openTriage('personal');
    app.click(app.$('[data-t-edit="0"]'));
    await app.until(() => app.$('#t-ed-value'), 'editor');
    app.click(app.$('[data-t-save]'));
    await app.until(() => !app.$('#t-ed-value'), 'editor closes');
    assert.equal(app.writes().length, 0);
  } finally { await app.close(); }
});

test('a new rule lands in sorted key order, and its reason reaches the inbox list without a reload', async () => {
  const app = await boot({ inbox: { 'gmail-work': [gmailThread('t-ci', 'CI Bot <ci@builds.example>', 'Build passed')] } });
  try {
    app.click(app.$('[data-filter="work"]'));
    const row = () => app.$('#list .row[data-key="work:t-ci"]');
    await app.until(row, 'the Work row');
    assert.match(row().textContent, /AI triage will decide/);

    await app.openTriage('work');
    app.click(app.$('[data-t-add]'));
    const input = await app.until(() => app.$('#t-ed-value'), 'editor');
    input.value = 'ci@builds.example';
    app.click(app.$('[data-t-save]'));
    const w1 = await app.until(() => app.writes()[0], 'write');
    const rules = JSON.parse(w1.content).accounts['Gmail - Work'].rules;
    assert.deepEqual(rules[rules.length - 1], { action: 'delete', condition: { field: 'from', operator: 'contains', value: 'ci@builds.example' } });
    assert.equal(JSON.stringify(Object.keys(rules[rules.length - 1])), '["action","condition"]');

    app.click(app.$('[data-filter="work"]'));
    await app.until(() => row() && /Your rules would delete it/.test(row().textContent), 'the new reason on the row');
    assert.equal(app.calls.filter(c => c.kind === 'proxy').length, 0, 'no mail was touched');
  } finally { await app.close(); }
});

/* A cron whose intent names a workspace file that is gone stops running. The app must say so rather than fail
 * silently. */
const banner = app => app.$('#side .tri-engine');
const cronIntent = (id, intent) => list => list.map(t => (t.id === id ? Object.assign(t, { run: { type: 'intent', intent } }) : t));

test('no engine banner when the engine and the on-demand trigger are in place', async () => {
  const app = await boot();
  try { assert.equal(banner(app), null); } finally { await app.close(); }
});

test('a missing engine file shows the banner in the sidebar and the triage pane', async () => {
  const app = await boot({ drop: ['triggers/inbox-triage/intents/triage.md'] });
  try {
    const b = await app.until(() => banner(app), 'the engine banner');
    assert.match(b.textContent, /Triage engine missing\. Run Inbox setup to repair\./);
    assert.match(b.textContent, /triggers\/inbox-triage\/intents\/triage\.md/);
    await app.openTriage('personal');
    assert.ok(app.$('#triage .tri-engine'));
  } finally { await app.close(); }
});

test('a missing on-demand trigger shows the banner', async () => {
  const app = await boot({ triggers: list => list.filter(t => t.id !== 'trg-on-demand') });
  try {
    assert.match((await app.until(() => banner(app), 'the engine banner')).textContent, /No trigger answers Triage now/);
  } finally { await app.close(); }
});

test('an on-demand trigger from another plugin does not count', async () => {
  const app = await boot({ triggers: list => list.map(t => (t.id === 'trg-on-demand' ? Object.assign(t, { name: 'Other \u2014 on demand', slug: 'other-on-demand' }) : t)) });
  try {
    assert.match((await app.until(() => banner(app), 'the engine banner')).textContent, /No trigger answers Triage now/);
  } finally { await app.close(); }
});

test('a cron naming a workspace file that is gone shows the banner for that account', async () => {
  const intent = 'Run the triage intent at data/triggers/old-triage/intents/triage.md for Gmail - Work.';
  const app = await boot({ triggers: cronIntent('trg-work', intent) });
  try {
    const b = await app.until(() => banner(app), 'the engine banner');
    assert.match(b.textContent, /Work's schedule runs triggers\/old-triage\/intents\/triage\.md, which is gone/);
    assert.doesNotMatch(b.textContent, /Personal/);
  } finally { await app.close(); }
});

test('a cron naming only files that exist shows no banner', async () => {
  const intent = 'Execute the email triage intent at triggers/inbox-triage/intents/triage.md for Gmail - Work. Read knowhow/inbox-triage.md, not system-knowhow/x.md.';
  const app = await boot({ triggers: cronIntent('trg-work', intent) });
  try { assert.equal(banner(app), null); } finally { await app.close(); }
});

test('a refused trigger list reports no trigger as missing', async () => {
  const app = await boot({ failList: true });
  try { assert.equal(banner(app), null); } finally { await app.close(); }
});
