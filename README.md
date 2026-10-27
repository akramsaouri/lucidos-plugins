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
| [pulls](./pulls) | A Home widget for the Pulls app: how many pull requests are on you right now, split into your own PRs blocked on you, reviews waiting on you and PRs ready to merge. Needs the Pulls app (`review-cockpit`) and its sweeps' data, which this plugin doesn't ship: without them the widget says the app isn't installed or has no data yet. |
| [trigger-timeline](./trigger-timeline) | An agenda for your scheduled triggers that stays readable when you have a lot of them. Steady-cadence triggers collapse into a “Running on a loop” band with 24h density sparklines instead of one row per fire; same-minute fires stack, days fold to a named preview, failed runs get an attention rail. Comes with a Cadence Home widget counting down to the next timed trigger. Read-only — it projects your existing crons forward and writes nothing. |
