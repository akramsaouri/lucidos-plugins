/* Email Triage control panel.
 *
 * Reads (never re-scans inboxes — the trigger owns that):
 *   artifacts/email-triage/config.json        accounts + rule chains  (writable here)
 *   artifacts/email-triage/triage-<slug>.json current actionable snapshot
 *   artifacts/email-triage/state-<slug>.json  shared-account fetch state
 *   artifacts/email-triage/notified-<slug>.json  push dedup ledger
 *   EmailTriageCompleted events               run history + run_notes suggestions
 *
 * Layout: the rail picks a scope (all accounts, or one), the pill tabs pick a
 * view, and every view renders for that scope.
 */

const CFG = 'artifacts/email-triage/config.json';
const ACTIONS = ['skip', 'read', 'delete', 'todo', 'notify', 'flag', 'triage'];
const FIELDS = ['from', 'to', 'cc', 'subject', 'body'];
const OPERATORS = ['contains', 'equals', 'regex'];
// What triage does with mail it decides needs no action (FYI or noise).
// Labels are phrased as the outcome, not as the config value, since bare
// "read"/"delete" collide with the rule ACTIONS vocabulary above.
const CLEAR_MODES = [
  { value: 'read', label: 'Mark it read' },
  { value: 'delete', label: 'Move it to Trash' },
  { value: 'keep', label: 'Leave it alone' },
];

/* How many account colours index.html defines (--acct-0 … --acct-4). An
 * account's colour is its position in config.json, cycling past the last. */
const ACCOUNT_COLOURS = 5;

const state = {
  config: null,
  accounts: [],   // [{ name, slug, block, triage, ledger, fetchState }]
  runs: [],
  triggers: [],   // workspace triggers, to pause/resume each account's cron
  tab: 'overview',
  scope: 'all',   // 'all', or the account name the rail has selected
  runPage: 0,     // zero-based page of the Activity run history
  editing: null,  // { account, index | null, draft }
};

/* ---------- paused accounts ----------
 *
 * `paused: true` on an account's config block is the source of truth, and it
 * is the ONLY place that can be, because triage has two callers: the account's
 * own cron trigger, and the on-demand trigger the "Triage now" button fires.
 * A flag in the config is read by the intent both callers run, so one switch
 * stops both.
 *
 * Pausing the cron trigger as well is a second, best-effort layer — it stops a
 * paused account from even spawning a thread that would read the flag and exit.
 * It is deliberately not the source of truth: the trigger is workspace state a
 * plugin never ships, the user may have named or deleted it, and the on-demand
 * trigger is shared by every account so it can never be paused per-account.
 */

/** Lowercase, punctuation-blind: "Mailhost - Support" and "Mailhost Support" compare equal. */
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Does this account's cron trigger look like it belongs to that account? */
function triggerFor(name) {
  const short = words(shortName(name));
  // "Gmail - Support" shortens to "support", which also appears in the trigger
  // of a "Mailhost - Support" account. A trigger naming a longer account name
  // that contains ours belongs to that account, not this one.
  const longer = state.accounts.map((a) => words(shortName(a.name)))
    .filter((s) => s !== short && s.includes(short));
  return state.triggers.find((t) => {
    const n = words(t.name);
    if (!n.includes('triage')) return false;
    // Skip the shared on-demand trigger — it serves every account, so pausing
    // it for one would silence "Triage now" for all of them.
    if (!(t.cron_expressions || []).length) return false;
    return n.includes(short) && !longer.some((s) => n.includes(s));
  });
}

const isPaused = (a) => a.block?.paused === true;

/** How far back the Activity tab pulls run history. */
const RUN_WINDOW_DAYS = 14;

/** Runs shown per page in the Activity tab. */
const RUNS_PER_PAGE = 15;

/* ---------- manual run state ----------
 *
 * A manual run is fire-and-forget: the app emits `EmailTriageRequested` and the
 * on-demand trigger picks it up. The ONLY completion signal is the run's own
 * `EmailTriageCompleted` arriving over SSE — which may never come. The trigger
 * can sit behind other work in the thread queue, Gmail can be down, or the run
 * can fail before it emits. A spinner with no clock is a lie the moment any of
 * those happens, so each in-flight run carries a give-up timer.
 *
 * Keyed by account NAME, because that is what the completion event resolves to
 * (see accountsInPayload). "Run all" is N independent per-account entries
 * rather than one aggregate: the triggers finish minutes apart, and a single
 * combined spinner would keep spinning for the slowest account long after the
 * others had visibly landed.
 */
const running = new Map();  // account name -> timeout id
const RUN_TIMEOUT_MS = 300000;  // 5 min — an AI triage pass over a full inbox is slow

function startRun(name) {
  clearTimeout(running.get(name));
  running.set(name, setTimeout(() => {
    running.delete(name);
    render();
    lucidos.ui.toast(
      `No result came back for ${shortName(name)} — the run may still be queued`,
      'warning', { key: `run-${name}` });
  }, RUN_TIMEOUT_MS));
}

function finishRun(name) {
  if (!running.has(name)) return false;
  clearTimeout(running.get(name));
  running.delete(name);
  return true;
}

const $ = (sel) => document.querySelector(sel);
const esc = (s) => lucidos.utils.escapeHtml(String(s ?? ''));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const scrollBehavior = () =>
  document.documentElement.dataset.motion === 'reduce' ? 'auto' : 'smooth';

/** "Gmail - Work" -> "Work". Config keys carry the provider prefix; the UI doesn't. */
const shortName = (name) => String(name).replace(/^Gmail\s*-\s*/i, '');

/** The colour slot an account wears: its position in config.json. The Inbox
 *  app computes the same index, so both apps agree without sharing state. */
function acctSlot(name) {
  const i = Object.keys(state.config?.accounts || {}).indexOf(name);
  return i < 0 ? '' : String(i % ACCOUNT_COLOURS);
}

function avatar(name, cls = '') {
  const m = shortName(name).match(/[\p{L}\p{N}]/u);
  const letter = m ? m[0].toUpperCase() : '?';
  return `<span class="avatar ${cls}" data-acct="${acctSlot(name)}" aria-hidden="true">${esc(letter)}</span>`;
}

/* ---------- icons ---------- */

const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  inbox: svg('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  up: svg('<polyline points="18 15 12 9 6 15"/>'),
  down: svg('<polyline points="6 9 12 15 18 9"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>'),
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
  fall: svg('<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>'),
  sparkle: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'),
  bulb: svg('<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>'),
  alert: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  chevron: svg('<polyline points="9 6 15 12 9 18"/>'),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
};
const GRIP = `<svg class="grip" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">${
  [3, 8, 13].map((y) => `<circle cx="3" cy="${y}" r="1.3"/><circle cx="7" cy="${y}" r="1.3"/>`).join('')}</svg>`;
// Holds the grip's width on rows that can't move, so every number lines up.
const GRIP_BLANK = GRIP.replace('class="grip"', 'class="grip blank"');

const SPINNER = '<span class="mini-spinner" style="--spinner-color: currentColor" aria-hidden="true"></span>';

/**
 * Which accounts a run touched. Every EmailTriageCompleted is single-account,
 * but the payload shape drifted across runs: most carry `account_results`
 * keyed by full config name, a few no-op runs carry only a summary string.
 * Fall back to name-matching so those still land under the right account
 * instead of vanishing from a filtered view.
 */
function accountsInPayload(payload) {
  const keys = Object.keys(payload?.account_results || {});
  if (keys.length) return keys;
  const hay = `${payload?.summary || ''} ${payload?.run?.trigger || ''}`;
  return state.accounts
    .filter((a) => hay.toLowerCase().includes(shortName(a.name).toLowerCase()))
    .map((a) => a.name);
}

/** Same question, asked of a stored event rather than a live SSE payload. */
function accountsInRun(ev) {
  return accountsInPayload(ev.payload);
}


/** Account display name -> the slug used in every sidecar filename. */
function slugFor(name) {
  return name.replace(/^Gmail\s*-\s*/i, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

async function readJson(path) {
  try {
    return JSON.parse(await lucidos.data.read(path));
  } catch {
    return null;
  }
}

/* ---------- cron ---------- */

/** Render a 6-field cron as something a human can scan. Falls back to raw. */
function cronLabel(expr) {
  const p = String(expr).trim().split(/\s+/);
  if (p.length !== 6) return expr;
  const [, min, hour, , , dow] = p;
  const days =
    dow === '*' ? 'daily' :
    dow === '1-5' ? 'weekdays' :
    `dow ${dow}`;
  const mm = min === '*' ? '00' : String(min).padStart(2, '0');
  if (/^\d+$/.test(hour)) return `${days} at ${String(hour).padStart(2, '0')}:${mm}`;
  const range = hour.match(/^(\d+)-(\d+)$/);
  if (range) return `${days}, hourly ${range[1]}:${mm}–${range[2]}:${mm}`;
  return `${days}, ${hour}:${mm}`;
}

/** Next fire time across a set of cron expressions, by minute-stepping a day ahead. */
function nextRun(exprs) {
  const parsed = exprs.map((e) => String(e).trim().split(/\s+/)).filter((p) => p.length === 6);
  if (!parsed.length) return null;

  const matches = (vals, n) =>
    vals.split(',').some((part) => {
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
    const dow = t.getDay();
    const hit = parsed.some((p) =>
      matches(p[1], t.getMinutes()) &&
      matches(p[2], t.getHours()) &&
      matches(p[3], t.getDate()) &&
      matches(p[4], t.getMonth() + 1) &&
      (p[5] === '*' || matches(p[5], dow)));
    if (hit) return t;
  }
  return null;
}

const clockOf = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function untilLabel(date) {
  if (!date) return '—';
  const mins = Math.round((date - Date.now()) / 60000);
  const clock = clockOf(date);
  if (mins < 1) return 'any moment';
  if (mins < 60) return `${clock} · in ${mins}m`;
  const h = Math.floor(mins / 60);
  return `${clock} · in ${h}h ${mins % 60}m`;
}

/* ---------- dead-rule detection ----------
 * First-match-wins means a broad rule shadows every narrower rule below it.
 * The common failure: a blanket `from contains notifications@github.com ->
 * delete` above anything finer eats the lot. */

function shadowedBy(rules, i) {
  const r = rules[i];
  const c = r?.condition;
  if (!c) return null;
  for (let j = 0; j < i; j++) {
    const p = rules[j]?.condition;
    if (!p || p.field !== c.field) continue;
    if (p.operator === 'contains' && c.operator === 'contains' &&
        String(c.value).toLowerCase().includes(String(p.value).toLowerCase())) {
      return j;
    }
    if (p.operator === 'contains' && c.operator === 'regex' &&
        String(c.value).toLowerCase().includes(String(p.value).toLowerCase())) {
      return j;
    }
    if (p.operator === c.operator && String(p.value) === String(c.value)) return j;
  }
  return null;
}

const deadCount = (rules) =>
  rules.reduce((n, _, i) => n + (shadowedBy(rules, i) !== null ? 1 : 0), 0);

/* ---------- load ---------- */

async function load() {
  state.config = await readJson(CFG);

  // Fresh install: no config file at all, or one with no accounts in it.
  // Neither is an error — it's the first run, so show what the plugin does
  // and a way into setup instead of an error line over an empty page.
  const configured = Object.keys(state.config?.accounts || {}).length > 0;
  if (!configured) return renderSetup();

  const names = Object.keys(state.config.accounts || {});
  state.accounts = await Promise.all(names.map(async (name) => {
    const slug = slugFor(name);
    const [triage, ledger, fetchState] = await Promise.all([
      readJson(`artifacts/email-triage/triage-${slug}.json`),
      readJson(`artifacts/email-triage/notified-${slug}.json`),
      readJson(`artifacts/email-triage/state-${slug}.json`),
    ]);
    return { name, slug, block: state.config.accounts[name], triage, ledger, fetchState };
  }));

  // Fetch by TIME, not by row count: several accounts x hourly means a flat
  // `limit: 40` only reaches back about a day. Ask for a real window and
  // raise the cap so the whole window actually arrives.
  const since = new Date(Date.now() - RUN_WINDOW_DAYS * 864e5).toISOString();
  const [runs, triggers] = await Promise.all([
    lucidos.events.query({
      event_type: 'EmailTriageCompleted',
      since,
      limit: 200,
    }),
    // Best-effort: pausing the cron trigger is a bonus layer, so a workspace
    // that refuses this call still gets a fully working config-level pause.
    lucidos.triggers.list().catch(() => []),
  ]);
  state.runs = runs;
  state.triggers = triggers;
  render();
}

/* ---------- render: first-run setup ---------- */

/**
 * Shown when no account is configured yet. Hides the rail, the tabs and the
 * footer deep-links (config.json doesn't exist yet, so that link would 404)
 * and offers a chat that walks the installer through wiring the first mailbox.
 */
function renderSetup() {
  $('#shell').classList.add('is-setup');
  $('#scope').innerHTML = `
    <div class="scope-text">
      <h1>Email Triage</h1>
      <div class="sub" id="subhead">Not set up yet</div>
    </div>`;
  $('.foot').hidden = true;
  for (const t of ['overview', 'rules', 'activity']) $(`#view-${t}`).hidden = true;
  $('#view-setup').hidden = false;
}

const SETUP_PROMPT = `Set up Email Triage for me.

Read knowhow/email-triage.md first — it has the config schema, the rule-chain
semantics, the notified-ledger dedup, and the shared-account fetch state.

Then walk me through, one account at a time:
1. Which mailbox to triage, and connect it if it isn't already.
2. A starting rule chain — ask what I want auto-deleted, auto-read, and
   escalated, and turn those into rules.
3. What should happen to mail the AI judges as needing nothing from me
   (mark read / move to Trash / leave alone).
4. A schedule, and create the cron trigger for it. It should run the intent
   at triggers/email-triage/intents/triage.md for that account.

Write the result to artifacts/email-triage/config.json.`;

/* ---------- render: rail + header ---------- */

function renderRail() {
  const total = state.accounts.reduce((n, a) => n + (a.triage?.emails?.length || 0), 0);
  const current = (v) => (state.scope === v ? 'aria-current="true"' : '');

  const items = state.accounts.map((a) => {
    const n = a.triage?.emails?.length || 0;
    const off = isPaused(a);
    const busy = running.has(a.name);
    const next = off || busy ? null : nextRun([].concat(a.block.schedule || []));
    const sub =
      off ? `${ICON.pause}Paused` :
      busy ? `${SPINNER}Triaging…` :
      next ? `Next ${esc(clockOf(next))}` : 'No schedule';
    return `
      <button class="rail-item ${off ? 'is-paused' : ''}" data-scope="${esc(a.name)}"
        data-acct="${acctSlot(a.name)}" ${current(a.name)}>
        ${avatar(a.name)}
        <span class="rail-text">
          <span class="rail-name">${esc(shortName(a.name))}</span>
          <span class="rail-sub">${sub}</span>
        </span>
        ${n ? `<span class="rail-count" aria-label="${n} waiting">${n}</span>` : ''}
      </button>`;
  }).join('');

  $('#rail').innerHTML = `
    <button class="rail-item" data-scope="all" ${current('all')}>
      <span class="avatar all" aria-hidden="true">${ICON.inbox}</span>
      <span class="rail-text">
        <span class="rail-name">All accounts</span>
        <span class="rail-sub">${state.accounts.length} mailbox${state.accounts.length === 1 ? '' : 'es'}</span>
      </span>
      ${total ? `<span class="rail-count" aria-label="${total} waiting">${total}</span>` : ''}
    </button>
    <div class="rail-label">Accounts</div>
    ${items}`;
}

function renderHead() {
  const acct = currentAccount();
  const actionable = state.accounts.reduce((n, a) => n + (a.triage?.emails?.length || 0), 0);

  let title, sub;
  if (acct) {
    const n = acct.triage?.emails?.length || 0;
    title = `${avatar(acct.name, 'lg')}
      <div class="scope-text"><h1>${esc(shortName(acct.name))}</h1>`;
    sub = `${esc(acct.block.address || '')}${acct.block.address ? ' · ' : ''}${n} awaiting you${
      isPaused(acct) ? ' · paused' : ''}`;
  } else {
    const paused = state.accounts.filter(isPaused);
    const last = state.runs[0];
    // Runs are single-account, so "last run 48m ago" is ambiguous across
    // several accounts. Name the account when we can resolve it from the payload.
    const lastWho = last ? (accountsInRun(last).map(shortName)[0] || '') : '';
    const lastTxt = last
      ? ` · last run ${lastWho ? `(${esc(lastWho)}) ` : ''}${esc(lucidos.utils.timeAgo(last.created))}`
      : '';
    const pausedTxt = paused.length ? ` · ${paused.length} paused` : '';
    title = `<span class="avatar lg all" aria-hidden="true">${ICON.inbox}</span>
      <div class="scope-text"><h1>All accounts</h1>`;
    sub = `${state.accounts.length} accounts · ${actionable} awaiting you` + pausedTxt + lastTxt;
  }
  $('#scope').innerHTML = `${title}<div class="sub" id="subhead">${sub}</div></div>`;

  for (const b of document.querySelectorAll('[data-tab]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
  }
  $('#actions').innerHTML = headActions(acct);
}

/** The buttons beside the tabs. Each scope + view gets the actions that act
 *  on exactly what is on screen. */
function headActions(acct) {
  if (state.tab === 'overview' && !acct) {
    const anyRunning = running.size > 0;
    const active = state.accounts.filter((a) => !isPaused(a));
    // One button, and its verb is whatever would change something. All paused
    // means the only useful action is Resume all; anything still live means
    // Pause all. A pair of buttons where one is always a no-op reads worse.
    const allOff = state.accounts.length > 0 && active.length === 0;
    return `
      <div class="button-group">
        <button class="action-btn action-btn-secondary" id="pause-all"
          title="${allOff
            ? 'Resume every account'
            : 'Stop every account being triaged, on a schedule or on demand'}">
          ${allOff ? 'Resume all' : 'Pause all'}
        </button>
        <button class="action-btn btn-ic" id="run-all" ${anyRunning || !active.length ? 'disabled' : ''}
          title="${active.length
            ? 'Run every unpaused account’s triage now, in parallel'
            : 'Every account is paused'}">
          ${anyRunning
            ? `${SPINNER}Triaging ${running.size} account${running.size === 1 ? '' : 's'}…`
            : 'Triage all accounts'}
        </button>
      </div>`;
  }
  if (state.tab === 'overview' && acct) {
    return `<div class="button-group">${accountButtons(acct, true)}</div>`;
  }
  if (state.tab === 'rules' && acct) {
    return `<button class="action-btn btn-ic" id="add-rule">${ICON.plus}Add rule</button>`;
  }
  return '';
}

/** Pause/Resume + Triage now for one account. `primary` fills the run button,
 *  for the account's own page where it is the main action. */
function accountButtons(a, primary = false) {
  const off = isPaused(a);
  const busy = running.has(a.name);
  return `
    <button class="action-btn action-btn-secondary" data-pause="${esc(a.name)}"
      title="${off
        ? 'Resume this account — its schedule starts firing again'
        : 'Stop this account being triaged, on a schedule or on demand. Mail is left untouched.'}">
      ${off ? 'Resume' : 'Pause'}
    </button>
    <button class="action-btn ${primary ? '' : 'action-btn-secondary'} btn-ic" data-run="${esc(a.name)}"
      ${busy || off ? 'disabled' : ''}
      title="${off
        ? 'Paused — resume this account to triage it'
        : "Run this account's triage now, without waiting for its schedule"}">
      ${busy ? `${SPINNER}Triaging…` : 'Triage now'}
    </button>`;
}

/* ---------- render: overview ---------- */

/** Health, next run and last triage as pills: the at-a-glance state. */
function statusPills(a) {
  const off = isPaused(a);
  const busy = running.has(a.name);
  const next = nextRun([].concat(a.block.schedule || []));
  const triaged = a.triage?.triaged_at;
  return [
    off ? `<span class="label pill label-warning">${ICON.pause}Paused</span>`
      : busy ? `<span class="label pill">${SPINNER}Triaging…</span>`
      : '<span class="label pill label-success"><span class="pill-dot"></span>Active</span>',
    off ? '' : `<span class="label pill label-neutral">${ICON.clock}Next ${esc(untilLabel(next))}</span>`,
    `<span class="label pill label-neutral">Triaged ${triaged ? esc(lucidos.utils.timeAgo(triaged)) : '—'}</span>`,
  ].join('');
}

function renderOverview() {
  const acct = currentAccount();
  $('#view-overview').innerHTML = acct ? overviewOne(acct) : overviewAll();
}

function overviewAll() {
  const rows = state.accounts.map((a) => {
    const b = a.block;
    const crons = [].concat(b.schedule || []);
    const n = a.triage?.emails?.length || 0;
    const clear = b.no_action_clear || 'legacy';
    const rules = b.rules?.length || 0;

    const meta = [
      `<span>${esc(crons.map(cronLabel).join(' · ') || 'no schedule')}</span>`,
      `<span class="${clear === 'delete' ? 'warn' : ''}">clears: ${esc(clear)}</span>`,
      b.shared ? '<span>shared</span>' : '',
      b.no_auto_delete ? '<span>no auto-delete</span>' : '',
      `<span>${plural(rules, 'rule')}</span>`,
      `<span>${a.ledger?.notified?.length || 0} in notify ledger</span>`,
    ].join('');

    return `
      <div class="row clickable acct-row ${isPaused(a) ? 'is-paused' : ''}" data-open="${esc(a.name)}">
        ${avatar(a.name)}
        <div class="acct-main">
          <div class="acct-title">
            <button class="acct-name" data-open="${esc(a.name)}">${esc(shortName(a.name))}</button>
            <span class="acct-addr">${esc(b.address || '')}</span>
          </div>
          <div class="pills">${statusPills(a)}</div>
          <div class="meta">${meta}</div>
        </div>
        <div class="acct-side">
          ${n
            ? `<span class="label pill"><span class="pill-dot"></span>${n} waiting</span>`
            : '<span class="waiting-none">Nothing waiting</span>'}
          <div class="button-group">${accountButtons(a)}</div>
        </div>
      </div>`;
  }).join('');

  const items = state.accounts.flatMap((a) =>
    (a.triage?.emails || []).map((e) => ({ ...e, account: a.name })));

  return `
    <section class="section">
      <div class="section-head">
        <h2>Accounts <span class="n">${state.accounts.length}</span></h2>
      </div>
      <div class="group">${rows}</div>
    </section>
    ${waitingSection(items, true)}`;
}

function overviewOne(a) {
  const b = a.block;
  const crons = [].concat(b.schedule || []);
  const next = nextRun(crons);
  const off = isPaused(a);
  const clear = b.no_action_clear || 'legacy';
  const triaged = a.triage?.triaged_at;
  const rules = b.rules || [];
  const dead = deadCount(rules);
  const clearLabel = (CLEAR_MODES.find((m) => m.value === clear) || {}).label || clear;

  const status = [
    statusPills(a),
    b.shared ? '<span class="label pill label-neutral">Shared</span>' : '',
    b.no_auto_delete ? '<span class="label pill label-success">No auto-delete</span>' : '',
    `<span class="label pill ${clear === 'delete' ? 'label-warning' : 'label-neutral'}">Clears: ${esc(clear)}</span>`,
  ].join('');

  const items = (a.triage?.emails || []).map((e) => ({ ...e, account: a.name }));

  return `
    <div class="status">${status}</div>
    <div class="group">
      <dl class="details">
          <div class="detail"><dt>Schedule</dt><dd>${esc(crons.map(cronLabel).join(' · ') || '—')}</dd></div>
          <div class="detail"><dt>Next run</dt><dd>${off ? 'paused' : esc(untilLabel(next))}</dd></div>
          <div class="detail"><dt>Last triaged</dt><dd>${triaged ? esc(lucidos.utils.timeAgo(triaged)) : '—'}</dd></div>
          <div class="detail"><dt>Notify ledger</dt><dd>${a.ledger?.notified?.length || 0} ids</dd></div>
          <div class="detail"><dt>No-action mail</dt><dd>${esc(clearLabel)}</dd></div>
          <div class="detail"><dt>Rule chain</dt><dd>${plural(rules.length, 'rule')}${
            dead ? `<span class="hint">${dead} unreachable</span>` : ''}
            · <a class="accent-link" href="#" data-goto="rules">Edit</a></dd></div>
      </dl>
    </div>
    ${waitingSection(items, false)}`;
}

/** The actionable list. `showAccount` adds each item's account avatar, which
 *  only earns its space when several accounts share the list. */
function waitingSection(items, showAccount) {
  const list = items.length
    ? items.map((e) => `
        <div class="row item ${showAccount ? '' : 'solo'}">
          ${showAccount ? avatar(e.account) : ''}
          <div class="item-body">
            <div class="item-subject">${esc(e.subject || '(no subject)')}</div>
            <div class="item-from">${esc(e.from || '')}${
              showAccount ? ` · ${esc(shortName(e.account))}` : ''}</div>
            ${e.summary ? `<div class="item-summary">${esc(e.summary)}</div>` : ''}
          </div>
          ${e.action ? actPill(e.action) : ''}
        </div>`).join('')
    : `<div class="empty-state">${showAccount
        ? 'Nothing needs you. Every account is clear.'
        : 'Nothing here needs you.'}</div>`;

  return `
    <section class="section">
      <div class="section-head">
        <h2>Waiting on you ${items.length ? `<span class="n">${items.length}</span>` : ''}</h2>
        <span class="hint">From ${showAccount ? "each account's" : 'the latest'} triage snapshot</span>
      </div>
      <div class="group">${list}</div>
    </section>`;
}

/* ---------- render: rules ---------- */

function ruleExpr(r) {
  const c = r.condition || {};
  return `<b>${esc(c.field)}</b> ${esc(c.operator)} <code>${esc(c.value)}</code>`;
}

/** A rule action or a triage verdict (respond | act | review) as a tinted pill. */
const actPill = (action) =>
  `<span class="label pill act-pill" data-action="${esc(action)}"><span class="pill-dot"></span>${esc(action)}</span>`;

/** Rules tab with no account picked: one row per chain, to choose from. */
function renderRuleChooser() {
  const rows = state.accounts.map((a) => {
    const rules = a.block.rules || [];
    const dead = deadCount(rules);
    const def = a.block.default_action || 'triage';
    return `
      <div class="row clickable pick-row" data-open="${esc(a.name)}">
        ${avatar(a.name)}
        <div class="acct-main">
          <div class="acct-title">
            <button class="acct-name" data-open="${esc(a.name)}">${esc(shortName(a.name))}</button>
          </div>
          <div class="meta">
            <span>${plural(rules.length, 'rule')}</span>
            <span>then ${def === 'triage' ? 'AI triage' : esc(def)}</span>
            ${dead ? `<span class="warn">${dead} unreachable</span>` : ''}
          </div>
        </div>
        <span class="chev">${ICON.chevron}</span>
      </div>`;
  }).join('');

  $('#view-rules').innerHTML = `
    <section class="section">
      <div class="section-head"><h2>Rule chains</h2></div>
      <p class="lede">Every account runs its own chain, top to bottom, and the first rule a
        message matches decides what happens to it. Pick an account to edit its chain.</p>
      <div class="group">${rows}</div>
    </section>`;
}

function renderRules() {
  const acct = currentAccount();
  if (!acct) return renderRuleChooser();

  const rules = acct.block.rules || [];
  const editingHere = state.editing?.account === acct.name ? state.editing : null;
  const last = rules.length - 1;

  const rows = rules.map((r, i) => {
    const shadow = shadowedBy(rules, i);
    if (editingHere && editingHere.index === i) return renderEditor(editingHere.draft, i);
    return `
      <div class="row rule ${shadow !== null ? 'dead' : ''}">
        <span class="rule-handle">${GRIP}<span class="rule-n">${i + 1}</span></span>
        <div class="rule-expr">
          <div class="expr">${ruleExpr(r)}</div>
          ${shadow !== null
            ? `<div class="dead-why">${ICON.alert}<span>Unreachable — rule ${shadow + 1} already matches everything this would.</span></div>`
            : ''}
        </div>
        <span class="rule-act">${actPill(r.action)}</span>
        <span class="rule-tools">
          <button class="icon-btn" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}
            aria-label="Move rule ${i + 1} up" data-tooltip="Move up">${ICON.up}</button>
          <button class="icon-btn" data-move="${i}" data-dir="1" ${i === last ? 'disabled' : ''}
            aria-label="Move rule ${i + 1} down" data-tooltip="Move down">${ICON.down}</button>
          <button class="icon-btn" data-edit="${i}"
            aria-label="Edit rule ${i + 1}" data-tooltip="Edit">${ICON.edit}</button>
          <button class="icon-btn danger" data-del="${i}"
            aria-label="Delete rule ${i + 1}" data-tooltip="Delete">${ICON.trash}</button>
        </span>
      </div>`;
  }).join('');

  const adding = editingHere && editingHere.index === null;
  const addRow = adding
    ? renderEditor(editingHere.draft, null)
    : `<button type="button" class="row add-row" data-add-rule>
         <span class="rule-handle">${GRIP_BLANK}<span class="rule-n">${ICON.plus}</span></span>
         <span>Add a rule at the end of the chain</span>
       </button>`;

  const dead = deadCount(rules);
  const def = acct.block.default_action || 'triage';
  const toAi = def === 'triage';
  const n = rules.length;

  // Where mail goes once it has passed every rule: the end of the chain.
  const ending = `
    <div class="row rule terminal">
      <span class="rule-handle">${GRIP_BLANK}<span class="rule-n">${ICON.fall}</span></span>
      <div class="rule-expr">
        <div class="term-title"><span>Anything unmatched falls through to
          <b>${toAi ? 'AI triage' : esc(def)}</b></span></div>
        <div class="term-sub">${toAi
          ? 'The AI reads each leftover message and decides whether it genuinely needs you.'
          : `Unmatched mail takes the <b>${esc(def)}</b> action directly — the AI never sees it.`}</div>
      </div>
    </div>
    ${toAi ? `
    <div class="row rule terminal">
      <span class="rule-handle">${GRIP_BLANK}<span class="rule-n">${ICON.sparkle}</span></span>
      <div class="rule-expr">
        <div class="term-title">
          <span>If the AI decides nothing needs doing →</span>
          <span id="clear-pick"></span>
        </div>
        <div class="term-sub">FYI and noise only. Anything it flags as needing you is left alone
          and shows up under <b>Waiting on you</b>.</div>
      </div>
    </div>` : ''}`;

  $('#view-rules').innerHTML = `
    <section class="section">
      <div class="section-head">
        <h2>Rule chain <span class="n">${plural(n, 'rule')}</span></h2>
        ${dead ? `<span class="label pill label-warning">${ICON.alert}${dead} unreachable</span>` : ''}
      </div>
      <p class="lede">Your rules run first, top to bottom. A message stops at the <b>first</b>
        rule it matches and takes that action — every rule below it is skipped${dead
          ? `. That is why ${dead} ${dead === 1 ? 'rule is' : 'rules are'} dimmed as unreachable`
          : ''}.</p>
      <div class="group">
        ${rows || '<div class="empty-state">No rules — everything goes straight to AI triage.</div>'}
        ${addRow}
      </div>
      <div class="group chain-end">${ending}</div>
    </section>`;

  const clearSlot = $('#clear-pick');
  if (clearSlot) {
    const clearSel = lucidos.ui.Select.create({
      options: CLEAR_MODES.map((m) => ({ value: m.value, label: m.label })),
      value: acct.block.no_action_clear || 'keep',
      onChange: (mode) => saveConfig(
        () => { state.config.accounts[acct.name].no_action_clear = mode; },
        `No-action mail on ${shortName(acct.name)}: ${
          (CLEAR_MODES.find((m) => m.value === mode) || {}).label}`),
    });
    clearSlot.replaceWith(clearSel.element);
  }

  lucidos.ui.enhanceSelects();
}

function renderEditor(d, index) {
  const opt = (list, v) => list.map((x) =>
    `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('');
  // A rule whose action isn't in the list (a workspace that extended the
  // vocabulary) keeps it on offer, so opening the editor can't turn it into
  // the first option.
  const actions = d.action && !ACTIONS.includes(d.action) ? [...ACTIONS, d.action] : ACTIONS;
  return `
    <div class="editor" data-editor>
      <div class="editor-title">${index === null ? 'New rule' : `Edit rule ${index + 1}`}</div>
      <div>
        <label for="ed-field">Field</label>
        <select id="ed-field" class="lucidos-select">${opt(FIELDS, d.field)}</select>
      </div>
      <div>
        <label for="ed-op">Operator</label>
        <select id="ed-op" class="lucidos-select">${opt(OPERATORS, d.operator)}</select>
      </div>
      <div>
        <label for="ed-action">Action</label>
        <select id="ed-action" class="lucidos-select">${opt(actions, d.action)}</select>
      </div>
      <div class="wide">
        <label for="ed-value">Value</label>
        <input id="ed-value" class="text-input" type="text" value="${esc(d.value)}" placeholder="e.g. notifications@github.com">
      </div>
      <div class="editor-actions button-group">
        <button class="action-btn action-btn-confirm" data-save="${index === null ? 'new' : index}">Save</button>
        <button class="action-btn action-btn-secondary" data-cancel>Cancel</button>
      </div>
    </div>`;
}

/* ---------- render: activity ---------- */

function renderActivity() {
  const all = state.runs;
  const scoped = state.scope === 'all'
    ? all
    : all.filter((ev) => accountsInRun(ev).includes(state.scope));
  // With a single account in view, the account on every row is noise.
  const showAcct = state.scope === 'all';

  const suggestions = scoped.flatMap((ev) => {
    const notes = ev.payload?.run_notes;
    return (Array.isArray(notes) ? notes : notes ? [notes] : [])
      .map((text) => ({ text, created: ev.created }));
  });

  const sugHtml = suggestions.length
    ? suggestions.map((s) => `
        <div class="row suggestion">
          <span class="sugg-icon" aria-hidden="true">${ICON.bulb}</span>
          <div>
            <p>${esc(s.text)}</p>
            <div class="when">${esc(lucidos.utils.timeAgo(s.created))}</div>
          </div>
        </div>`).join('')
    : `<div class="empty-state">No suggestions from these runs.</div>`;

  // Clamp the page: the scope may have shrunk the list under our feet.
  const pageCount = Math.max(1, Math.ceil(scoped.length / RUNS_PER_PAGE));
  state.runPage = Math.min(Math.max(0, state.runPage), pageCount - 1);
  const from = state.runPage * RUNS_PER_PAGE;
  const page = scoped.slice(from, from + RUNS_PER_PAGE);

  const runsHtml = page.length
    ? page.map((ev) => {
        const results = ev.payload?.account_results || {};
        const who = accountsInRun(ev)[0];
        // Runs are single-account, so the row's avatar already names it. Only
        // a run that somehow covered several prefixes its counts.
        const prefix = Object.keys(results).length > 1;
        const counts = Object.entries(results).flatMap(([acct, r]) =>
          Object.entries(r)
            .filter(([, v]) => typeof v === 'number' && v > 0)
            .map(([k, v]) => `<span class="label pill sm label-neutral">${
              prefix ? `${esc(shortName(acct))} ` : ''}${esc(k)} ${v}</span>`));
        return `
          <div class="row run ${showAcct ? '' : 'solo'}">
            ${showAcct ? (who ? avatar(who, 'sm') : '<span class="avatar sm all" aria-hidden="true"></span>') : ''}
            <div>
              <div class="run-top">
                ${showAcct
                  ? `<span class="run-who" ${who ? `data-acct="${acctSlot(who)}"` : ''}>${esc(who ? shortName(who) : 'Unknown account')}</span>`
                  : ''}
                <span class="when">${esc(lucidos.utils.timeAgo(ev.created))} · ${
                  esc(lucidos.utils.formatDate(ev.created))}</span>
              </div>
              <div class="run-summary">${esc(ev.payload?.summary || '')}</div>
              ${counts.length ? `<div class="pills">${counts.join('')}</div>` : ''}
            </div>
          </div>`;
      }).join('')
    : `<div class="empty-state">No runs recorded for this account in the last ${RUN_WINDOW_DAYS} days.</div>`;

  const pagerHtml = scoped.length > RUNS_PER_PAGE
    ? `<div class="pager">
         <button class="action-btn action-btn-secondary" id="run-prev"${state.runPage === 0 ? ' disabled' : ''}>Newer</button>
         <span class="hint">${from + 1}–${from + page.length} of ${scoped.length} · page ${state.runPage + 1} of ${pageCount}</span>
         <button class="action-btn action-btn-secondary" id="run-next"${state.runPage >= pageCount - 1 ? ' disabled' : ''}>Older</button>
       </div>`
    : '';

  const oldest = all.length ? all[all.length - 1].created : null;
  const span = oldest
    ? `last ${RUN_WINDOW_DAYS} days · oldest ${esc(lucidos.utils.timeAgo(oldest))}`
    : `last ${RUN_WINDOW_DAYS} days`;

  $('#view-activity').innerHTML = `
    <section class="section">
      <div class="section-head">
        <h2>Suggestions from runs ${suggestions.length ? `<span class="n">${suggestions.length}</span>` : ''}</h2>
        <span class="hint">What triage flagged instead of asking</span>
      </div>
      <div class="group">${sugHtml}</div>
    </section>
    <section class="section">
      <div class="section-head" id="run-history-head">
        <h2>Run history <span class="n">${plural(scoped.length, 'run')}</span></h2>
        <span class="hint">${span}</span>
      </div>
      <div class="group">${runsHtml}</div>
      ${pagerHtml}
    </section>`;

  const goto = (n) => {
    state.runPage = n;
    renderActivity();
    // Land on the top of the new page instead of staying at the pager.
    $('#run-history-head')?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  };
  $('#run-prev')?.addEventListener('click', () => goto(state.runPage - 1));
  $('#run-next')?.addEventListener('click', () => goto(state.runPage + 1));
}

function render() {
  // Coming back from the setup state (config just appeared) — restore chrome.
  $('#shell').classList.remove('is-setup');
  $('#view-setup').hidden = true;
  $('.foot').hidden = false;
  // The scoped account may have been removed from config since the last load.
  if (state.scope !== 'all' && !state.accounts.some((a) => a.name === state.scope)) {
    state.scope = 'all';
  }
  renderRail();
  renderHead();
  if (state.tab === 'overview') renderOverview();
  if (state.tab === 'rules') renderRules();
  if (state.tab === 'activity') renderActivity();
  for (const t of ['overview', 'rules', 'activity']) {
    $(`#view-${t}`).hidden = state.tab !== t;
  }
}

/** Re-run the fade-in on the visible view, for a switch the user made. */
function animateView() {
  const view = $(`#view-${state.tab}`);
  view.classList.remove('enter');
  void view.offsetWidth;  // restart the animation
  view.classList.add('enter');
}

function setScope(scope) {
  if (scope === state.scope) return;
  state.scope = scope;
  state.editing = null;
  state.runPage = 0;  // a new account starts at its newest run
  render();
  animateView();
  // On a phone the rail is a sideways chip row: keep the picked chip in view.
  $('#rail [aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: scrollBehavior() });
}

function setTab(tab) {
  if (tab === state.tab) return;
  state.tab = tab;
  render();
  animateView();
}

/* ---------- persistence ---------- */

/** Returns true when the write landed. Callers with a follow-up step (pausing
 *  a trigger) must bail on false, or they act on state that was rolled back. */
async function saveConfig(mutate, message) {
  mutate();
  try {
    await lucidos.data.write(CFG, JSON.stringify(state.config, null, 2));
    lucidos.ui.toast(message, 'success');
  } catch (e) {
    lucidos.ui.toast(`Could not save: ${e.message}`, 'error');
    await load();
    return false;
  }
  render();
  return true;
}

/** The account the rail has selected, or null under "All accounts". */
function currentAccount() {
  if (state.scope === 'all') return null;
  return state.accounts.find((a) => a.name === state.scope) || null;
}

/* ---------- pause / resume ----------
 *
 * Writes `paused` into each named account's config block, then tries to
 * pause/resume that account's cron trigger to match. The config write is what
 * matters and is reported on; the trigger half is best-effort and only
 * surfaces when it fails, since a workspace can legitimately have no trigger
 * for an account (a fresh install, or one the user runs by hand).
 */
async function setPaused(names, paused) {
  // Resolve against known accounts first: an unknown name would sail through
  // the state check below and then throw on `state.config.accounts[n]`.
  const targets = names
    .map((n) => state.accounts.find((a) => a.name === n))
    .filter((a) => a && isPaused(a) !== paused)
    .map((a) => a.name);
  if (!targets.length) return;

  // A paused account must not be left with a spinner that can never clear:
  // its run will never arrive, so drop the in-flight entry now.
  if (paused) for (const n of targets) finishRun(n);

  const verb = paused ? 'Paused' : 'Resumed';
  const what = targets.length === 1
    ? shortName(targets[0])
    : `${targets.length} accounts`;

  const saved = await saveConfig(
    () => {
      for (const n of targets) {
        if (paused) state.config.accounts[n].paused = true;
        // Absent means running — don't leave a `false` littering the config.
        else delete state.config.accounts[n].paused;
      }
    },
    `${verb} ${what}`);
  // The write was rolled back and reloaded — pausing the schedule now would
  // leave the two halves disagreeing, which is worse than not pausing at all.
  if (!saved) return;

  // Second layer: stop the cron firing at all. Never blocks the config write
  // above, and a missing trigger is silence rather than an error.
  const stuck = [];
  for (const n of targets) {
    const t = triggerFor(n);
    if (!t || t.paused === paused) continue;
    try {
      const res = await lucidos.triggers.update(t.id, { paused });
      if (!res?.success) stuck.push(shortName(n));
    } catch {
      stuck.push(shortName(n));
    }
  }
  if (stuck.length) {
    lucidos.ui.toast(
      `${verb} in config, but couldn't ${paused ? 'pause' : 'resume'} the schedule for ${
        stuck.join(', ')} — the run will start and exit instead`,
      'warning', { key: 'pause-trigger' });
  }
  await load();
}

/* ---------- manual triage ----------
 *
 * An iframe can't read a mailbox, so the app asks rather than does: it emits
 * `EmailTriageRequested` and the "Email Triage — on demand" trigger runs the
 * SAME intent the cron triggers run. One procedure, two callers — the button
 * can't drift from the schedule the way a second implementation would.
 *
 * One event PER ACCOUNT even for "run all": the intent is written per-account
 * (it reads one config block, one state file, one ledger), and parallel runs
 * finish sooner than one serial pass over every inbox.
 */
async function requestRun(names) {
  // A paused account never runs, however the request arrives. Filtering here
  // as well as disabling the button covers "Triage all", which is handed the
  // full list, and any future caller.
  const allowed = names.filter((n) => {
    const a = state.accounts.find((x) => x.name === n);
    return a && !isPaused(a);
  });
  const fresh = allowed.filter((n) => !running.has(n));
  if (!fresh.length) return;

  for (const name of fresh) startRun(name);
  render();

  const failed = [];
  for (const name of fresh) {
    try {
      await lucidos.events.emit('EmailTriageRequested', {
        summary: `Manual triage run for ${shortName(name)}`,
        account: name,
        source: 'email-triage-app',
      });
    } catch (e) {
      finishRun(name);
      failed.push(shortName(name));
    }
  }

  if (failed.length) {
    render();
    lucidos.ui.toast(`Could not start triage for ${failed.join(', ')}`, 'error',
      { key: 'run-fail' });
  }
  /* No "started" toast on success — the button's own spinner already says it,
   * and a banner repeating the control under the cursor is noise. */
}

/* ---------- events ---------- */

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (btn) setTab(btn.dataset.tab);
});

$('#rail').addEventListener('click', (e) => {
  const item = e.target.closest('[data-scope]');
  if (item) setScope(item.dataset.scope);
});

$('#refresh').addEventListener('click', async () => {
  const btn = $('#refresh');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('spinning');
  state.editing = null;
  try {
    await load();
    lucidos.ui.toast('Reloaded', 'success', { durationMs: 1500 });
  } finally {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
});

async function onOverviewClick(e) {
  const pause = e.target.closest('[data-pause]');
  if (pause) {
    const name = pause.dataset.pause;
    const acct = state.accounts.find((a) => a.name === name);
    return setPaused([name], !isPaused(acct));
  }

  if (e.target.closest('#pause-all')) {
    const allOff = state.accounts.length > 0 && state.accounts.every(isPaused);
    if (!allOff) {
      const ok = await lucidos.ui.confirm({
        title: 'Pause every account?',
        message: 'No mailbox gets triaged until you resume — not on a schedule, not with "Triage now".\n\nNothing is lost: mail piles up unread and the next run works through it.',
        okLabel: 'Pause all',
      });
      if (!ok) return;
    }
    return setPaused(state.accounts.map((a) => a.name), !allOff);
  }

  const one = e.target.closest('[data-run]');
  if (one) return requestRun([one.dataset.run]);
  if (e.target.closest('#run-all')) {
    return requestRun(state.accounts.map((a) => a.name));
  }

  // A click anywhere else on an account row opens that account. Buttons and
  // links above have already claimed their own clicks.
  const open = e.target.closest('[data-open]');
  if (open && !e.target.closest('a')) return setScope(open.dataset.open);
}

async function onRulesClick(e) {
  const open = e.target.closest('[data-open]');
  if (open) return setScope(open.dataset.open);

  const acct = currentAccount();
  if (!acct) return;
  const rules = acct.block.rules || (acct.block.rules = []);

  const add = e.target.closest('#add-rule, [data-add-rule]');
  if (add) {
    state.editing = {
      account: acct.name,
      index: null,
      draft: { field: 'from', operator: 'contains', value: '', action: 'delete' },
    };
    renderRules();
    // The header button sits a whole chain away from where the editor opens.
    $('[data-editor]')?.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
    return $('#ed-value')?.focus({ preventScroll: true });
  }

  const edit = e.target.closest('[data-edit]');
  if (edit) {
    const i = Number(edit.dataset.edit);
    const r = rules[i];
    state.editing = {
      account: acct.name,
      index: i,
      draft: { ...r.condition, action: r.action },
    };
    return renderRules();
  }

  if (e.target.closest('[data-cancel]')) {
    state.editing = null;
    return renderRules();
  }

  const save = e.target.closest('[data-save]');
  if (save) {
    const value = $('#ed-value').value.trim();
    if (!value) return lucidos.ui.toast('A rule needs a value to match on', 'warning');
    const at = save.dataset.save;
    // Start from the rule being edited, so keys the editor doesn't show
    // (a `_comment`, a field a workspace's own action reads) survive the save.
    const before = at === 'new' ? {} : rules[Number(at)] || {};
    const rule = {
      ...before,
      action: $('#ed-action').value,
      condition: {
        ...(before.condition || {}),
        field: $('#ed-field').value,
        operator: $('#ed-op').value,
        value,
      },
    };
    state.editing = null;
    return saveConfig(
      () => {
        const target = state.config.accounts[acct.name];
        target.rules = target.rules || [];
        if (at === 'new') target.rules.push(rule);
        else target.rules[Number(at)] = rule;
      },
      at === 'new' ? 'Rule added' : 'Rule updated');
  }

  const move = e.target.closest('[data-move]');
  if (move) {
    const i = Number(move.dataset.move);
    const j = i + Number(move.dataset.dir);
    if (j < 0 || j >= rules.length) return;
    return saveConfig(
      () => {
        const list = state.config.accounts[acct.name].rules;
        [list[i], list[j]] = [list[j], list[i]];
      },
      'Rule order updated');
  }

  const del = e.target.closest('[data-del]');
  if (del) {
    const i = Number(del.dataset.del);
    const r = rules[i];
    const ok = await lucidos.ui.confirm({
      title: 'Delete rule?',
      message: `${r.condition.field} ${r.condition.operator} "${r.condition.value}" → ${r.action}\n\nMail matching this will fall through to the rules below it.`,
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    return saveConfig(
      () => { state.config.accounts[acct.name].rules.splice(i, 1); },
      'Rule deleted');
  }
}

$('#view-overview').addEventListener('click', onOverviewClick);
$('#view-rules').addEventListener('click', onRulesClick);
// The header actions belong to whichever view is showing.
$('#actions').addEventListener('click', (e) =>
  (state.tab === 'rules' ? onRulesClick(e) : onOverviewClick(e)));

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]');
  if (go) {
    e.preventDefault();
    return setTab(go.dataset.goto);
  }
  const link = e.target.closest('[data-file]');
  if (!link) return;
  e.preventDefault();
  lucidos.ui.navigate('file', { file_path: link.dataset.file });
});

$('#setup-start').addEventListener('click', () => {
  lucidos.ui.startThread({ prompt: SETUP_PROMPT });
});

/* ---------- boot ---------- */

lucidos.ui.applyPreferences();
lucidos.ui.watchPreferences();
lucidos.sse.connect();
lucidos.sse.on('EmailTriageCompleted', (data) => {
  /* Clear the spinner for whichever account this run belongs to. Do it BEFORE
   * the mid-edit bail below: a run that finishes while the user is editing a
   * rule must still release its button, or it spins until the 5-minute timer
   * fires and then lies about having timed out. */
  const done = accountsInPayload(data).filter(finishRun);
  if (done.length) {
    const counts = data?.account_results?.[done[0]] || {};
    const n = counts.actionable ?? 0;
    lucidos.ui.toast(
      `${shortName(done[0])}: ${data?.summary || 'triage finished'}`,
      n ? 'info' : 'success',
      { key: `run-${done[0]}`, durationMs: 6000 });
  }
  // A run just finished. Refresh unless the user is mid-edit — reloading
  // would discard the open editor and any typed value.
  if (state.editing) return render();
  load();
});
load();
