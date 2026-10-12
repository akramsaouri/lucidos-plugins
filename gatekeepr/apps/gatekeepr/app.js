/* Gatekeepr: the Appgate VPN session, its history, and the expiry alert settings.
 *
 * An app frame can't run the gatekeepr CLI, so this app only reads files. scripts/gatekeepr/check.py writes
 * artifacts/gatekeepr/status.json and history.json; it runs on the 5-minute cron trigger plugin setup creates,
 * and on the shipped "Gatekeepr — check now" trigger, which Check now reaches by emitting GatekeeprCheckRequested.
 * Each check that changes something, or answers a request, emits GatekeeprStatusChecked, and the app redraws.
 * settings.json is this app's, and check.py reads it on every run. Its schema is in knowhow/gatekeepr/expiry-alerts.md. */
lucidos.ui.applyPreferences();
lucidos.ui.watchPreferences();

const DIR = 'artifacts/gatekeepr/';
const SCRIPT = 'scripts/gatekeepr/check.py';
const EVERY_5_MIN = '0 */5 * * * *';
const FRESH_MS = 60e3;   // on open, a snapshot older than this asks for a check
const DEFAULT_ALERTS = [
  { id: 'warn', kind: 'before', minutes: 30, enabled: true },
  { id: 'final', kind: 'before', minutes: 5, enabled: true },
  { id: 'expired', kind: 'expired', enabled: true },
  { id: 'problem', kind: 'problem', enabled: true },
];
const ALERT_COPY = {
  warn: { name: 'First warning' },
  final: { name: 'Final warning' },
  expired: { name: 'On expiry', help: 'Notify when the session runs out.' },
  problem: { name: 'When the check can’t read the session', help: 'Notify once if the CLI goes missing or can’t read the Appgate logs, since no other alert can fire then.' },
};
const OUTCOME = {
  active: ['Active', 'label'],
  renewed: ['Renewed', 'label label-success'],
  expired: ['Expired', 'label label-warning'],
  signedOut: ['Signed out', 'label label-neutral'],
  interrupted: ['Interrupted', 'label label-error'],
};
const END_KIND = { clientClosed: 'closed by the client', clientRestarted: 'client restarted', driverRestarted: 'driver restarted', renewed: 'renewed' };
const HISTORY_ROWS = 8;

const S = { status: null, history: null, settings: {}, schedule: undefined, pending: null, showAll: false };
const $ = (id) => document.getElementById(id);
const esc = (s) => lucidos.utils.escapeHtml(String(s));
const escAttr = (s) => lucidos.utils.escapeHtmlAttr(String(s));

// ---------- formatting (local time on this device) ----------
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const day = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const dayClock = (iso) => `${day(iso)}, ${clock(iso)}`;
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
function fmtLeft(s) {            // the CLI's timeLeft style: 6h08m, 25m, <1m, rounded down
  if (s < 60) return '<1m';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}
function fmtLength(s) {          // a session length, to the nearest minute as the CLI prints it: 86399 s is 24h00m
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- reading ----------
async function readJson(name) {
  try {
    return JSON.parse(await lucidos.data.read(DIR + name));
  } catch (e) {
    if (e && e.httpCode === 404) return null;
    throw e;
  }
}

async function loadSnapshots() {
  const [status, history] = await Promise.allSettled([readJson('status.json'), readJson('history.json')]);
  if (status.status === 'fulfilled') S.status = status.value;
  if (history.status === 'fulfilled') S.history = history.value;
}

async function loadSettings() {
  try {
    const s = await readJson('settings.json');
    S.settings = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch (e) {
    S.settings = {};
    lucidos.ui.toast('Couldn’t read the Gatekeepr settings, so the defaults are shown', 'warning');
  }
}

async function loadSchedule() {
  try {
    const all = await lucidos.triggers.list();
    S.schedule = all.find((t) => t.run && t.run.type === 'script' && String(t.run.path || '').endsWith(SCRIPT)
      && (t.cron_expressions || []).length) || null;
  } catch (e) {
    S.schedule = undefined;
  }
  renderSchedule();
}

// ---------- the session ----------
/* Expiry is never recomputed: between checks the CLI's secondsLeft counts down by the time since its `now`,
 * which lands on its own expiresAt, and the state turns with its warnThresholdSeconds. */
function view(w) {
  if (!w) return { tone: 'muted', value: '–', headline: 'No check yet' };
  const s = w.status || {};
  if (!w.ok) return { tone: 'muted', value: 'Can’t check', word: true, problem: true };
  if (s.state === 'noSession') return { tone: 'muted', value: 'No session', word: true, headline: 'No Appgate session anywhere in the logs' };
  if (s.state === 'signedOut') return { tone: 'muted', value: 'Signed out', word: true, chip: ['Signed out', 'label label-neutral'], headline: s.sessionEnd ? `since ${dayClock(s.sessionEnd)}` : '' };
  const left = s.secondsLeft - Math.floor((Date.now() - Date.parse(s.now)) / 1000);
  if (s.state === 'expired' || left <= 0) return { tone: 'danger', value: 'Expired', word: true, chip: ['Expired', 'label label-error'], headline: `expired ${clock(s.expiresAt)}`, left: Math.min(left, 0) };
  const soon = left <= s.warnThresholdSeconds;
  return {
    tone: soon ? 'warning' : 'normal', value: fmtLeft(left), label: 'left', left,
    chip: soon ? ['Expiring soon', 'label label-warning'] : ['Active', 'label label-success'],
    headline: `expires ${clock(s.expiresAt)}`,
    fraction: Math.max(0, Math.min(1, left / s.sessionLengthSeconds)),
  };
}

const PROBLEM_HINT = {
  not_installed: 'Install gatekeepr v0.3.0 or later, or set its path under Gatekeepr CLI below.',
  unsupported_schema: 'The CLI and this plugin read different JSON versions. Update whichever is older.',
  usage: 'This gatekeepr is too old for --json. Install v0.3.0 or later.',
  cli: 'gatekeepr couldn’t make sense of the Appgate logs. Expiry alerts are off until it can.',
};

function renderHero() {
  const v = view(S.status);
  $('hero').dataset.tone = v.tone;
  $('ring').style.setProperty('--ring-value', v.fraction || 0);
  $('value').textContent = v.value;
  $('value').classList.toggle('is-word', !!v.word);
  $('label').textContent = v.label || '';
  $('ring').setAttribute('aria-label', ['Appgate VPN', v.value + (v.label ? ' ' + v.label : ''), v.headline].filter(Boolean).join(', '));
  $('headline').innerHTML = (v.chip ? `<span class="${v.chip[1]}">${esc(v.chip[0])}</span>` : '') + (v.headline ? `<span>${esc(v.headline)}</span>` : '');
  $('headline').hidden = !v.chip && !v.headline;

  $('problem').hidden = !v.problem;
  if (v.problem) {
    const w = S.status;
    $('problem-text').textContent = (w.status && w.status.error) || 'The check failed.';
    $('problem-hint').textContent = PROBLEM_HINT[w.error_kind] || '';
    $('problem-actions').innerHTML = w.error_kind === 'not_installed' || w.error_kind === 'usage'
      ? '<button class="action-btn" data-act="install">Help me install it</button>' : '';
  }

  $('check').disabled = !!S.pending;
  $('check').innerHTML = S.pending ? '<span class="mini-spinner" aria-hidden="true"></span> Checking' : 'Check now';
  $('checked').textContent = S.status ? `checked ${lucidos.utils.timeAgo(S.status.checked_at)}` : '';
}

function renderFacts() {
  const s = S.status && S.status.ok ? S.status.status : null;
  $('session-section').hidden = !s;
  if (!s) return;
  const rows = [];
  if (s.sessionStart) {
    const v = view(S.status);
    rows.push(['Signed in', dayClock(s.sessionStart)]);
    rows.push([s.secondsLeft < 0 || s.state === 'expired' ? 'Expired' : 'Expires', dayClock(s.expiresAt)]);
    if (s.state === 'active' || s.state === 'expiringSoon') rows.push(['Time left', v.left > 0 ? fmtLeft(v.left) : '0m']);
    if (s.sessionEnd) rows.push(['Ended', dayClock(s.sessionEnd)]);
    rows.push(['Started by', s.sessionStartKind === 'renewal' ? 'Renewal from Appgate’s expiry warning' : 'Sign-in']);
    rows.push(['Expiry from', s.expirySource === 'renewalNotification' ? 'Appgate’s 5-minute renewal countdown' : 'Sign-in plus the session length']);
  }
  rows.push(['Session length', s.sessionLengthSource === 'median'
    ? `${fmtLength(s.sessionLengthSeconds)}, the median of ${plural(s.sessionLengthLearnedFrom, 'measured session')}`
    : `${fmtLength(s.sessionLengthSeconds)} by default: no session measured yet`]);
  $('facts').innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

function renderHistory() {
  const box = $('history');
  const h = S.history;
  if (!h) {
    box.innerHTML = '<div class="empty">No history yet. It appears after the first check.</div>';
    $('history-count').textContent = '';
    return;
  }
  if (!h.ok) {
    box.innerHTML = `<div class="empty">${esc((h.history && h.history.error) || 'History couldn’t be read.')}</div>`;
    $('history-count').textContent = '';
    return;
  }
  const sessions = (h.history.sessions || []).slice().reverse();   // the CLI lists oldest first
  $('history-count').textContent = sessions.length ? plural(sessions.length, 'session') : '';
  if (!sessions.length) {
    box.innerHTML = '<div class="empty">No sessions in the Appgate logs.</div>';
    return;
  }
  const shown = S.showAll ? sessions : sessions.slice(0, HISTORY_ROWS);
  box.innerHTML = '<div class="list-rows">' + shown.map((x) => {
    const [word, cls] = OUTCOME[x.outcome] || [x.outcome, 'label label-neutral'];
    const end = x.end ? (sameDay(x.start, x.end) ? clock(x.end) : dayClock(x.end)) : 'now';
    const bits = [x.startKind === 'renewal' ? 'renewal' : 'sign-in'];
    if (x.endKind && END_KIND[x.endKind] && x.outcome !== 'renewed') bits.push(END_KIND[x.endKind]);
    bits.push(plural(x.reconnects, 'reconnect'));
    if (x.measuredLengthSeconds) bits.push(`measured ${fmtLength(x.measuredLengthSeconds)}`);
    return `<div class="list-row hist-row">
        <div class="hist-when">${esc(dayClock(x.start))} → ${esc(end)}</div><span class="${cls}">${esc(word)}</span>
        <div class="list-row-details">${bits.map((b) => `<span>${esc(b)}</span>`).join('')}</div>
      </div>`;
  }).join('') + '</div>'
    + (sessions.length > HISTORY_ROWS
      ? `<div class="more"><button class="action-btn action-btn-secondary" data-act="more">${S.showAll ? 'Show fewer' : `Show all ${sessions.length}`}</button></div>`
      : '');
}

// ---------- settings ----------
function alerts() {
  const saved = Array.isArray(S.settings.alerts) ? S.settings.alerts : [];
  return DEFAULT_ALERTS.map((d) => ({ ...d, ...(saved.find((a) => a && a.id === d.id) || {}) }));
}

function renderAlerts() {
  $('alerts').innerHTML = alerts().map((a) => {
    const copy = ALERT_COPY[a.id];
    const help = a.kind === 'before'
      ? `Notify with <input class="text-input mins" type="number" min="1" max="1440" step="1" inputmode="numeric" data-mins="${a.id}" value="${Number(a.minutes)}" aria-label="${escAttr(copy.name)} threshold in minutes"> minutes left`
      : esc(copy.help);
    return `<div class="setting"><div class="setting-text"><div class="setting-name">${esc(copy.name)}</div><div class="setting-help">${help}</div></div>
      <label class="toggle-switch"><input type="checkbox" role="switch" data-alert="${a.id}" aria-label="${escAttr(copy.name)}"${a.enabled ? ' checked' : ''}><span class="toggle-slider"></span></label></div>`;
  }).join('');
}

function renderSchedule() {
  const t = S.schedule;
  const name = $('schedule-name'), help = $('schedule-help');
  $('schedule-setup').hidden = t !== null;
  if (t === undefined) {
    name.textContent = 'Couldn’t read the triggers';
    help.textContent = '';
    return;
  }
  if (t === null) {
    name.innerHTML = '<span class="label label-warning">Not scheduled</span>';
    help.textContent = 'Without the 5-minute check, alerts fire only while this app or the VPN expiry widget is open.';
    return;
  }
  const cadence = t.cron_expressions.length === 1 && t.cron_expressions[0] === EVERY_5_MIN ? 'Every 5 minutes' : `On ${t.cron_expressions.join(', ')}`;
  name.innerHTML = esc(cadence) + (t.paused ? ' <span class="label label-neutral">Paused</span>'
    : t.last_run_status === 'failed' ? ' <span class="label label-error">Last run failed</span>' : '');
  help.textContent = [t.name, t.last_run ? `last run ${lucidos.utils.timeAgo(t.last_run)}` : 'not run yet'].join(' · ');
}

function renderCli() {
  const input = $('binary');
  if (document.activeElement !== input) input.value = S.settings.binary_path || '';
  const w = S.status;
  const lines = [];
  if (w && w.binary) lines.push(`Using ${esc(w.binary)}`);
  else if (w && w.error_kind === 'not_installed') lines.push('<span class="warn-line">Not found.</span> Looked in: ' + esc((w.tried || []).join(', ')));
  else lines.push('Empty means: PATH, then ~/go/bin/gatekeepr, then /usr/local/bin/gatekeepr.');
  for (const note of (w && w.notes) || []) lines.push(`<span class="warn-line">${esc(note)}</span>`);
  $('binary-help').innerHTML = lines.join('<br>');
}

function render() {
  renderHero();
  renderFacts();
  renderHistory();
  renderCli();
}

let saveTimer;
function saveSoon(then) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await lucidos.data.write(DIR + 'settings.json', JSON.stringify(S.settings, null, 2) + '\n');
      lucidos.ui.toast('Saved', 'success', { key: 'gatekeepr-saved', durationMs: 1500 });
      if (then) then();
    } catch (e) {
      lucidos.ui.toast('Couldn’t save the settings', 'error');
    }
  }, 400);
}

function setAlert(id, patch) {
  const list = Array.isArray(S.settings.alerts) ? S.settings.alerts : [];
  const merged = alerts().map((a) => (a.id === id ? { ...a, ...patch } : a));
  // Keep any entry this app doesn't draw, so a hand-added alert survives a save.
  S.settings.alerts = merged.concat(list.filter((a) => a && !DEFAULT_ALERTS.some((d) => d.id === a.id)));
  saveSoon();
}

// ---------- checks ----------
async function ask(auto) {
  if (S.pending) return;
  const id = 'app-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  S.pending = id;
  renderHero();
  setTimeout(() => {
    if (S.pending !== id) return;
    S.pending = null;
    renderHero();
    if (!auto) lucidos.ui.toast('No answer from the check yet. Is the “Gatekeepr — check now” trigger paused?', 'warning');
  }, 20e3);
  try {
    await lucidos.events.emit('GatekeeprCheckRequested', { summary: 'Gatekeepr app asked for a check', request_id: id, source: 'app' });
  } catch (e) {
    S.pending = null;
    renderHero();
    if (!auto) lucidos.ui.toast('Couldn’t ask for a check', 'error');
  }
}

async function refresh() {
  await loadSnapshots().catch(() => {});
  render();
}

// ---------- wiring ----------
$('check').addEventListener('click', () => ask(false));
$('schedule-setup').addEventListener('click', () => lucidos.ui.startThread({
  prompt: 'Set up the Gatekeepr plugin’s 5-minute expiry check: the script trigger running scripts/gatekeepr/check.py every 5 minutes.',
}));
document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'more') { S.showAll = !S.showAll; renderHistory(); }
  if (act.dataset.act === 'install') lucidos.ui.startThread({ prompt: 'Help me install the gatekeepr CLI for the Gatekeepr plugin.' });
});
$('alerts').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.alert) setAlert(t.dataset.alert, { enabled: t.checked });
  if (t.dataset.mins) {
    const n = Number(t.value);
    if (!Number.isInteger(n) || n < 1 || n > 1440) {
      lucidos.ui.toast('Use a whole number of minutes from 1 to 1440', 'warning');
      renderAlerts();
      return;
    }
    setAlert(t.dataset.mins, { minutes: n });
  }
});
$('binary').addEventListener('change', (e) => {
  const value = e.target.value.trim();
  if (value) S.settings.binary_path = value;
  else delete S.settings.binary_path;
  saveSoon(() => ask(true));   // re-check with the new path, so "Using …" reflects it
});
$('binary').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

lucidos.sse.connect();
lucidos.sse.on('GatekeeprStatusChecked', (data) => {
  if (data && data.request_id && data.request_id === S.pending) S.pending = null;
  refresh();
});
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60e3);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refresh(); loadSchedule(); } });

(async function boot() {
  await Promise.all([loadSnapshots().catch(() => {}), loadSettings()]);
  render();
  renderAlerts();
  lucidos.ui.ready();
  loadSchedule();
  if (!S.status || Date.now() - Date.parse(S.status.checked_at) > FRESH_MS) ask(true);
})();
