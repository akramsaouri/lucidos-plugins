---
name: Språkstugan Bank Top-Up
description: How to grow Språkstugan's vocabulary bank when the app reports it is running low — reading the SprakstuganBankRunningLow payload, appending words/particles/structures to artifacts/sprakstugan/content.json without breaking progress, and how many to add. Load when the sprakstugan-bank-topup trigger fires, when the learner asks to top up or refill their Swedish word bank, or when Språkstugan shows the "banken börjar ta slut" banner. Keywords: Språkstugan, bank running low, top up, refill, new words, content.json, vocabulary bank.
---

## What fired this

The app emits `SprakstuganBankRunningLow` when fresh material is nearly gone — 12 or fewer
unseen items, or 75% of the bank mastered. The payload is your brief:

| Field | Use it for |
|---|---|
| `total`, `unseen`, `mastered`, `weak` | how empty the bank actually is |
| `accuracy` | overall %, a sanity check on the current level |
| `weakest_categories` | `[{cat, weak}]` — where they are still losing. **Weight the new batch toward these.** |
| `requested` | `auto` (the app noticed) or `manual` (they pressed *Fyll på nu*) |

## Before writing anything

1. **Read `artifacts/sprakstugan/learner-profile.md`** for their two levels and known weak
   spots, and `apps/sprakstugan/knowhow/calibration.md` for the tier mapping. A batch
   written to the wrong tier is worse than no batch.
2. **Read the existing `artifacts/sprakstugan/content.json`** in full. You are appending to
   it, and you need to know what is already there.
3. **If `mastered` is high and `accuracy` is above ~85%, raise the centre of gravity one
   tier** and say so in the notification — that is the signal their written level moved.
   Update the profile artifact too.

## Writing the batch

Append to the three arrays in `artifacts/sprakstugan/content.json`, keeping `version: 2`
and the exact schema the app reads:

```json
{
  "version": 2,
  "words": [
    { "sv": "kvitto", "en": "receipt", "cat": "Butik", "diff": "medium",
      "ex": { "sv": "Har du kvittot kvar?", "en": "Do you still have the receipt?" },
      "gender": "ett" }
  ],
  "particles": [
    { "id": "p:ge_upp", "prompt": "Du får inte ge ___ nu, vi är nästan klara.",
      "answer": "upp", "options": ["upp", "av", "till", "bort"],
      "en": "You mustn't give up now, we're almost done.",
      "cat": "Partikelverb", "diff": "expert" }
  ],
  "structures": [
    { "id": "s:konditionalis", "prompt": "Säg: \"I would have come if I had had time.\"",
      "model": "Jag hade kommit om jag hade haft tid.",
      "modelEn": "(past conditional — 'hade' + supine in both clauses)",
      "cat": "Konditionalis", "diff": "expert" }
  ]
}
```

Rules that break things if you get them wrong:

- **Never rewrite the file from scratch, and never renumber or re-key an existing item.**
  Progress in `artifacts/sprakstugan/progress.json` is keyed on `w:<sv>` for words and on
  the literal `id` for particles and structures. A changed key silently throws away that
  item's entire strength history.
- **No duplicates.** A word whose `sv` already exists collides on the same progress key and
  re-teaches something they know. Diff against the existing arrays before appending.
- `id` must be unique and prefixed `p:` / `s:`. `gender` is `"en"` / `"ett"` / `null`
  (null for verbs, adjectives, phrases). Every word needs a natural `ex` sentence — that is
  what the 🔊 button speaks.
- `diff` is one of `easy` / `medium` / `hard` / `expert` / `master`.

**Batch size: ~60–80 words, ~12 particles, ~10 structures.** That is a few weeks of drip
without a wall of generation. Bias `cat` toward `weakest_categories` from the payload and
toward what they actually need Swedish for, per the profile.

## Finishing

- Write the file, then **notify** with what landed: how many of each, which categories you
  leaned into, and any level change you made. This trigger runs unattended — the
  notification is the only thing the learner sees. Deep-link it to the app
  (`app_id = "sprakstugan"`).
- The app clears its banner on its own once the bank grows; there is nothing to reset.
- If the profile artifact is missing, do **not** invent a level. Notify that setup was never
  finished and what to ask for.
