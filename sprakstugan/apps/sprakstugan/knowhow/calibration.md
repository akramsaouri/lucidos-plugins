---
name: Språkstugan Calibration
description: How to pitch Språkstugan content to the learner — the two independent axes (written vocabulary vs spoken conversation), the tier mapping for the vocabulary bank, and how to grow the bank when it runs low. The learner's OWN levels live in artifacts/sprakstugan/learner-profile.md, not here. Load when generating words/particles/structures, topping up the bank, preparing a spoken scenario, recommending a difficulty, or when the learner says content is too easy or too hard. Keywords: Språkstugan, Swedish, svenska, difficulty, Lätt, Medel, Svår, level, calibration, too easy, too hard, bank running low, B1, B2, C1.
---

## Two files, and only one of them is yours to edit

| File | What it holds | Who writes it |
|---|---|---|
| **this file** (`apps/sprakstugan/knowhow/calibration.md`) | the *method* — axes, tier mapping, bank-growth rules | the plugin, on update. **Never edit it.** |
| `artifacts/sprakstugan/learner-profile.md` | the *learner* — their two levels, weak spots, what they need Swedish for | you, whenever you learn something new |

This split is load-bearing. Everything under `apps/sprakstugan/` belongs to the plugin, so
an edit there marks the plugin **Modified** in the Plugins panel and gets overwritten by the
next update. The learner profile is an artifact precisely so it survives updates and never
makes the install look tampered with. If the profile artifact does not exist yet, setup was
never run: say so rather than guessing a level.

## The two axes are independent — this is the point

Reading and recognising written vocabulary is a different skill from producing speech in
real time under social pressure. Most learners are **well ahead in written** and behind in
spoken, often by two CEFR bands. Calibrating both from one number is the mistake this
split exists to prevent: pitch the app at their spoken level and the vocabulary is trivial;
pitch the scenarios at their written level and they freeze.

## Written axis — the vocabulary bank

The app has five tiers: `easy` (Lätt), `medium` (Medel), `hard` (Svår), `expert` (Expert),
`master` (Mästare). Make the learner's own level the **centre of gravity**, not the ceiling:

| Written level | Centre on | Include some |
|---|---|---|
| A2 | `easy` | `medium` |
| B1 | `easy` / `medium` | `hard` |
| B2 | `medium` / `hard` | `expert` |
| C1 | `hard` / `expert` | `master` |
| C2 | `expert` / `master` | — |

Always include a thin tail one tier **above** — a bank with no reach in it stops teaching
within a week. Never include a tier more than one step below centre: reviewing words they
got right eight times running is what makes an app feel pointless.

## Spoken axis — pitching a roleplay

- **A2–B1**: everyday vocabulary, normal sentence length, common connectors (`men`, `så`,
  `eftersom`, `fast`, `ändå`). Gloss any less-common word in (English) the first time.
  No rare idioms, no stacked subordinate clauses.
- **B2**: idioms allowed, longer turns, your character can be indirect or evasive and make
  the learner dig for the answer.
- **C1+**: register shifts, bureaucratic and legal phrasing, a counterpart who argues back
  with jargon.

Nudge difficulty up *gradually*, within a session and across days. Never jump two bands.

## The bank is a consumable, not a fixture

A fixed bank stops teaching well before it stops serving cards: once most items sit at full
strength the drip is pure review. The app watches for this itself and emits
**`SprakstuganBankRunningLow`** when either is true:

- **12 or fewer unseen items left**, or
- **75% of the bank at strength 5** (mastered).

The shipped `sprakstugan-bank-topup` trigger listens for that event and writes a new batch —
see its knowhow at `triggers/sprakstugan-bank-topup/knowhow/bank-topup.md` for the procedure.
The learner can also force it from the banner's **Fyll på nu** button. The app records the
request in `artifacts/sprakstugan/progress.json` under `topup` and will not re-ask for 72
hours or until the bank actually grows, so a batch in flight never triggers a second one.

**Growing the bank is the normal state of this plugin, not an exception.** Each top-up is
also the moment to re-read the learner profile: a bank written six weeks ago is calibrated
to who they were six weeks ago.

## Keeping the profile current — REQUIRED

Update `artifacts/sprakstugan/learner-profile.md` when you observe:

- They say content is **too easy** or **too hard** → move that axis one band and write the
  new value into the table there.
- Repeated failures in one area (particle verbs, en/ett, word order in subordinate clauses)
  → add it under "Known weak spots" and weight generated content toward it.
- A tier they consistently ace → stop generating it.

Edit the artifact; don't leave the correction only in a chat message. That file is what the
next session and the next top-up read.
