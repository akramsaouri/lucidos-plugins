---
name: Språkstugan Learner Profile
description: The learner's Swedish level on two separate axes (written vocabulary vs spoken conversation) and how to pitch generated content to it — load when generating words/particles/structures for Språkstugan, preparing a spoken scenario, recommending a difficulty, or when the learner says content is too easy or too hard. Keywords: Språkstugan, Swedish, svenska, difficulty, Lätt, Medel, Svår, level, calibration, too easy, too hard, B1, B2, C1.
---

## What this file is

The single calibration source for everything this plugin generates. Both the app's
vocabulary bank and the spoken-practice scenarios read their difficulty from here.

**It ships with placeholder values. Setup fills them in, and you keep them current.**
A learner who never ran setup gets the conservative defaults below — usable, but not
their level.

## The two axes are independent — this is the point

Reading and recognising written vocabulary is a different skill from producing speech
in real time under social pressure. Most learners are **well ahead in written** and
behind in spoken, and the gap is often two CEFR bands. Calibrating both from one number
is the mistake this file exists to prevent: pitch the app at their spoken level and the
vocabulary is trivial; pitch the scenarios at their written level and they freeze.

| Axis | Level | Set on |
|---|---|---|
| **Written** (app: words, particles, structures) | `B2` *(placeholder — setup replaces)* | — |
| **Spoken** (roleplay conversation) | `B1` *(placeholder — setup replaces)* | — |

## Written axis — generating the vocabulary bank

The app has five difficulty tiers: `easy` (Lätt), `medium` (Medel), `hard` (Svår),
`expert` (Expert), `master` (Mästare). Map the written level onto them, and make the
learner's own level the **centre of gravity**, not the ceiling:

| Written level | Bank should centre on | Include some |
|---|---|---|
| A2 | `easy` | `medium` |
| B1 | `easy` / `medium` | `hard` |
| B2 | `medium` / `hard` | `expert` |
| C1 | `hard` / `expert` | `master` |
| C2 | `expert` / `master` | — |

Always include a thin tail one tier **above** — a bank with no reach in it stops
teaching within a week. Never include a tier more than one step below centre: reviewing
words they got right eight times running is what makes an app feel pointless.

## Spoken axis — pitching a roleplay

- **A2–B1**: everyday vocabulary, normal sentence length, common connectors
  (`men`, `så`, `eftersom`, `fast`, `ändå`). Gloss any less-common word in
  (English) the first time. No rare idioms, no stacked subordinate clauses.
- **B2**: idioms allowed, longer turns, your character can be indirect or evasive
  and make the learner dig for the answer.
- **C1+**: register shifts, bureaucratic and legal phrasing, a counterpart who
  argues back with jargon.

Nudge difficulty up *gradually*, within a session and across days. Never jump two bands.

## Keeping it current — REQUIRED

This file is only useful if it tracks reality. Update it when you observe:

- The learner says content is **too easy** or **too hard** → move that axis one band and
  write the new value into the table above.
- Repeated failures in one grammatical area (particle verbs, en/ett, word order in
  subordinate clauses) → note it under "Known weak spots" below and weight generated
  content toward it.
- A tier they consistently ace → stop generating it.

Edit the table; don't leave the correction only in a chat message. This is the file the
next session reads.

## Known weak spots

*(Empty at install. Add observed patterns here as they emerge — one line each, e.g.
"particle verbs with `upp`/`av` — confuses the two", "drops `att` in infinitive clauses".)*
