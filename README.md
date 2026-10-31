# lucidos-plugins

Plugins for [Lucidos](https://lucidos.dev/).

Register this repo as a marketplace in Lucidos (**Settings → Marketplaces**) to
browse and install these from the Plugins panel:

```
https://github.com/akramsaouri/lucidos-plugins
```

Or install one directly by pasting its tree URL.

## Plugins

| Plugin | What it does |
|---|---|
| [inbox](./inbox) | **Email: install this, that's all.** A smart inbox with triage built in: your rules, then AI, sort each mailbox on a schedule, and what needs you sits apart, with the reason. A retro brings back what triage wrongly cleared. Reply with AI help. |
| [gatekeepr](./gatekeepr) | Know when your Appgate VPN session expires. Reads it with the [gatekeepr](https://github.com/akramsaouri/gatekeepr) CLI (macOS) and shows it as a countdown-timer widget and an app with session details and history. Notifies at 30 and 5 minutes left and on expiry, once per session, from a background script trigger that setup creates (every 5 minutes, adjustable in the app; no LLM per check). |
| [pulls](./pulls) | Every pull request that's on you, in one place: your own PRs and what's blocking them, next to the reviews waiting on you, each already prepped with a read-only multi-agent review. Buttons resolve conflicts, ask a coding agent, quiz you, open the PR and optionally merge it; merged PRs you reviewed become recall cards. One tab per GitHub owner, plus a Home widget. Setup asks for your GitHub login and repos and offers the sweep schedules. Needs the `gh` CLI, local clones and the pr-understanding Claude Code skills. |
| [browser-learning](./browser-learning) | Self-healing site knowhow for browser automation. Agents read what's known about a site before driving it and record what they learn as events; a nightly reflection pass folds those into per-site knowhow under `knowhow/sites/` and keeps an index so the next agent finds it. Knowhow only. Setup creates the reflection trigger, or reuses the one you already have. Your site files and index are never shipped, overwritten or removed by the plugin. |
| [trigger-timeline](./trigger-timeline) | An agenda for your scheduled triggers that stays readable when you have a lot of them. Steady-cadence triggers collapse into a “Running on a loop” band with 24h density sparklines instead of one row per fire; same-minute fires stack, days fold to a named preview, failed runs get an attention rail. Comes with a Cadence Home widget counting down to the next timed trigger. Read-only — it projects your existing crons forward and writes nothing. |
