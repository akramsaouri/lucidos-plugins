/* Gatekeepr: the Appgate VPN session, its history, and the expiry alert settings.
 *
 * An app frame can't run the gatekeepr CLI, so this app only reads files. scripts/gatekeepr/check.py writes
 * artifacts/gatekeepr/status.json and history.json; it runs on the background check (a cron trigger this app
 * can create, pause and reschedule) and on the shipped "Gatekeepr — refresh" trigger, which Refresh reaches by
 * emitting GatekeeprRefreshRequested. Each check that changes something, or answers a request, emits
 * GatekeeprStatusChecked, and the app redraws. settings.json is this app's, and check.py reads it on every run.
 * Its schema is in knowhow/gatekeepr/expiry-alerts.md. */
lucidos.ui.applyPreferences();
lucidos.ui.watchPreferences();

const APP_ID = 'gatekeepr';
const DIR = 'artifacts/gatekeepr/';
const SCRIPT = 'scripts/gatekeepr/check.py';
const SCHEDULE_NAME = 'Gatekeepr — expiry check';
const CADENCES = [1, 2, 5, 10, 15, 30];   // minutes; each divides an hour, so checks stay evenly spaced
const DEFAULT_CADENCE = 5;
const FRESH_MS = 60e3;   // on open, a snapshot older than this asks for a refresh
const DEFAULT_ALERTS = [
  { id: 'warn', kind: 'before', minutes: 30, enabled: true },
  { id: 'final', kind: 'before', minutes: 5, enabled: true },
  { id: 'expired', kind: 'expired', enabled: true },
  { id: 'problem', kind: 'problem', enabled: true },
];
const ALERT_COPY = {
  warn: { name: 'First warning', icon: 'bell' },
  final: { name: 'Final warning', icon: 'bellRing' },
  expired: { name: 'On expiry', icon: 'timerOff', help: 'Notify when the session runs out.' },
  problem: { name: 'When the check can’t read the session', icon: 'alert', help: 'Notify once if the CLI goes missing or can’t read the Appgate logs, since no other alert can fire then.' },
};
const OUTCOME = {
  active: ['Current', 'label'],
  renewed: ['Renewed', 'label label-success'],
  expired: ['Expired', 'label label-warning'],
  signedOut: ['Signed out', 'label label-neutral'],
  interrupted: ['Interrupted', 'label label-error'],
};
const END_KIND = { clientClosed: 'closed by the client', clientRestarted: 'client restarted', driverRestarted: 'driver restarted', renewed: 'renewed' };
const HISTORY_ROWS = 8;

/* Lucide-style 24px stroke icons, drawn in currentColor. */
const BELL = '<path d="M10.27 21a2 2 0 0 0 3.46 0"/><path d="M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33"/>';
const ICONS = {
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  renewal: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  logIn: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
  logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  alarm: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/><path d="M6.38 18.7 4 21"/><path d="M17.64 18.67 20 21"/>',
  hourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  ruler: '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/>',
  wifi: '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/>',
  bell: BELL,
  bellRing: BELL + '<path d="M22 8c0-2.3-.8-4.3-2-6"/><path d="M4 2C2.8 3.7 2 5.7 2 8"/>',
  timerOff: '<path d="M10 2h4"/><path d="M4.6 11a8 8 0 0 0 1.7 8.7 8 8 0 0 0 8.7 1.7"/><path d="M7.4 7.4a8 8 0 0 1 10.3 1 8 8 0 0 1 .9 10.2"/><path d="m2 2 20 20"/><path d="M12 12v-2"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  chevD: '<path d="m6 9 6 6 6-6"/>',
  chevU: '<path d="m18 15-6-6-6 6"/>',
};
const ic = (n) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

const S = { status: null, history: null, settings: {}, schedule: undefined, cadence: DEFAULT_CADENCE, scheduleBusy: false, pending: null, showAll: false };
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
const every = (m) => (m === 1 ? 'every minute' : `every ${m} minutes`);
const cronFor = (m) => (m === 1 ? '0 * * * * *' : `0 */${m} * * * *`);
function cadenceOf(t) {          // the minutes of a schedule this app writes, or null for a hand-written cron
  const crons = t.cron_expressions || [];
  const m = crons.length === 1 ? crons[0].trim().match(/^0 \*(?:\/(\d+))? \* \* \* \*$/) : null;
  const n = m ? Number(m[1] || 1) : NaN;
  return CADENCES.includes(n) ? n : null;
}

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
    if (S.schedule && cadenceOf(S.schedule)) S.cadence = cadenceOf(S.schedule);
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
    chip: soon ? ['Expiring soon', 'label label-warning'] : ['Signed in', 'label label-success'],
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
      ? `<button class="action-btn" data-act="install">${ic('download')}Help me install it</button>` : '';
  }

  $('refresh').disabled = !!S.pending;
  $('refresh').innerHTML = S.pending ? '<span class="mini-spinner" aria-hidden="true"></span> Refreshing' : `${ic('refresh')}Refresh`;
  $('checked').textContent = S.status ? `checked ${lucidos.utils.timeAgo(S.status.checked_at)}` : '';
}

function renderFacts() {
  const s = S.status && S.status.ok ? S.status.status : null;
  $('session-section').hidden = !s;
  if (!s) return;
  const rows = [];
  if (s.sessionStart) {
    const v = view(S.status);
    rows.push(['logIn', 'Signed in', dayClock(s.sessionStart)]);
    rows.push(['alarm', s.secondsLeft < 0 || s.state === 'expired' ? 'Expired' : 'Expires', dayClock(s.expiresAt)]);
    if (s.state === 'active' || s.state === 'expiringSoon') rows.push(['hourglass', 'Time left', v.left > 0 ? fmtLeft(v.left) : '0m']);
    if (s.sessionEnd) rows.push(['logOut', 'Ended', dayClock(s.sessionEnd)]);
    rows.push(s.sessionStartKind === 'renewal' ? ['renewal', 'Started by', 'Renewal from Appgate’s expiry warning'] : ['key', 'Started by', 'Sign-in']);
    rows.push(['info', 'Expiry from', s.expirySource === 'renewalNotification' ? 'Appgate’s 5-minute renewal countdown' : 'Sign-in plus the session length']);
  }
  rows.push(['ruler', 'Session length', s.sessionLengthSource === 'median'
    ? `${fmtLength(s.sessionLengthSeconds)}, the median of ${plural(s.sessionLengthLearnedFrom, 'measured session')}`
    : `${fmtLength(s.sessionLengthSeconds)} by default: no session measured yet`]);
  $('facts').innerHTML = rows.map(([icon, k, v]) => `<div><dt>${ic(icon)}${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
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
    const bits = [x.startKind === 'renewal' ? ['renewal', 'renewal'] : ['logIn', 'sign-in']];
    if (x.endKind && END_KIND[x.endKind] && x.outcome !== 'renewed') bits.push(['logOut', END_KIND[x.endKind]]);
    bits.push(['wifi', plural(x.reconnects, 'reconnect')]);
    if (x.measuredLengthSeconds) bits.push(['ruler', `measured ${fmtLength(x.measuredLengthSeconds)}`]);
    return `<div class="list-row hist-row">
        <div class="hist-when">${esc(dayClock(x.start))} → ${esc(end)}</div><span class="${cls}">${esc(word)}</span>
        <div class="list-row-details">${bits.map(([icon, b]) => `<span>${ic(icon)}${esc(b)}</span>`).join('')}</div>
      </div>`;
  }).join('') + '</div>'
    + (sessions.length > HISTORY_ROWS
      ? `<div class="more"><button class="action-btn action-btn-secondary" data-act="more">${S.showAll ? `${ic('chevU')}Show fewer` : `${ic('chevD')}Show all ${sessions.length}`}</button></div>`
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
    return `<div class="setting"><span class="setting-icon">${ic(copy.icon)}</span><div class="setting-text"><div class="setting-name">${esc(copy.name)}</div><div class="setting-help">${help}</div></div>
      <label class="toggle-switch"><input type="checkbox" role="switch" data-alert="${a.id}" aria-label="${escAttr(copy.name)}"${a.enabled ? ' checked' : ''}><span class="toggle-slider"></span></label></div>`;
  }).join('');
}

/* The background check is the cron trigger running check.py. The switch pauses and resumes it (or creates it,
 * when setup never did), and How often rewrites its cron. The trigger stays the one source of truth, so an edit
 * made in the Triggers panel shows up here. */
const cadencePick = lucidos.ui.Select.create({
  options: CADENCES.map((m) => ({ value: String(m), label: m === 1 ? 'Every minute' : `Every ${m} min` })),
  value: String(DEFAULT_CADENCE),
  placeholder: 'Custom',
  disabled: true,
  onChange: (v) => setCadence(Number(v)),
});
$('cadence').appendChild(cadencePick.element);

function renderSchedule() {
  const t = S.schedule;
  const on = !!t && !t.paused;
  const custom = t && !cadenceOf(t);
  const toggle = $('schedule-on');
  toggle.checked = on;
  toggle.disabled = t === undefined || S.scheduleBusy;
  cadencePick.setDisabled(t === undefined || S.scheduleBusy);
  cadencePick.setValue(custom ? undefined : String(S.cadence));

  const name = 'Check in the background' + (t && !t.paused && t.last_run_status === 'failed' ? ' <span class="label label-error">Last run failed</span>' : '');
  $('schedule-name').innerHTML = name;
  const help = $('schedule-help');
  if (t === undefined) help.textContent = 'Couldn’t read the triggers.';
  else if (!on) help.textContent = `${t ? 'Paused' : 'Off'}. Alerts fire only while this app or the VPN expiry widget is open.`;
  else help.textContent = `Runs gatekeepr ${custom ? 'on its own schedule' : every(S.cadence)}, so alerts arrive with Lucidos in the background${t.last_run ? `. Last run ${lucidos.utils.timeAgo(t.last_run)}` : ''}.`;
  $('cadence-help').textContent = custom ? `Custom: ${t.cron_expressions.join(', ')}`
    : on && t.next_run ? `Next check at ${clock(t.next_run)}` : 'An alert can land up to this long after its threshold.';

  const note = $('alerts-note');
  note.hidden = t === undefined;
  note.textContent = !on ? 'The background check is off, so alerts fire only while this app or the VPN expiry widget is open.'
    : custom ? 'Alerts land at the first background check past their threshold.'
    : `The background check runs ${every(S.cadence)}, so an alert can land up to ${S.cadence === 1 ? 'a minute' : `${S.cadence} minutes`} after its threshold.`;
}

// Resolves to true when the engine took the change. A refusal arrives as a throw or as success: false.
async function applySchedule(change, done) {
  S.scheduleBusy = true;
  renderSchedule();
  let ok = false;
  try {
    const res = await change();
    if (res && res.success === false) throw new Error(res.error || 'refused');
    ok = true;
    const next = res && res.cron_preview && res.cron_preview.next_runs && res.cron_preview.next_runs[0];
    lucidos.ui.toast(done + (next ? `, next at ${clock(next)}` : ''), 'success', { key: 'gatekeepr-schedule' });
    for (const w of (res && res.cron_preview && res.cron_preview.warnings) || []) lucidos.ui.toast(w, 'warning');
  } catch (e) {
    lucidos.ui.toast(`Couldn’t change the background check: ${(e && e.message) || e}`, 'error');
  }
  S.scheduleBusy = false;
  await loadSchedule();
  return ok;
}

function setScheduleOn(on) {
  const t = S.schedule;
  if (t) return applySchedule(() => lucidos.triggers.update(t.id, { paused: !on }), on ? `Background check on, ${every(S.cadence)}` : 'Background check paused');
  if (!on) return renderSchedule();
  return applySchedule(() => lucidos.triggers.create({
    name: SCHEDULE_NAME, run: { type: 'script', path: SCRIPT }, cron_expressions: [cronFor(S.cadence)], app_id: APP_ID,
  }), `Background check on, ${every(S.cadence)}`);
}

function setCadence(minutes) {
  S.cadence = minutes;
  const t = S.schedule;
  if (!t) return renderSchedule();   // applied when the switch turns it on
  return applySchedule(() => lucidos.triggers.update(t.id, { cron_expressions: [cronFor(minutes)] }),
    t.paused ? `Set to ${every(minutes)} (still paused)` : `Checking ${every(minutes)}`);
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

// ---------- refresh ----------
async function ask(auto) {
  if (S.pending) return;
  const id = 'app-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  S.pending = id;
  renderHero();
  setTimeout(() => {
    if (S.pending !== id) return;
    S.pending = null;
    renderHero();
    if (!auto) lucidos.ui.toast('No answer from the check yet. Is the “Gatekeepr — refresh” trigger paused?', 'warning');
  }, 20e3);
  try {
    await lucidos.events.emit('GatekeeprRefreshRequested', { summary: 'Gatekeepr app asked for a refresh', request_id: id, source: 'app' });
  } catch (e) {
    S.pending = null;
    renderHero();
    if (!auto) lucidos.ui.toast('Couldn’t ask for a refresh', 'error');
  }
}

async function reload() {
  await loadSnapshots().catch(() => {});
  render();
}

// ---------- wiring ----------
for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = ic(el.dataset.icon);
$('refresh').addEventListener('click', () => ask(false));
$('schedule-on').addEventListener('change', (e) => setScheduleOn(e.target.checked));
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
  reload();
  loadSchedule();   // a scheduled run moves last_run and next_run
});
setInterval(() => { if (document.visibilityState === 'visible') { reload(); loadSchedule(); } }, 60e3);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { reload(); loadSchedule(); } });

(async function boot() {
  await Promise.all([loadSnapshots().catch(() => {}), loadSettings()]);
  render();
  renderAlerts();
  lucidos.ui.ready();
  loadSchedule();
  if (!S.status || Date.now() - Date.parse(S.status.checked_at) > FRESH_MS) ask(true);
})();
