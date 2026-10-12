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
| [inbox](./inbox) | One calm inbox across every mailbox Email Triage watches; needs [email-triage](./email-triage) 0.6.0+ set up. Each account splits into what survived triage, with the reason it was kept, and what triage hasn't seen yet. Archive, delete and undo by key or swipe, AI-assisted replies, and each account's folders and labels in the sidebar. Gmail reads through one engine proxy per mailbox; password IMAP accounts go through the IMAP bridge trigger it ships. |
| [gatekeepr](./gatekeepr) | Know when your Appgate VPN session expires. Reads it with the [gatekeepr](https://github.com/akramsaouri/gatekeepr) CLI (macOS) and shows it as a draining-ring widget and an app with session details and history. Notifies at 30 and 5 minutes left and on expiry, once per session, from a 5-minute script trigger that setup creates (no LLM per check). |
| [trigger-timeline](./trigger-timeline) | An agenda for your scheduled triggers that stays readable when you have a lot of them. Steady-cadence triggers collapse into a “Running on a loop” band with 24h density sparklines instead of one row per fire; same-minute fires stack, days fold to a named preview, failed runs get an attention rail. Read-only — it projects your existing crons forward and writes nothing. |
