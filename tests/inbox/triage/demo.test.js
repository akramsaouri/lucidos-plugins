/* The Inbox's demo mode under jsdom: the app opened at #demo… renders demo.js's made-up accounts and mail, and
 * never calls the workspace. Every lucidos.* call that could reach it is recorded here and must stay empty.
 *
 *   cd tests/inbox/triage && npm install && npm test */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP = path.resolve(__dirname, '../../../inbox/apps/inbox');
const SCRIPTS = ['purify.min.js', 'demo.js', 'mail.js', 'triage.js', 'app.js'].map(f => fs.readFileSync(path.join(APP, f), 'utf8'));
const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function boot(hash) {
  const live = [], toasts = [];
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8').replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://lucidos.test/app/inbox/' + hash });
  const w = dom.window;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.scrollTo = () => {};
  /* jsdom has no TextEncoder or TextDecoder; demo.js encodes its bodies and mail.js decodes them. */
  Object.assign(w, { TextEncoder, TextDecoder });
  /* Nor a modal <dialog>, which the reply composer opens in. */
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const record = name => (...args) => { live.push(name); return Promise.reject(new Error(name + ' called in demo mode')); };
  w.lucidos = {
    ui: {
      applyPreferences() {}, watchPreferences() {}, ready() {}, navigate() {}, openExternal() {}, previewFile() {}, dismissToast() {},
      startThread: record('ui.startThread'), toast: (m, kind) => toasts.push({ m, kind }), confirm: async () => true, prompt: async () => null, enhanceSelects: () => [],
    },
    utils: { escapeHtml, escapeHtmlAttr: escapeHtml, timeAgo: () => 'a while ago', formatDate: t => String(t) },
    sse: { connect: () => live.push('sse.connect'), on: () => live.push('sse.on'), onOpen: () => live.push('sse.onOpen') },
    storage: { ready: Promise.resolve(), local: { getItem: () => { live.push('storage.get'); return null; }, setItem: () => live.push('storage.set'), removeItem() {} } },
    data: { read: record('data.read'), write: record('data.write') },
    events: { query: record('events.query'), emit: record('events.emit') },
    triggers: { list: record('triggers.list'), update: record('triggers.update') },
    proxy: name => ({ fetch: record('proxy:' + name) }),
  };
  for (const src of SCRIPTS) w.eval(src);
  const $ = sel => w.document.querySelector(sel);
  const app = {
    w, $, live, toasts,
    async until(fn, what) {
      for (let i = 0; i < 300; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 10)); }
      throw new Error('timed out waiting for ' + what);
    },
    async close() { await new Promise(r => setTimeout(r, 60)); w.close(); },
  };
  await app.until(() => $('#list .row[data-key]') && !$('#list .sk-row'), 'the demo inbox');
  return app;
}

test('#demo renders made-up accounts in both zones and calls nothing live', async () => {
  const app = await boot('#demo');
  try {
    assert.deepEqual([...app.w.Mail.ORDER], ['personal', 'work', 'side-project']);
    const list = app.$('#list').textContent;
    assert.match(list, /Dinner Saturday/);
    assert.match(list, /needs an answer by Thursday/);
    assert.match(list, /Your trip to Lisbon/);
    assert.match(app.$('#count').textContent, /4 need you · 2 not triaged/);
    assert.equal(app.toasts.filter(t => t.kind === 'error').length, 0, JSON.stringify(app.toasts));
    assert.deepEqual(app.live, []);
  } finally { await app.close(); }
});

test('#demo/all merges every account newest first, tags each row and remembers the pick', async () => {
  const app = await boot('#demo/all');
  try {
    await app.w.InboxDemo.show('all');
    await app.until(() => app.$('#list .row-acct'), 'the account tags');
    assert.match(app.$('#count').textContent, /6 need you · 4 not triaged/);
    const side = [...app.w.document.querySelectorAll('#side [data-filter]')].map(b => b.dataset.filter);
    assert.deepEqual(side, ['all', 'personal', 'work', 'side-project']);
    assert.equal(app.$('#filters [data-filter]').dataset.filter, 'all');
    const kept = [...app.w.document.querySelectorAll('#list .sec:first-child .row')];
    assert.deepEqual(kept.map(r => r.dataset.key), ['personal:dinner', 'work:roadmap', 'personal:dentist', 'work:contract', 'personal:lease', 'personal:bank']);
    assert.deepEqual(kept.slice(0, 2).map(r => r.querySelector('.row-acct').textContent), ['Personal', 'Work']);
    assert.equal(app.w.lucidos.storage.local.getItem('inbox.filter'), 'all');
    /* All inboxes has no folders of its own. */
    assert.equal(app.$('#side .mbx-all [data-folders]'), null);
    assert.deepEqual(app.live, []);
  } finally { await app.close(); }
});

test('All inboxes archives through the row\'s own account, and one failing account leaves the rest', async () => {
  const app = await boot('#demo/all');
  try {
    await app.w.InboxDemo.show('all');
    await app.until(() => app.$('#list .row-acct'), 'the account tags');
    const real = app.w.lucidos.proxy, calls = [];
    app.w.lucidos.proxy = name => {
      const p = real(name);
      return { fetch: (path, init) => {
        calls.push([name, String((init && init.method) || 'GET').toUpperCase()]);
        if (name === 'demo-work' && app.w.failWork) return Promise.reject(new Error('token expired'));
        return p.fetch(path, init);
      } };
    };
    app.$('#list .row[data-key="work:roadmap"]').dispatchEvent(new app.w.MouseEvent('click', { bubbles: true }));
    await app.until(() => app.$('#reader [data-act="done"]'), 'the reader');
    calls.length = 0;
    app.$('#reader [data-act="done"]').dispatchEvent(new app.w.MouseEvent('click', { bubbles: true }));
    await app.until(() => calls.some(([, m]) => m !== 'GET'), 'the archive call');
    assert.deepEqual([...new Set(calls.filter(([, m]) => m !== 'GET').map(([n]) => n))], ['demo-work']);

    app.w.failWork = true;
    app.$('[data-act="refresh"]').dispatchEvent(new app.w.MouseEvent('click', { bubbles: true }));
    await app.until(() => /Work: not loaded/.test(app.$('#fresh').textContent), 'the quiet error');
    assert.ok(app.$('#side .mbx-all .mbx-err'));
    assert.ok(app.$('#list .row[data-key="personal:dinner"]'));
    assert.deepEqual(app.live, []);
  } finally { await app.close(); }
});

test('#demo/reply opens a conversation and drafts a reply with Suggest', async () => {
  const app = await boot('#demo/reply');
  try {
    await app.w.InboxDemo.show('reply');
    const body = await app.until(() => { const b = app.$('#c-body'); return b && /Sam's coming too/.test(b.value) && b; }, 'the suggested reply');
    assert.match(body.value, /Elm Street/);
    assert.match(app.$('#reader').textContent, /final headcount/);
    assert.deepEqual(app.live, []);
  } finally { await app.close(); }
});

test('#demo/triage shows the rule chain and run history, and its writes stay in memory', async () => {
  const app = await boot('#demo/triage');
  try {
    await app.w.InboxDemo.show('triage');
    await app.until(() => app.$('#triage .tri-body .tri-sec'), 'the triage pane');
    const pane = app.$('#triage').textContent;
    assert.match(pane, /Rule chain/);
    assert.match(pane, /Run history/);
    assert.match(pane, /a rule could delete them/);
    app.$('[data-t-pause="personal"]').dispatchEvent(new app.w.MouseEvent('click', { bubbles: true }));
    await app.until(() => app.toasts.some(t => /Paused Personal/.test(t.m)), 'the pause toast');
    assert.deepEqual(app.live, []);
  } finally { await app.close(); }
});

test('the inbox-glance widget with { demo: true } counts the demo mail and reads only the app\'s code', async () => {
  const GLANCE = path.resolve(APP, '../inbox-glance/index.html');
  const reads = [], live = [];
  const html = fs.readFileSync(GLANCE, 'utf8').replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://lucidos.test/app/inbox-glance/', beforeParse(w) {
    Object.assign(w, { TextEncoder, TextDecoder, ResizeObserver: class { observe() {} disconnect() {} } });
    const record = name => () => { live.push(name); return Promise.reject(new Error(name + ' called in demo mode')); };
    w.lucidos = {
      params: () => ({ demo: true }),
      ui: { applyPreferences() {}, watchPreferences() {}, ready() {}, navigate() {}, toast() {} },
      utils: { escapeHtml, escapeHtmlAttr: escapeHtml, timeAgo: () => 'just now' },
      widget: { visible: () => true, size: () => 'large', onSize() {}, onVisibility() {} },
      sse: { connect: record('sse.connect'), on: record('sse.on'), onOpen: record('sse.onOpen') },
      storage: { ready: Promise.resolve(), local: { getItem: () => { live.push('storage.get'); return null; }, setItem: () => live.push('storage.set') } },
      /* The widget reads the Inbox app's own scripts; anything else would be the workspace's data. */
      data: { read: async p => { reads.push(p); if (/^apps\/inbox\/(demo|mail)\.js$/.test(p)) return fs.readFileSync(path.join(APP, path.basename(p)), 'utf8'); live.push('data.read ' + p); throw new Error('not found'); } },
      events: { query: record('events.query'), emit: record('events.emit') },
      triggers: { list: record('triggers.list') },
      proxy: name => ({ fetch: record('proxy:' + name) }),
    };
  } });
  const w = dom.window, $ = id => w.document.getElementById(id);
  try {
    for (let i = 0; i < 300 && $('n').textContent === '–'; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal($('n').textContent, '6');
    assert.equal($('sub').textContent, '4 not triaged yet');
    assert.match($('rows').textContent, /Dinner Saturday/);
    assert.deepEqual(reads.sort(), ['apps/inbox/demo.js', 'apps/inbox/mail.js']);
    assert.deepEqual(live, []);
  } finally { await new Promise(r => setTimeout(r, 60)); w.close(); }
});
