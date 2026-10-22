/* Triage controls, ported from the Email Triage control panel: health and next run, pause/resume, Triage now, the
 * rule chain editor with dead-rule detection, suggestions from runs, and run history. app.js owns the routing (which
 * scope is open, the sidebar around the entries); this module owns the triage state, the entries' HTML and the pane.
 *
 * Reads (never scans a mailbox: the triage triggers own that):
 *   artifacts/email-triage/config.json             accounts + rule chains (written here, see saveConfig)
 *   artifacts/email-triage/{triage,state,notified}-<slug>.json   last triage, fetch state, push ledger
 *   EmailTriageCompleted events                    run history + run_notes suggestions
 *   the workspace triggers                         each account's `Email Triage — <Account>` cron trigger
 * See knowhow/triage.md for the invariants. */
(function () {
  'use strict';
  const M = window.Mail;
  const A = M.ACCOUNTS;
  const CFG = 'artifacts/email-triage/config.json';
  /* Every action the config schema knows. A rule whose action, field or operator is missing here still offers it in
   * the editor, so opening a rule and saving it can never quietly change it. */
  const ACTIONS = ['skip', 'read', 'archive', 'delete', 'todo', 'calendar', 'notion', 'label', 'notify', 'flag', 'triage'];
  const FIELDS = ['from', 'to', 'cc', 'subject', 'body'];
  const OPERATORS = ['contains', 'equals', 'regex'];
  /* What triage does with mail it decides needs no action (FYI or noise), phrased as the outcome. */
  const CLEAR_MODES = [
    { value: 'archive', label: 'Archive it' },
    { value: 'read', label: 'Mark it read' },
    { value: 'delete', label: 'Move it to Trash' },
    { value: 'keep', label: 'Leave it alone' },
  ];
  const RUN_WINDOW_DAYS = 14, RUNS_PER_PAGE = 15;
  const RUN_TIMEOUT_MS = 300000; // 5 min: an AI triage pass over a full inbox is slow

  const esc = s => lucidos.utils.escapeHtml(String(s == null ? '' : s));
  const attr = s => lucidos.utils.escapeHtmlAttr(String(s == null ? '' : s));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const timeAgo = t => lucidos.utils.timeAgo(t);
  const ICONS = {
    filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
    pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    bulb: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    fall: '<path d="m15 10 5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    chevD: '<path d="m6 9 6 6 6-6"/>',
  };
  const ic = n => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
  const SPINNER = '<span class="mini-spinner" style="--spinner-color: currentColor" aria-hidden="true"></span>';
  const initial = s => { const m = String(s || '').match(/[\p{L}\p{N}]/u); return m ? m[0].toUpperCase() : '•'; };

  const T = {
    config: null, err: null, loaded: false, info: {}, runs: [], triggers: [],
    scope: null, editing: null, runPage: 0, lastHtml: '',
  };
  let host = { el: null, refresh() {}, onConfig() {} };

  /* ---------- accounts ---------- */
  const cfgName = acc => A[acc].cfg;
  /* "Gmail - Personal" -> "Personal". Config keys carry the provider prefix; the UI doesn't. */
  const shortName = name => String(name).replace(/^Gmail\s*-\s*/i, '');
  const accOf = name => M.ORDER.find(k => A[k].cfg === name) || null;
  const block = acc => (T.config && T.config.accounts && T.config.accounts[cfgName(acc)]) || null;
  const isPaused = acc => { const b = block(acc); return !!b && b.paused === true; };
  /* The account's own cron trigger, by name (Mail.triggerFor: the matcher loadContext uses). The shared on-demand
   * trigger has no cron and serves every account, so it is never paused per account. */
  const triggerOf = acc => M.triggerFor(cfgName(acc), T.triggers, M.ORDER.map(cfgName)) || null;
  /* The account's colour slot, which index.html's [data-acct] rules read. */
  const slot = acc => (A[acc] || {}).slot || '';

  /* ---------- manual runs ----------
   * A manual run is fire-and-forget: the only completion signal is the run's own EmailTriageCompleted, which may
   * never come (the trigger is queued, Gmail is down, the run failed before it emitted). So each in-flight run
   * carries a give-up timer. One entry per account, since "Triage all" runs finish minutes apart. */
  const running = new Map(); // acc -> timeout id
  function startRun(acc) {
    clearTimeout(running.get(acc));
    running.set(acc, setTimeout(() => {
      running.delete(acc);
      host.refresh();
      lucidos.ui.toast(`No result came back for ${A[acc].label}: the run may still be queued`, 'warning', { key: `run-${acc}` });
    }, RUN_TIMEOUT_MS));
  }
  function finishRun(acc) {
    if (!running.has(acc)) return false;
    clearTimeout(running.get(acc));
    running.delete(acc);
    return true;
  }

  /* Which accounts a run touched. Most payloads carry `account_results` keyed by config name; a few no-op runs carry
   * only a summary, so fall back to name-matching rather than lose them from an account's history. */
  function accountsInPayload(p) {
    const keys = Object.keys((p && p.account_results) || {});
    if (keys.length) return keys.map(accOf).filter(Boolean);
    const hay = `${(p && p.summary) || ''} ${(p && p.run && p.run.trigger) || ''}`.toLowerCase();
    return M.ORDER.filter(a => hay.includes(shortName(cfgName(a)).toLowerCase()));
  }

  /* ---------- cron ---------- */
  /* A 6-field cron as something a human can scan. Falls back to raw. */
  function cronLabel(expr) {
    const p = String(expr).trim().split(/\s+/);
    if (p.length !== 6) return expr;
    const [, min, hour, , , dow] = p;
    const days = dow === '*' ? 'daily' : dow === '1-5' ? 'weekdays' : `dow ${dow}`;
    const mm = min === '*' ? '00' : String(min).padStart(2, '0');
    if (/^\d+$/.test(hour)) return `${days} at ${String(hour).padStart(2, '0')}:${mm}`;
    const range = hour.match(/^(\d+)-(\d+)$/);
    if (range) return `${days}, hourly ${range[1]}:${mm}–${range[2]}:${mm}`;
    return `${days}, ${hour}:${mm}`;
  }
  /* Next fire time across a set of cron expressions, by minute-stepping up to eight days ahead. */
  function cronNext(exprs) {
    const parsed = exprs.map(e => String(e).trim().split(/\s+/)).filter(p => p.length === 6);
    if (!parsed.length) return null;
    const matches = (vals, n) => vals.split(',').some(part => {
      if (part === '*') return true;
      const step = part.match(/^(\*|\d+-\d+)\/(\d+)$/);
      if (step) {
        const [lo, hi] = step[1] === '*' ? [0, 59] : step[1].split('-').map(Number);
        return n >= lo && n <= hi && (n - lo) % Number(step[2]) === 0;
      }
      const range = part.match(/^(\d+)-(\d+)$/);
      if (range) return n >= Number(range[1]) && n <= Number(range[2]);
      return Number(part) === n;
    });
    const cur = new Date();
    cur.setSeconds(0, 0);
    for (let i = 1; i <= 60 * 24 * 8; i++) {
      const t = new Date(cur.getTime() + i * 60000);
      if (parsed.some(p => matches(p[1], t.getMinutes()) && matches(p[2], t.getHours()) && matches(p[3], t.getDate()) &&
          matches(p[4], t.getMonth() + 1) && (p[5] === '*' || matches(p[5], t.getDay())))) return t;
    }
    return null;
  }
  const clockOf = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function untilLabel(d) {
    if (!d) return '—';
    const mins = Math.round((d - Date.now()) / 60000);
    if (mins < 1) return 'any moment';
    if (mins < 60) return `${clockOf(d)} · in ${mins}m`;
    return `${clockOf(d)} · in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  }
  /* The cron that actually fires is the trigger's; the config's `schedule` is the fallback when there is none. */
  const crons = acc => { const t = triggerOf(acc), b = block(acc); return t ? t.cron_expressions : [].concat((b && b.schedule) || []); };
  function nextRunOf(acc) {
    const t = triggerOf(acc);
    if (t && t.paused) return null;
    if (t && t.next_run) { const d = new Date(t.next_run); if (!isNaN(d)) return d; }
    return cronNext(crons(acc));
  }
  function lastRunOf(acc) {
    const i = T.info[acc] || {};
    const ev = T.runs.find(e => accountsInPayload(e.payload).includes(acc));
    const times = [i.triagedAt, i.stateRun, ev && ev.created].filter(Boolean).map(x => Date.parse(x)).filter(n => !isNaN(n));
    return times.length ? Math.max(...times) : null;
  }

  /* One word for the sidebar and the summary: what this account's triage is doing right now. */
  function health(acc) {
    const t = triggerOf(acc);
    if (!block(acc)) return { key: 'missing', text: 'Not configured' };
    if (isPaused(acc)) return { key: 'paused', text: 'Paused' };
    if (running.has(acc)) return { key: 'running', text: 'Triaging…' };
    if (t && t.paused) return { key: 'warn', text: 'Schedule paused' };
    if (t && t.last_run_status && !/^(ok|success|succeeded|running|queued|skipped)$/i.test(t.last_run_status)) return { key: 'warn', text: `Last run ${t.last_run_status}` };
    return { key: 'ok', text: 'Active' };
  }

  /* ---------- dead-rule detection ----------
   * First match wins, so a broad rule shadows every narrower rule below it on the same field. */
  function shadowedBy(rules, i) {
    const c = rules[i] && rules[i].condition;
    if (!c) return null;
    for (let j = 0; j < i; j++) {
      const p = rules[j] && rules[j].condition;
      if (!p || p.field !== c.field) continue;
      if (p.operator === 'contains' && (c.operator === 'contains' || c.operator === 'regex') &&
          String(c.value).toLowerCase().includes(String(p.value).toLowerCase())) return j;
      if (p.operator === c.operator && String(p.value) === String(c.value)) return j;
    }
    return null;
  }
  const deadCount = rules => rules.reduce((n, _, i) => n + (shadowedBy(rules, i) !== null ? 1 : 0), 0);

  /* ---------- config.json, written losslessly ----------
   * Every triage run reads this file, so a save rewrites it in the style it already has (indent, \u escapes and
   * their case, line endings, trailing newline) and leaves it alone when the edit changed nothing. Email
   * Triage writes it with Python's json.dump(indent=2): ASCII-only with lowercase escapes, no trailing newline. */
  function jsonStyle(text) {
    const m = /^[{[]\r?\n([ \t]+)/.exec(text);
    const escs = text.match(/\\u[0-9a-fA-F]{4}/g) || [];
    return {
      indent: m ? m[1] : (/\n/.test(text) ? 2 : 0),
      ascii: !/[^\x00-\x7f]/.test(text),
      upper: escs.some(e => /[A-F]/.test(e)) && !escs.some(e => /[a-f]/.test(e)),
      crlf: /\r\n/.test(text),
      tail: /(\r?\n)*$/.exec(text)[0],
    };
  }
  function serializeLike(original, obj) {
    const st = jsonStyle(String(original || ''));
    let s = JSON.stringify(obj, null, st.indent);
    if (st.ascii) s = s.replace(/[\u007f-\uffff]/g, ch => { const h = ch.charCodeAt(0).toString(16).padStart(4, '0'); return '\\u' + (st.upper ? h.toUpperCase() : h); });
    if (st.crlf) s = s.replace(/\n/g, '\r\n');
    return s + st.tail;
  }
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const rulesIn = (cfg, acc) => ((((cfg && cfg.accounts) || {})[cfgName(acc)] || {}).rules) || [];

  /* Re-reads the file and applies `mutate` to what is on disk now, so a key another writer added since this view
   * loaded survives. A rule edit is by index, so it refuses when that account's chain changed underneath it.
   * Returns true when the file holds the change (written, or already identical). */
  async function saveConfig(mutate, message, guardAcc) {
    let text, cfg;
    try { text = await lucidos.data.read(CFG); cfg = JSON.parse(text); } catch (e) {
      lucidos.ui.toast(`Could not read config.json: ${e.message}`, 'error');
      return false;
    }
    if (guardAcc && !same(rulesIn(cfg, guardAcc), rulesIn(T.config, guardAcc))) {
      lucidos.ui.toast(`${A[guardAcc].label}'s rules changed in config.json since this view loaded. Reloaded them: try again.`, 'warning', { key: 'cfg-stale' });
      await load();
      return false;
    }
    const before = JSON.stringify(cfg);
    mutate(cfg);
    if (JSON.stringify(cfg) !== before) {
      try { await lucidos.data.write(CFG, serializeLike(text, cfg)); } catch (e) {
        lucidos.ui.toast(`Could not save: ${e.message}`, 'error');
        await load();
        return false;
      }
      lucidos.ui.toast(message, 'success');
    }
    T.config = cfg;
    host.onConfig(cfg, T.triggers);
    host.refresh();
    return true;
  }

  /* ---------- load ---------- */
  async function readJson(path) {
    try { return JSON.parse(await lucidos.data.read(path)); } catch (e) { return null; }
  }
  let loading = null;
  function load() {
    if (loading) return loading;
    loading = (async () => {
      /* Fetch runs by time, not by count: a few accounts running hourly fill a flat limit in days. */
      const since = new Date(Date.now() - RUN_WINDOW_DAYS * 864e5).toISOString();
      const [text, runs, triggers] = await Promise.all([
        lucidos.data.read(CFG).catch(() => null),
        lucidos.events.query({ event_type: 'EmailTriageCompleted', since, limit: 200 }).catch(() => []),
        /* Best-effort: pausing the cron trigger is a second layer, so a refused list still leaves a working pause. */
        lucidos.triggers.list().catch(() => []),
      ]);
      try { T.config = text ? JSON.parse(text) : null; T.err = text ? null : 'config.json is missing'; } catch (e) { T.config = null; T.err = 'config.json does not parse: ' + e.message; }
      T.runs = (runs || []).slice().sort((x, y) => Date.parse(y.created) - Date.parse(x.created));
      T.triggers = triggers || [];
      await Promise.all(M.ORDER.map(async acc => {
        const slug = A[acc].slug;
        const [triage, ledger, st] = await Promise.all(['triage', 'notified', 'state'].map(k => readJson(`artifacts/email-triage/${k}-${slug}.json`)));
        T.info[acc] = { triagedAt: triage && triage.triaged_at, stateRun: st && st.last_run, ledger: ((ledger && ledger.notified) || []).length };
      }));
      T.loaded = true;
      if (T.config) host.onConfig(T.config, T.triggers);
    })().finally(() => { loading = null; host.refresh(); });
    return loading;
  }

  /* ---------- pause / resume ----------
   * `paused: true` in the account's config block is the source of truth: the intent both callers run (the cron
   * trigger and the on-demand one behind Triage now) reads it, so one switch stops both. Resume deletes the key,
   * never writes false. Pausing the cron trigger as well only saves a run that would read the flag and exit, so it
   * is best-effort: a failure warns and the config change stands. */
  async function setPaused(accs, paused) {
    const targets = accs.filter(a => block(a) && isPaused(a) !== paused);
    if (!targets.length) return;
    /* A paused account's run will never arrive: drop its spinner now. */
    if (paused) targets.forEach(finishRun);
    const verb = paused ? 'Paused' : 'Resumed';
    const what = targets.length === 1 ? A[targets[0]].label : `${targets.length} accounts`;
    const saved = await saveConfig(cfg => {
      for (const a of targets) {
        const b = cfg.accounts && cfg.accounts[cfgName(a)];
        if (!b) continue;
        if (paused) b.paused = true; else delete b.paused;
      }
    }, `${verb} ${what}`);
    /* The write failed and was reloaded: pausing the schedule now would leave the two halves disagreeing. */
    if (!saved) return;
    const stuck = [];
    for (const a of targets) {
      const t = triggerOf(a);
      if (!t || t.paused === paused) continue;
      try {
        const res = await lucidos.triggers.update(t.id, { paused });
        if (!res || !res.success) stuck.push(A[a].label);
      } catch (e) { stuck.push(A[a].label); }
    }
    if (stuck.length) {
      lucidos.ui.toast(`${verb} in config, but couldn't ${paused ? 'pause' : 'resume'} the schedule for ${stuck.join(', ')}: the run will start and exit instead`, 'warning', { key: 'pause-trigger' });
    }
    await load();
  }

  /* ---------- Triage now ----------
   * An iframe can't read a mailbox, so it asks: EmailTriageRequested, one per account, and the "Email Triage — on
   * demand" trigger runs the same intent the cron triggers run. The payload (and its `source: "email-triage-app"`) is
   * the one the old Email Triage app sent, so the on-demand trigger keeps matching it. */
  async function requestRun(accs) {
    const fresh = accs.filter(a => block(a) && !isPaused(a) && !running.has(a));
    if (!fresh.length) return;
    fresh.forEach(startRun);
    host.refresh();
    const failed = [];
    for (const a of fresh) {
      const name = cfgName(a);
      try {
        await lucidos.events.emit('EmailTriageRequested', { summary: `Manual triage run for ${shortName(name)}`, account: name, source: 'email-triage-app' });
      } catch (e) { finishRun(a); failed.push(A[a].label); }
    }
    if (failed.length) {
      host.refresh();
      lucidos.ui.toast(`Could not start triage for ${failed.join(', ')}`, 'error', { key: 'run-fail' });
    }
  }

  /* ---------- sidebar entries ---------- */
  function sideSub(acc) {
    const h = health(acc);
    if (h.key !== 'ok') return h.text;
    const n = nextRunOf(acc);
    return n ? clockOf(n) : 'No schedule';
  }
  /* The account's Triage entry, first in its folded group. */
  function sideEntryHtml(acc, sel) {
    const h = T.loaded ? health(acc) : { key: 'ok' };
    const sub = T.loaded ? sideSub(acc) : '';
    return `<button class="fold tri-fold${sel ? ' sel' : ''}" data-triage="${acc}"${sel ? ' aria-current="page"' : ''} data-health="${h.key}">${ic('filter')}<span class="fold-name">Triage</span>` +
      (sub ? `<span class="fold-n tri-sub">${h.key === 'running' ? SPINNER : ''}${esc(sub)}</span>` : '') + '</button>';
  }
  /* The All accounts strip at the top of the sidebar: one dot per account, coloured by account, hollow when paused. */
  function sideAllHtml(sel) {
    let sub = '';
    if (T.err) sub = 'config.json unreadable';
    else if (T.loaded) {
      const hs = M.ORDER.map(health);
      const paused = hs.filter(h => h.key === 'paused').length, warn = hs.filter(h => h.key === 'warn').length, busy = running.size;
      const next = M.ORDER.filter(a => health(a).key === 'ok').map(nextRunOf).filter(Boolean).sort((x, y) => x - y)[0];
      sub = [busy ? `${busy} triaging` : '', paused ? `${paused} paused` : '', warn ? `${warn} need a look` : '', !paused && !warn && !busy ? 'All active' : '',
        next ? `next ${clockOf(next)}` : ''].filter(Boolean).join(' · ');
    }
    const dots = M.ORDER.map(a => { const h = T.loaded ? health(a).key : 'ok'; return `<span class="tri-dot" data-acct="${slot(a)}" data-health="${h}" aria-label="${attr(A[a].label + ': ' + (T.loaded ? health(a).text : ''))}"></span>`; }).join('');
    return `<button class="tri-all${sel ? ' sel' : ''}" data-triage="all"${sel ? ' aria-current="page"' : ''}>
      <span class="tri-all-ic">${ic('filter')}</span>
      <span class="tri-all-text"><span class="tri-all-name">Triage</span><span class="tri-all-sub">${esc(sub || 'All accounts')}</span></span>
      <span class="tri-dots">${dots}</span>
    </button>`;
  }

  /* ---------- the pane ---------- */
  const pill = (cls, body) => `<span class="label pill ${cls}">${body}</span>`;
  function statusPills(acc) {
    const h = health(acc), last = lastRunOf(acc);
    return [
      h.key === 'paused' ? pill('label-warning', ic('pause') + 'Paused')
        : h.key === 'running' ? pill('', SPINNER + 'Triaging…')
        : h.key === 'warn' ? pill('label-warning', ic('alert') + esc(h.text))
        : pill('label-success', '<span class="pill-dot"></span>Active'),
      h.key === 'paused' ? '' : pill('label-neutral', ic('clock') + 'Next ' + esc(untilLabel(nextRunOf(acc)))),
      pill('label-neutral', 'Triaged ' + (last ? esc(timeAgo(new Date(last).toISOString())) : '—')),
    ].join('');
  }
  function accountButtons(acc, primary) {
    const off = isPaused(acc), busy = running.has(acc);
    return `<button class="action-btn action-btn-secondary btn-ic" data-t-pause="${acc}" data-tooltip="${off ? 'Resume: its schedule starts firing again' : 'Stop triage for this account, on a schedule or on demand. Mail is left untouched.'}">${ic(off ? 'play' : 'pause')}${off ? 'Resume' : 'Pause'}</button>` +
      `<button class="action-btn${primary ? '' : ' action-btn-secondary'} btn-ic" data-t-run="${acc}" ${busy || off ? 'disabled' : ''} data-tooltip="${off ? 'Paused: resume to triage it' : "Run this account's triage now, without waiting for its schedule"}">${busy ? SPINNER + 'Triaging…' : 'Triage now'}</button>`;
  }
  const section = (title, n, hint, body, extra) => `<section class="tri-sec">
      <div class="tri-sec-head"><h2 class="title">${esc(title)}</h2>${n != null ? `<span class="sec-n">${n}</span>` : ''}${extra || ''}${hint ? `<span class="tri-hint">${esc(hint)}</span>` : ''}</div>
      ${body}
    </section>`;

  function headHtml(scope, tap) {
    const all = scope === 'all';
    let sub;
    if (all) {
      const last = T.runs[0], who = last && accountsInPayload(last.payload)[0];
      sub = `${M.ORDER.length} accounts` + (last ? ` · last run ${who ? A[who].label + ' ' : ''}${timeAgo(last.created)}` : '');
    } else sub = block(scope) ? `${A[scope].address}${isPaused(scope) ? ' · paused' : ''}` : A[scope].address;
    const inner = `<span class="eyebrow"${all ? '' : ` data-acct="${slot(scope)}"`}>${all ? ic('filter') : '<span class="adot"></span>'}<span class="eyebrow-text">${esc(all ? 'All accounts' : A[scope].label)}</span>${tap ? ic('chevD') : ''}</span>` +
      `<span class="title-line"><span class="title app-title" role="heading" aria-level="1">Triage</span><span class="top-count">${esc(sub)}</span></span>`;
    return `<header class="top"><div class="top-row">${tap ? `<button class="view-title" data-act="mbx-open" aria-haspopup="true" data-tooltip="Mailboxes and folders" data-tooltip-below>${inner}</button>` : `<div class="view-title">${inner}</div>`}</div>` +
      `<div class="folder-bar"><button class="accent-link" data-act="triage-exit">← ${esc(all ? 'Inbox' : A[scope].label + ' inbox')}</button></div></header>`;
  }

  function overviewAll() {
    const active = M.ORDER.filter(a => block(a) && !isPaused(a));
    const allOff = M.ORDER.some(block) && !active.length;
    const rows = M.ORDER.map(a => {
      const b = block(a);
      if (!b) return `<div class="tri-card" data-acct="${slot(a)}"><span class="chip" aria-hidden="true">${esc(initial(A[a].label))}</span><div class="tri-card-main"><div class="tri-card-title"><b>${esc(A[a].label)}</b></div><div class="tri-meta">Not in config.json</div></div></div>`;
      const clear = b.no_action_clear || 'legacy', rules = b.rules || [], dead = deadCount(rules);
      const meta = [crons(a).map(cronLabel).join(' · ') || 'no schedule', `clears: ${clear}`, plural(rules.length, 'rule'), dead ? `${dead} unreachable` : '', `${(T.info[a] || {}).ledger || 0} in notify ledger`].filter(Boolean);
      return `<div class="tri-card${isPaused(a) ? ' is-paused' : ''}" data-acct="${slot(a)}">
        <span class="chip" aria-hidden="true">${esc(initial(A[a].label))}</span>
        <div class="tri-card-main">
          <div class="tri-card-title"><button class="accent-link tri-name" data-triage="${a}">${esc(A[a].label)}</button><span class="muted">${esc(b.address || A[a].address)}</span></div>
          <div class="tri-pills">${statusPills(a)}</div>
          <div class="tri-meta">${meta.map(m => `<span${/unreachable|clears: delete/.test(m) ? ' class="warn"' : ''}>${esc(m)}</span>`).join('')}</div>
          <div class="button-group">${accountButtons(a, false)}</div>
        </div>
      </div>`;
    }).join('');
    const actions = `<div class="button-group tri-actions">
      <button class="action-btn action-btn-secondary btn-ic" data-t-pause-all data-tooltip="${allOff ? 'Resume every account' : 'Stop every account being triaged, on a schedule or on demand'}">${ic(allOff ? 'play' : 'pause')}${allOff ? 'Resume all' : 'Pause all'}</button>
      <button class="action-btn btn-ic" data-t-run-all ${running.size || !active.length ? 'disabled' : ''} data-tooltip="${active.length ? 'Run every unpaused account’s triage now, in parallel' : 'Every account is paused'}">${running.size ? `${SPINNER}Triaging ${plural(running.size, 'account')}…` : 'Triage all accounts'}</button>
    </div>`;
    return section('Health', null, null, actions + `<div class="tri-group">${rows}</div>`);
  }

  function overviewOne(acc) {
    const b = block(acc);
    if (!b) return section('Health', null, null, `<div class="list-empty"><div class="title">${esc(A[acc].label)} isn't in config.json</div><div class="muted">Triage has no block for “${esc(cfgName(acc))}”.</div></div>`);
    const off = isPaused(acc), rules = b.rules || [], dead = deadCount(rules), last = lastRunOf(acc);
    const clear = b.no_action_clear || 'legacy';
    const clearLabel = (CLEAR_MODES.find(m => m.value === clear) || {}).label || clear;
    const status = statusPills(acc) + [
      b.shared ? pill('label-neutral', 'Shared') : '',
      b.no_auto_delete ? pill('label-success', 'No auto-delete') : '',
      pill(clear === 'delete' ? 'label-warning' : 'label-neutral', 'Clears: ' + esc(clear)),
    ].join('');
    const t = triggerOf(acc);
    return section('Health', null, null, `
      <div class="tri-pills">${status}</div>
      <div class="button-group tri-actions">${accountButtons(acc, true)}</div>
      <dl class="tri-details">
        <div><dt>Schedule</dt><dd>${esc(crons(acc).map(cronLabel).join(' · ') || '—')}${t ? '' : ' <span class="muted">(no cron trigger found)</span>'}</dd></div>
        <div><dt>Next run</dt><dd>${off ? 'paused' : esc(untilLabel(nextRunOf(acc)))}</dd></div>
        <div><dt>Last triaged</dt><dd>${last ? esc(timeAgo(new Date(last).toISOString())) : '—'}</dd></div>
        <div><dt>Notify ledger</dt><dd>${(T.info[acc] || {}).ledger || 0} ids</dd></div>
        <div><dt>No-action mail</dt><dd>${esc(clearLabel)}</dd></div>
        <div><dt>Rule chain</dt><dd>${plural(rules.length, 'rule')}${dead ? ` <span class="warn">${dead} unreachable</span>` : ''}</dd></div>
      </dl>`);
  }

  function ruleExpr(r) {
    const c = r.condition || {};
    return `<b>${esc(c.field)}</b> ${esc(c.operator)} <code>${esc(c.value)}</code>${r.action === 'label' && r.label ? ` → <code>${esc(r.label)}</code>` : ''}`;
  }
  const actPill = a => `<span class="label pill tri-act" data-action="${attr(a)}">${esc(a)}</span>`;

  function rulesHtml(acc) {
    const b = block(acc);
    if (!b) return '';
    const rules = b.rules || [], last = rules.length - 1;
    const ed = T.editing && T.editing.acc === acc ? T.editing : null;
    const rows = rules.map((r, i) => {
      if (ed && ed.index === i) return editorHtml(ed.draft, i);
      const shadow = shadowedBy(rules, i);
      return `<div class="tri-rule${shadow !== null ? ' dead' : ''}">
        <span class="tri-rule-n">${i + 1}</span>
        <div class="tri-rule-expr">
          <div class="tri-expr">${ruleExpr(r)}</div>
          ${shadow !== null ? `<div class="tri-dead">${ic('alert')}<span>Unreachable: rule ${shadow + 1} already matches everything this would.</span></div>` : ''}
        </div>
        <span class="tri-rule-act">${actPill(r.action)}</span>
        <span class="tri-rule-tools">
          <button class="icon-btn" data-t-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move rule ${i + 1} up" data-tooltip="Move up">${ic('up')}</button>
          <button class="icon-btn" data-t-move="${i}" data-dir="1" ${i === last ? 'disabled' : ''} aria-label="Move rule ${i + 1} down" data-tooltip="Move down">${ic('down')}</button>
          <button class="icon-btn" data-t-edit="${i}" aria-label="Edit rule ${i + 1}" data-tooltip="Edit">${ic('edit')}</button>
          <button class="icon-btn danger" data-t-del="${i}" aria-label="Delete rule ${i + 1}" data-tooltip="Delete">${ic('trash')}</button>
        </span>
      </div>`;
    }).join('');
    const addRow = ed && ed.index === null ? editorHtml(ed.draft, null)
      : `<button type="button" class="tri-rule tri-add" data-t-add><span class="tri-rule-n">${ic('plus')}</span><span>Add a rule at the end of the chain</span></button>`;
    const dead = deadCount(rules), def = b.default_action || 'triage', toAi = def === 'triage';
    const clearSel = `<select class="lucidos-select" data-t-clear="${acc}" aria-label="What happens to no-action mail">${CLEAR_MODES.map(m => `<option value="${m.value}"${m.value === (b.no_action_clear || 'keep') ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`;
    const ending = `<div class="tri-rule terminal"><span class="tri-rule-n">${ic('fall')}</span><div class="tri-rule-expr">
        <div class="tri-term">Anything unmatched falls through to <b>${toAi ? 'AI triage' : esc(def)}</b></div>
        <div class="tri-term-sub">${toAi ? 'The AI reads each leftover message and decides whether it genuinely needs you.' : `Unmatched mail takes the <b>${esc(def)}</b> action directly: the AI never sees it.`}</div></div></div>` +
      (toAi ? `<div class="tri-rule terminal"><span class="tri-rule-n">${ic('sparkle')}</span><div class="tri-rule-expr">
        <div class="tri-term">If the AI decides nothing needs doing</div>${clearSel}
        <div class="tri-term-sub">FYI and noise only. Anything it flags as needing you stays, and shows under <b>Needs you</b>.</div></div></div>` : '');
    return section('Rule chain', plural(rules.length, 'rule'), null, `
      <p class="tri-lede">Your rules run first, top to bottom. A message stops at the <b>first</b> rule it matches and takes that action: every rule below it is skipped${dead ? `. That is why ${dead} ${dead === 1 ? 'rule is' : 'rules are'} dimmed as unreachable` : ''}.</p>
      <div class="tri-group">${rows || '<div class="tri-empty">No rules: everything goes straight to AI triage.</div>'}${addRow}</div>
      <div class="tri-group tri-chain-end">${ending}</div>`,
    dead ? pill('label-warning', ic('alert') + `${dead} unreachable`) : '');
  }

  function editorHtml(d, index) {
    const opt = (list, v) => (list.includes(v) || v == null ? list : list.concat([v])).map(x => `<option value="${attr(x)}"${x === v ? ' selected' : ''}>${esc(x)}</option>`).join('');
    return `<div class="tri-editor" data-t-editor>
      <div class="tri-editor-title">${index === null ? 'New rule' : `Edit rule ${index + 1}`}</div>
      <label><span>Field</span><select id="t-ed-field" class="lucidos-select">${opt(FIELDS, d.field)}</select></label>
      <label><span>Operator</span><select id="t-ed-op" class="lucidos-select">${opt(OPERATORS, d.operator)}</select></label>
      <label><span>Action</span><select id="t-ed-action" class="lucidos-select">${opt(ACTIONS, d.action)}</select></label>
      <label class="wide"><span>Value</span><input id="t-ed-value" class="text-input" type="text" value="${attr(d.value)}" placeholder="e.g. notifications@github.com" autocomplete="off" spellcheck="false"></label>
      <label class="wide"><span>Gmail label (for the label action)</span><input id="t-ed-label" class="text-input" type="text" value="${attr(d.label || '')}" placeholder="e.g. Receipts/2026" autocomplete="off"></label>
      <div class="wide button-group"><button class="action-btn action-btn-confirm" data-t-save>Save</button><button class="action-btn action-btn-secondary" data-t-cancel>Cancel</button></div>
    </div>`;
  }

  function activityHtml(scope) {
    const all = scope === 'all';
    const scoped = all ? T.runs : T.runs.filter(e => accountsInPayload(e.payload).includes(scope));
    const sugg = scoped.flatMap(e => { const n = e.payload && e.payload.run_notes; return (Array.isArray(n) ? n : n ? [n] : []).map(text => ({ text, created: e.created })); });
    const suggHtml = sugg.length ? sugg.map(s => `<div class="tri-sugg">${ic('bulb')}<div><p>${esc(s.text)}</p><div class="tri-when">${esc(timeAgo(s.created))}</div></div></div>`).join('')
      : '<div class="tri-empty">No suggestions from these runs.</div>';
    /* Clamp the page: a reload may have shrunk the list under it. */
    const pages = Math.max(1, Math.ceil(scoped.length / RUNS_PER_PAGE));
    T.runPage = Math.min(Math.max(0, T.runPage), pages - 1);
    const from = T.runPage * RUNS_PER_PAGE, page = scoped.slice(from, from + RUNS_PER_PAGE);
    const runsHtml = page.length ? page.map(e => {
      const results = (e.payload && e.payload.account_results) || {}, who = accountsInPayload(e.payload)[0];
      /* Runs are single-account, so only a run that covered several prefixes its counts. */
      const prefix = Object.keys(results).length > 1;
      const counts = Object.entries(results).flatMap(([name, r]) => Object.entries(r || {}).filter(([, v]) => typeof v === 'number' && v > 0)
        .map(([k, v]) => `<span class="label pill label-neutral tri-count">${prefix ? esc((A[accOf(name)] || {}).label || shortName(name)) + ' ' : ''}${esc(k)} ${v}</span>`));
      return `<div class="tri-run"${who ? ` data-acct="${slot(who)}"` : ''}>
        ${all ? (who ? `<span class="chip sm" aria-hidden="true">${esc(initial(A[who].label))}</span>` : '<span class="chip sm" aria-hidden="true">?</span>') : ''}
        <div class="tri-run-main">
          <div class="tri-run-top">${all ? `<b class="tri-run-who">${esc(who ? A[who].label : 'Unknown account')}</b>` : ''}<span class="tri-when">${esc(timeAgo(e.created))} · ${esc(lucidos.utils.formatDate(e.created))}</span></div>
          <div class="tri-run-sum">${esc((e.payload && e.payload.summary) || '')}</div>
          ${counts.length ? `<div class="tri-pills">${counts.join('')}</div>` : ''}
        </div>
      </div>`;
    }).join('') : `<div class="tri-empty">No runs recorded${all ? '' : ' for this account'} in the last ${RUN_WINDOW_DAYS} days.</div>`;
    const pager = scoped.length > RUNS_PER_PAGE ? `<div class="tri-pager">
        <button class="action-btn action-btn-secondary" data-t-page="-1"${T.runPage === 0 ? ' disabled' : ''}>Newer</button>
        <span class="tri-hint">${from + 1}–${from + page.length} of ${scoped.length}</span>
        <button class="action-btn action-btn-secondary" data-t-page="1"${T.runPage >= pages - 1 ? ' disabled' : ''}>Older</button>
      </div>` : '';
    return section('Suggestions from runs', sugg.length || null, 'What triage flagged instead of asking', `<div class="tri-group">${suggHtml}</div>`) +
      `<div id="t-runs">${section('Run history', plural(scoped.length, 'run'), `last ${RUN_WINDOW_DAYS} days`, `<div class="tri-group">${runsHtml}</div>${pager}`)}</div>`;
  }

  /* Keeps whatever is typed in the open editor across a re-render. */
  function syncDraft() {
    const el = host.el, ed = T.editing;
    if (!el || !ed) return;
    const v = id => { const n = el.querySelector('#' + id); return n ? n.value : null; };
    const map = { field: 't-ed-field', operator: 't-ed-op', action: 't-ed-action', value: 't-ed-value', label: 't-ed-label' };
    for (const k in map) { const x = v(map[k]); if (x != null) ed.draft[k] = x; }
  }

  function render(scope, opts) {
    const el = host.el;
    if (!el) return;
    if (scope !== T.scope) Object.assign(T, { scope, editing: null, runPage: 0 });
    else syncDraft();
    const tap = !!(opts && opts.tap);
    let body;
    if (!T.loaded) body = '<div class="sk"></div><div class="sk tall"></div>';
    else if (!T.config) body = `<div class="list-empty"><p class="error-text">${esc(T.err || 'No triage config')}</p><button class="action-btn action-btn-secondary" data-t-reload>Try again</button></div>`;
    else if (scope === 'all') body = overviewAll() + activityHtml('all');
    else body = overviewOne(scope) + rulesHtml(scope) + activityHtml(scope);
    const html = headHtml(scope, tap) + `<div class="tri-body">${body}</div>`;
    if (html === T.lastHtml && el.firstChild) return;
    const focus = document.activeElement && el.contains(document.activeElement) && document.activeElement.id;
    const caret = focus && document.activeElement.selectionStart;
    el.innerHTML = html;
    T.lastHtml = html;
    if (lucidos.ui.enhanceSelects) lucidos.ui.enhanceSelects(el);
    if (focus) { const n = el.querySelector('#' + focus); if (n) { n.focus({ preventScroll: true }); try { if (caret != null) n.setSelectionRange(caret, caret); } catch (e) { /* not a text field */ } } }
  }
  const rerender = () => { T.lastHtml = ''; host.refresh(); };

  /* ---------- input ---------- */
  async function onClick(e) {
    const g = sel => e.target.closest(sel);
    let b;
    if (g('[data-t-reload]')) return load();
    if ((b = g('[data-t-pause]'))) return setPaused([b.dataset.tPause], !isPaused(b.dataset.tPause));
    if (g('[data-t-pause-all]')) {
      const allOff = M.ORDER.some(block) && M.ORDER.filter(block).every(isPaused);
      if (!allOff) {
        const ok = await lucidos.ui.confirm({
          title: 'Pause every account?',
          message: 'No mailbox gets triaged until you resume: not on a schedule, not with "Triage now".\n\nNothing is lost: mail piles up and the next run works through it.',
          okLabel: 'Pause all',
        });
        if (!ok) return;
      }
      return setPaused(M.ORDER, !allOff);
    }
    if ((b = g('[data-t-run]'))) return requestRun([b.dataset.tRun]);
    if (g('[data-t-run-all]')) return requestRun(M.ORDER);
    if ((b = g('[data-t-page]'))) {
      T.runPage += Number(b.dataset.tPage);
      rerender();
      const head = host.el.querySelector('#t-runs');
      if (head && head.scrollIntoView) head.scrollIntoView({ block: 'start' });
      return;
    }

    const acc = T.scope;
    if (!acc || acc === 'all' || !block(acc)) return;
    const rules = block(acc).rules || [];
    if (g('[data-t-add]')) {
      T.editing = { acc, index: null, draft: { field: 'from', operator: 'contains', value: '', action: 'delete' } };
      rerender();
      const v = host.el.querySelector('#t-ed-value');
      if (v) { if (v.scrollIntoView) v.scrollIntoView({ block: 'nearest' }); v.focus({ preventScroll: true }); }
      return;
    }
    if ((b = g('[data-t-edit]'))) {
      const i = Number(b.dataset.tEdit), r = rules[i] || {};
      T.editing = { acc, index: i, draft: Object.assign({}, r.condition, { action: r.action, label: r.label }) };
      rerender();
      return;
    }
    if (g('[data-t-cancel]')) { T.editing = null; rerender(); return; }
    if (g('[data-t-save]')) {
      syncDraft();
      const ed = T.editing, d = ed.draft, value = String(d.value || '').trim(), labelName = String(d.label || '').trim();
      if (!value) return lucidos.ui.toast('A rule needs a value to match on', 'warning');
      if (d.action === 'label' && !labelName) return lucidos.ui.toast('The label action needs a Gmail label name', 'warning');
      /* Start from the rule as it is on disk, so keys the editor doesn't show (_comment, notion's target, anything
       * new) survive in place. A new rule takes the file's sorted key order. */
      const ok = await saveConfig(cfg => {
        const target = cfg.accounts[cfgName(acc)];
        target.rules = target.rules || [];
        const base = ed.index === null ? {} : target.rules[ed.index];
        const rule = Object.assign({}, base, { action: d.action, condition: Object.assign({}, base.condition, { field: d.field, operator: d.operator, value }) });
        if (d.action === 'label') rule.label = labelName; else delete rule.label;
        if (ed.index === null) target.rules.push(rule); else target.rules[ed.index] = rule;
      }, ed.index === null ? 'Rule added' : 'Rule updated', acc);
      if (ok) { T.editing = null; rerender(); }
      return;
    }
    if ((b = g('[data-t-move]'))) {
      const i = Number(b.dataset.tMove), j = i + Number(b.dataset.dir);
      if (j < 0 || j >= rules.length) return;
      if (T.editing) syncDraft();
      return saveConfig(cfg => { const l = cfg.accounts[cfgName(acc)].rules; [l[i], l[j]] = [l[j], l[i]]; }, 'Rule order updated', acc);
    }
    if ((b = g('[data-t-del]'))) {
      const i = Number(b.dataset.tDel), r = rules[i], c = (r && r.condition) || {};
      const ok = await lucidos.ui.confirm({
        title: 'Delete rule?',
        message: `${c.field} ${c.operator} "${c.value}" → ${r.action}\n\nMail matching this will fall through to the rules below it.`,
        okLabel: 'Delete', danger: true,
      });
      if (!ok) return;
      if (T.editing && T.editing.index === i) T.editing = null;
      return saveConfig(cfg => { cfg.accounts[cfgName(acc)].rules.splice(i, 1); }, 'Rule deleted', acc);
    }
  }
  function onChange(e) {
    const s = e.target.closest && e.target.closest('[data-t-clear]');
    if (!s) return;
    const acc = s.dataset.tClear, mode = s.value;
    saveConfig(cfg => { cfg.accounts[cfgName(acc)].no_action_clear = mode; },
      `No-action mail on ${A[acc].label}: ${(CLEAR_MODES.find(m => m.value === mode) || {}).label}`);
  }

  /* A run finished: release its button (before the mid-edit check, or it spins until the give-up timer lies about
   * a timeout), then reload unless a rule is being edited, which a reload would throw away. */
  lucidos.sse.on('EmailTriageCompleted', data => {
    const p = data && data.account_results ? data : (data && data.payload) || data || {};
    const done = accountsInPayload(p).filter(finishRun);
    if (done.length) {
      const n = ((p.account_results || {})[cfgName(done[0])] || {}).actionable || 0;
      lucidos.ui.toast(`${A[done[0]].label}: ${p.summary || 'triage finished'}`, n ? 'info' : 'success', { key: `run-${done[0]}`, durationMs: 6000 });
    }
    if (T.editing) { host.refresh(); return; }
    load();
  });

  function init(h) {
    host = Object.assign(host, h);
    host.el.addEventListener('click', e => { onClick(e).catch(err => lucidos.ui.toast(err.message, 'error')); });
    host.el.addEventListener('change', onChange);
    return load();
  }

  window.Triage = { init, load, render, sideEntryHtml, sideAllHtml, serializeLike, shadowedBy, isEditing: () => !!T.editing };
})();
