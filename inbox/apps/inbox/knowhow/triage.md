---
name: Inbox Triage Controls
description: Where the email triage controls live in the Inbox app (sidebar Triage entries, the triage pane), what each control writes or emits, and the invariants they keep on artifacts/email-triage/config.json, pause/resume, Triage now and the triage retro's Retro section. Load before changing triage.js, or when a pause, a rule edit or a manual run misbehaves
---

# Inbox triage controls

The triage control panel lives in the Inbox, in `triage.js`. `app.js` only routes: it puts the entries in the sidebar and swaps the list (and the reader beside it) for the triage pane.

## Where they are

- **All accounts**: the strip at the top of the sidebar. One dot per account in its colour (hollow = paused, yellow = needs a look), and a line such as "All active · next 14:00". It opens health for every account with Pause all / Triage all accounts, the **Retro** section, suggestions from runs, and run history across accounts.
- **Per account**: a **Triage** entry heads each account's folded folder group, showing "Paused", "Triaging…" or the next run time. It never waits on the folder list. It opens the account's health and next run, Pause/Resume, Triage now, the rule chain editor (with unreachable-rule detection and the no-action mail picker), suggestions and run history.
- Esc, the "← Inbox" link, or any mailbox or folder in the sidebar leaves the pane. The list's keys are off while it is open.

## Invariants

- **Pause is the config flag.** `paused: true` in the account's block of `artifacts/email-triage/config.json` is the source of truth: the intent both callers run (the cron trigger, and the on-demand trigger behind Triage now) reads it. Resume **deletes** the key, never writes `false`.
- **The trigger is best-effort.** After the config write lands, pause/resume also updates the account's cron trigger, found by `Mail.triggerFor`, the same matcher `loadContext` uses: a trigger with a cron whose name mentions triage and the account's short name (punctuation-blind, so setup's `Inbox triage — <Account>` matches, and so does `Email Triage — <Account>`, the name setup gave crons before Inbox 1.0.0), and never one that names a longer account containing it (`Inbox triage — Mailhost Work` is not Work's). A missing or refused trigger is a warning toast: the config change stands. The shared on-demand trigger ("Inbox — triage on demand") has no cron, so it is never paused.
- **A broken engine is never silent.** On every load the pane checks that `triggers/inbox-triage/intents/triage.md` and `knowhow/inbox-triage.md` exist, that a trigger answers Triage now ("Inbox — triage on demand"), and that no account's cron names a workspace file (`knowhow/`, `triggers/`, `scripts/` or `apps/`, `.md` or `.py`) that is gone. Any miss shows a "Triage engine missing. Run Inbox setup to repair." banner above the sidebar's Triage strip and atop the pane, saying what is wrong. A refused trigger list reports no trigger as missing.
- **Triage now** emits `EmailTriageRequested`, which the on-demand trigger ("Inbox — triage on demand", shipped by this plugin) answers: `{summary: "Manual triage run for <name without 'Gmail - '>", account: "<config name>", source: "inbox-app"}`, one event per account. A paused account never emits. The button spins until that account's `EmailTriageCompleted` arrives, or gives up after 5 minutes.
- **config.json writes are lossless.** Every live triage run reads this file. `saveConfig` re-reads it, applies the edit to what is on disk, and writes it back in the file's own style (`serializeLike`: indent, `\u` escapes and their case, line endings, trailing newline; Python's `json.dump(indent=2)` gives ASCII-only, lowercase escapes, no trailing newline). Keys it doesn't edit survive, an unchanged edit writes nothing, and a rule edit refuses if that account's chain changed on disk since the pane loaded.
- **The Retro switch is the setting.** The Retro section (All accounts only, since a retro covers every account) writes `retro.enabled` and `retro.schedule` (`twice-weekly`, the default, `weekly` or `daily`) in `artifacts/inbox/settings.json`, re-read and written in the file's own style like config.json. A settings file that doesn't parse is never written, and the section says so. The daily schedule check (`scripts/inbox-triage/retro_tick.py`) and the retro itself both read the setting, so off is off on the next evening with no trigger edit. See `knowhow/inbox-triage-retro.md`.
- **The schedule check must exist.** It is a workspace cron (a plugin can't ship one), found by its script path `scripts/inbox-triage/retro_tick.py` or its name, `Inbox — triage retro schedule`. Turning the retro on creates it when it's missing (`0 0 20 * * *`, a script run). While the retro is on, a missing check shows "No schedule check yet" with a button to add it, and a paused one offers Resume.
- **Retro now** emits `InboxTriageRetroRequested` `{summary, source: "inbox-app"}`, which "Inbox — triage retro" (shipped by this plugin) answers. It spins until `InboxTriageRetroCompleted` arrives, or gives up after 15 minutes. The newest completion's summary, counts and `suggestions` show under the controls.
- **Rule shape**: `{action, condition: {field, operator, value}, label?}`. Editing starts from the rule on disk, so `_comment`, a notion `target` or any other key keeps its place. A new rule takes the file's sorted key order. `label` exists only for the `label` action.
- **Reasons follow edits.** After any write or reload, `triage.js` hands the config to `app.js`, which runs it through `Mail.configCtx` (the same function `loadContext` uses) and re-classifies the list. A new rule's "Your rules would …" hint shows without a reload.

## Tests

The plugin repo's `tests/inbox/triage/triage.test.js` runs the app under jsdom with `lucidos.*` stubbed against a made-up config, and records writes, emits and trigger updates instead of making them. Run it from a checkout of the plugin repo:

```sh
cd tests/inbox/triage && npm install && npm test
```
