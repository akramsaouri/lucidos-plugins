/* Email Triage control panel.
 *
 * Reads (never re-scans inboxes — the trigger owns that):
 *   artifacts/email-triage/config.json        accounts + rule chains  (writable here)
 *   artifacts/email-triage/triage-<slug>.json current actionable snapshot
 *   artifacts/email-triage/state-<slug>.json  shared-account fetch state
 *   artifacts/email-triage/notified-<slug>.json  push dedup ledger
 *   EmailTriageCompleted events               run history + run_notes suggestions
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

const state = {
  config: null,
  accounts: [],   // [{ name, slug, block, triage, ledger, fetchState }]
  runs: [],
  tab: 'overview',
  selectedAccount: null,  // account name shown in the Rules tab
  runFilter: 'all',       // account name shown in the Activity tab, or 'all'
  runPage: 0,             // zero-based page of the Activity run history
  editing: null,  // { account, index | null, draft }
};

/** How far back the Activity tab pulls run history. */
const RUN_WINDOW_DAYS = 14;

/** Runs shown per page in the Activity tab. */
const RUNS_PER_PAGE = 15;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => lucidos.utils.escapeHtml(String(s ?? ''));

/** "Gmail - Work" -> "Work". Config keys carry the provider prefix; the UI doesn't. */
const shortName = (name) => String(name).replace(/^Gmail\s*-\s*/i, '');

/**
 * Which accounts a run touched. Every EmailTriageCompleted is single-account,
 * but the payload shape drifted across runs: most carry `account_results`
 * keyed by full config name, a few no-op runs carry only a summary string.
 * Fall back to name-matching so those still land under the right account
 * instead of vanishing from a filtered view.
 */
function accountsInRun(ev) {
  const keys = Object.keys(ev.payload?.account_results || {});
  if (keys.length) return keys;
  const hay = `${ev.payload?.summary || ''} ${ev.payload?.run?.trigger || ''}`;
  return state.accounts
    .filter((a) => hay.toLowerCase().includes(shortName(a.name).toLowerCase()))
    .map((a) => a.name);
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

function untilLabel(date) {
  if (!date) return '—';
  const mins = Math.round((date - Date.now()) / 60000);
  const clock = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

  // Fetch by TIME, not by row count: 4 accounts x hourly means a flat
  // `limit: 40` only reaches back about a day. Ask for a real window and
  // raise the cap so the whole window actually arrives.
  const since = new Date(Date.now() - RUN_WINDOW_DAYS * 864e5).toISOString();
  state.runs = await lucidos.events.query({
    event_type: 'EmailTriageCompleted',
    since,
    limit: 200,
  });
  render();
}

/* ---------- render: first-run setup ---------- */

/**
 * Shown when no account is configured yet. Hides the tabs and the footer
 * deep-links (config.json doesn't exist yet, so that link would 404) and
 * offers a chat that walks the installer through wiring the first mailbox.
 */
function renderSetup() {
  $('#subhead').textContent = 'Not set up yet';
  $('#tabs').hidden = true;
  $('#refresh').hidden = true;
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

/* ---------- render: overview ---------- */

function renderOverview() {
  const actionable = state.accounts.reduce((n, a) => n + (a.triage?.emails?.length || 0), 0);
  const last = state.runs[0];
  // Runs are single-account, so "last run 48m ago" was ambiguous across four
  // accounts. Name the account when we can resolve it from the payload.
  const lastWho = last ? (accountsInRun(last).map(shortName)[0] || '') : '';
  const lastTxt = last
    ? ` · last run ${lastWho ? `(${esc(lastWho)}) ` : ''}${esc(lucidos.utils.timeAgo(last.created))}`
    : '';
  $('#subhead').innerHTML =
    `${state.accounts.length} accounts · ${actionable} awaiting you` + lastTxt;

  const cards = state.accounts.map((a) => {
    const b = a.block;
    const crons = [].concat(b.schedule || []);
    const next = nextRun(crons);
    const n = a.triage?.emails?.length || 0;
    const clear = b.no_action_clear || 'legacy';
    const triaged = a.triage?.triaged_at;

    const chips = [
      b.shared ? '<span class="chip">shared</span>' : '',
      `<span class="chip ${clear === 'delete' ? 'warn' : ''}">clears: ${esc(clear)}</span>`,
      b.no_auto_delete ? '<span class="chip ok">no auto-delete</span>' : '',
      `<span class="chip">${b.rules?.length || 0} rule${b.rules?.length === 1 ? '' : 's'}</span>`,
    ].join('');

    return `
      <div class="card">
        <div class="acct-top">
          <div>
            <div class="acct-name">${esc(a.name.replace(/^Gmail\s*-\s*/i, ''))}</div>
            <div class="acct-addr">${esc(b.address || '')}</div>
          </div>
          <div>
            <div class="acct-count ${n ? '' : 'zero'}">${n}</div>
            <div class="acct-count-label">actionable</div>
          </div>
        </div>
        <div class="chips">${chips}</div>
        <dl class="acct-meta">
          <div class="kv"><dt>Schedule</dt><dd>${esc(crons.map(cronLabel).join(' · ') || '—')}</dd></div>
          <div class="kv"><dt>Next run</dt><dd>${esc(untilLabel(next))}</dd></div>
          <div class="kv"><dt>Last triaged</dt><dd>${triaged ? esc(lucidos.utils.timeAgo(triaged)) : '—'}</dd></div>
          <div class="kv"><dt>Notify ledger</dt><dd>${a.ledger?.notified?.length || 0} ids</dd></div>
        </dl>
      </div>`;
  }).join('');

  const items = state.accounts.flatMap((a) =>
    (a.triage?.emails || []).map((e) => ({ ...e, account: a.name })));

  const list = items.length
    ? items.map((e) => `
        <div class="item">
          <span class="dot ${esc(e.action)}"></span>
          <div class="item-body">
            <div class="item-subject">${esc(e.subject || '(no subject)')}</div>
            <div class="item-from">${esc(e.from || '')} · ${esc(e.account.replace(/^Gmail\s*-\s*/i, ''))} · ${esc(e.action || '')}</div>
            ${e.summary ? `<div class="item-summary">${esc(e.summary)}</div>` : ''}
          </div>
        </div>`).join('')
    : `<div class="empty-state">Nothing needs you. Every account is clear.</div>`;

  $('#view-overview').innerHTML = `
    <div class="accounts">${cards}</div>
    <div class="section-head">
      <h2>Waiting on you</h2>
      <span class="hint">From each account's triage snapshot</span>
    </div>
    <div class="card">${list}</div>`;
}

/* ---------- render: rules ---------- */

function ruleExpr(r) {
  const c = r.condition || {};
  return `<b>${esc(c.field)}</b> ${esc(c.operator)} <code>${esc(c.value)}</code>`;
}

function renderRules() {
  const acct = state.accounts.find((a) => a.name === state.selectedAccount) || state.accounts[0];
  if (!acct) return;
  state.selectedAccount = acct.name;

  const rules = acct.block.rules || [];
  const editingHere = state.editing?.account === acct.name ? state.editing : null;

  const rows = rules.map((r, i) => {
    const shadow = shadowedBy(rules, i);
    if (editingHere && editingHere.index === i) return renderEditor(editingHere.draft, i);
    return `
      <div class="rule ${shadow !== null ? 'dead' : ''}">
        <span class="rule-n">${i + 1}</span>
        <span class="rule-expr">${ruleExpr(r)}${
          shadow !== null
            ? `<div class="warn-note">Unreachable — rule ${shadow + 1} already matches everything this would.</div>`
            : ''}</span>
        <span class="rule-act"><span class="dot ${esc(r.action)}"></span>${esc(r.action)}</span>
        <span class="rule-tools">
          <button class="action-btn action-btn-secondary" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="action-btn action-btn-secondary" data-move="${i}" data-dir="1" ${i === rules.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="action-btn action-btn-secondary" data-edit="${i}">Edit</button>
          <button class="action-btn action-btn-danger" data-del="${i}">Delete</button>
        </span>
      </div>`;
  }).join('');

  const adding = editingHere && editingHere.index === null
    ? renderEditor(editingHere.draft, null)
    : '';

  const dead = rules.reduce((n, _, i) => n + (shadowedBy(rules, i) !== null ? 1 : 0), 0);
  const def = acct.block.default_action || 'triage';
  const toAi = def === 'triage';
  const n = rules.length;

  const flow = `
    <div class="flow">
      <div class="flow-step">
        <span class="flow-n">1</span>
        <div class="flow-body">
          <div class="flow-title">Your ${n} rule${n === 1 ? '' : 's'} run first, top to bottom</div>
          <div class="flow-sub">A message stops at the <b>first</b> rule it matches and takes that
            action — every rule below it is skipped${dead
              ? `. That is why ${dead} ${dead === 1 ? 'rule is' : 'rules are'} marked unreachable below`
              : ''}.</div>
        </div>
      </div>
      <div class="flow-step">
        <span class="flow-n">2</span>
        <div class="flow-body">
          <div class="flow-title">Anything unmatched falls through to
            <b>${toAi ? 'AI triage' : esc(def)}</b></div>
          <div class="flow-sub">${toAi
            ? 'The AI reads each leftover message and decides whether it genuinely needs you.'
            : `Unmatched mail takes the <b>${esc(def)}</b> action directly — the AI never sees it.`}</div>
        </div>
      </div>
      ${toAi ? `
      <div class="flow-step">
        <span class="flow-n">3</span>
        <div class="flow-body">
          <div class="flow-title with-control">
            <span>If the AI decides nothing needs doing →</span>
            <span id="clear-pick"></span>
          </div>
          <div class="flow-sub">FYI and noise only. Anything it flags as needing you is left alone
            and shows up under <b>Waiting on you</b>.</div>
        </div>
      </div>` : ''}
    </div>`;

  $('#view-rules').innerHTML = `
    <div class="rule-toolbar">
      <span id="acct-pick"></span>
      <button class="action-btn" id="add-rule">Add rule</button>
    </div>
    ${flow}
    ${rows || '<div class="empty-state">No rules — everything goes straight to AI triage.</div>'}
    ${adding}`;

  const acctSel = lucidos.ui.Select.create({
    options: state.accounts.map((a) => ({
      value: a.name,
      label: a.name.replace(/^Gmail\s*-\s*/i, ''),
    })),
    value: acct.name,
    onChange: (name) => {
      if (name === state.selectedAccount) return;
      state.selectedAccount = name;
      state.editing = null;
      renderRules();
    },
  });
  $('#acct-pick').replaceWith(acctSel.element);

  const clearSlot = $('#clear-pick');
  if (clearSlot) {
    const clearSel = lucidos.ui.Select.create({
      options: CLEAR_MODES.map((m) => ({ value: m.value, label: m.label })),
      value: acct.block.no_action_clear || 'keep',
      onChange: (mode) => saveConfig(
        () => { state.config.accounts[acct.name].no_action_clear = mode; },
        `No-action mail on ${acct.name.replace(/^Gmail\s*-\s*/i, '')}: ${
          (CLEAR_MODES.find((m) => m.value === mode) || {}).label}`),
    });
    clearSlot.replaceWith(clearSel.element);
  }

  lucidos.ui.enhanceSelects();
}

function renderEditor(d, index) {
  const opt = (list, v) => list.map((x) =>
    `<option value="${x}" ${x === v ? 'selected' : ''}>${x}</option>`).join('');
  return `
    <div class="editor" data-editor>
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
        <select id="ed-action" class="lucidos-select">${opt(ACTIONS, d.action)}</select>
      </div>
      <div class="wide">
        <label for="ed-value">Value</label>
        <input id="ed-value" type="text" value="${esc(d.value)}" placeholder="e.g. notifications@github.com">
      </div>
      <div class="editor-actions">
        <button class="action-btn action-btn-confirm" data-save="${index === null ? 'new' : index}">Save</button>
        <button class="action-btn action-btn-secondary" data-cancel>Cancel</button>
      </div>
    </div>`;
}

/* ---------- render: activity ---------- */

function renderActivity() {
  const all = state.runs;
  const scoped = state.runFilter === 'all'
    ? all
    : all.filter((ev) => accountsInRun(ev).includes(state.runFilter));

  const suggestions = scoped.flatMap((ev) => {
    const notes = ev.payload?.run_notes;
    return (Array.isArray(notes) ? notes : notes ? [notes] : [])
      .map((text) => ({ text, created: ev.created }));
  });

  const sugHtml = suggestions.length
    ? suggestions.map((s) => `
        <div class="suggestion">
          <div class="run-when">${esc(lucidos.utils.timeAgo(s.created))}</div>
          <p>${esc(s.text)}</p>
        </div>`).join('')
    : `<div class="empty-state">No suggestions from these runs.</div>`;

  // Clamp the page: the filter may have shrunk the list under our feet.
  const pageCount = Math.max(1, Math.ceil(scoped.length / RUNS_PER_PAGE));
  state.runPage = Math.min(Math.max(0, state.runPage), pageCount - 1);
  const from = state.runPage * RUNS_PER_PAGE;
  const page = scoped.slice(from, from + RUNS_PER_PAGE);

  const runsHtml = page.length
    ? page.map((ev) => {
        const results = ev.payload?.account_results || {};
        // With a single account in view the name prefix on every chip is noise.
        const showAcct = state.runFilter === 'all';
        const counts = Object.entries(results).flatMap(([acct, r]) =>
          Object.entries(r)
            .filter(([, v]) => typeof v === 'number' && v > 0)
            .map(([k, v]) => `<span class="count">${
              showAcct ? `${esc(shortName(acct))} ` : ''}${esc(k)} ${v}</span>`));
        return `
          <div class="run">
            <div class="run-when">${esc(lucidos.utils.timeAgo(ev.created))} · ${esc(lucidos.utils.formatDate(ev.created))}</div>
            <div class="run-summary">${esc(ev.payload?.summary || '')}</div>
            ${counts.length ? `<div class="counts">${counts.join('')}</div>` : ''}
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
    <div class="run-toolbar">
      <span id="run-pick"></span>
      <span class="hint">${scoped.length} run${scoped.length === 1 ? '' : 's'} · ${span}</span>
    </div>
    <div class="section-head">
      <h2>Suggestions from runs</h2>
      <span class="hint">What triage flagged instead of asking</span>
    </div>
    <div class="card">${sugHtml}</div>
    <div class="section-head" id="run-history-head">
      <h2>Run history</h2>
    </div>
    <div class="card">${runsHtml}</div>
    ${pagerHtml}`;

  const runSel = lucidos.ui.Select.create({
    options: [
      { value: 'all', label: 'All accounts' },
      ...state.accounts.map((a) => ({ value: a.name, label: shortName(a.name) })),
    ],
    value: state.runFilter,
    onChange: (v) => {
      if (v === state.runFilter) return;
      state.runFilter = v;
      state.runPage = 0;  // a new account starts at its newest run
      renderActivity();
    },
  });
  $('#run-pick').replaceWith(runSel.element);

  const goto = (n) => {
    state.runPage = n;
    renderActivity();
    // Land on the top of the new page instead of staying at the pager.
    $('#run-history-head')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#run-prev')?.addEventListener('click', () => goto(state.runPage - 1));
  $('#run-next')?.addEventListener('click', () => goto(state.runPage + 1));
}

function render() {
  // Coming back from the setup state (config just appeared) — restore chrome.
  $('#view-setup').hidden = true;
  $('#tabs').hidden = false;
  $('#refresh').hidden = false;
  $('.foot').hidden = false;
  renderOverview();
  if (state.tab === 'rules') renderRules();
  if (state.tab === 'activity') renderActivity();
  for (const t of ['overview', 'rules', 'activity']) {
    $(`#view-${t}`).hidden = state.tab !== t;
  }
}

/* ---------- persistence ---------- */

async function saveConfig(mutate, message) {
  mutate();
  try {
    await lucidos.data.write(CFG, JSON.stringify(state.config, null, 2));
    lucidos.ui.toast(message, 'success');
  } catch (e) {
    lucidos.ui.toast(`Could not save: ${e.message}`, 'error');
    await load();
    return;
  }
  render();
}

function currentAccount() {
  const name = state.selectedAccount || state.accounts[0]?.name;
  return state.accounts.find((a) => a.name === name);
}

/* ---------- events ---------- */

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (!btn) return;
  state.tab = btn.dataset.tab;
  for (const b of document.querySelectorAll('[data-tab]')) {
    b.classList.toggle('active', b === btn);
  }
  render();
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

$('#view-rules').addEventListener('click', async (e) => {
  const acct = currentAccount();
  if (!acct) return;
  const rules = acct.block.rules || (acct.block.rules = []);

  const add = e.target.closest('#add-rule');
  if (add) {
    state.editing = {
      account: acct.name,
      index: null,
      draft: { field: 'from', operator: 'contains', value: '', action: 'delete' },
    };
    return renderRules();
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
    const rule = {
      action: $('#ed-action').value,
      condition: {
        field: $('#ed-field').value,
        operator: $('#ed-op').value,
        value,
      },
    };
    const at = save.dataset.save;
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
});

document.addEventListener('click', (e) => {
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
lucidos.sse.on('EmailTriageCompleted', () => {
  // A run just finished. Refresh unless the user is mid-edit — reloading
  // would discard the open editor and any typed value.
  if (state.editing) return;
  load();
});
load();
