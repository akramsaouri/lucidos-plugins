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
| [email-triage](./email-triage) | Per-account email triage that only interrupts you when mail genuinely needs you. Your rules run first (first-match-wins); the rest falls through to AI triage. Ships a control-panel app with a per-account “Triage now” button, the engine knowhow, the per-account intent, and the on-demand trigger. |
| [trigger-timeline](./trigger-timeline) | An agenda for your scheduled triggers that stays readable when you have a lot of them. Steady-cadence triggers collapse into a “Running on a loop” band with 24h density sparklines instead of one row per fire; same-minute fires stack, days fold to a named preview, failed runs get an attention rail. Read-only — it projects your existing crons forward and writes nothing. |
