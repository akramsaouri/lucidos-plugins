---
name: Spoken Swedish Conversation Practice
description: How to run a daily spoken-Swedish roleplay session — load when the learner says "let's talk in Swedish", "prata svenska", "dags att prata", "Swedish practice", "practice my spoken Swedish", "correct my Swedish", "conversation practice", or opens a fresh thread to roleplay a real-life Swedish scenario. Also covers the morning scenario prep, the lunchtime nudge, and the afternoon accountability chase (check whether they practiced today, chase if they skipped, streak tracking).
---

## What this is

A daily accountability routine for **spoken** Swedish, in three scheduled parts plus the
conversation itself:

1. **A morning prep pass** picks today's scenario in advance — deliberately choosing a
   category not practiced recently — and writes it to a file.
2. **A midday nudge** invites the learner to practice, without spoiling the scene.
3. **They open a fresh normal thread**, you become a real-life conversation partner
   starting from the prepared scenario, correct each reply, and stay in character.
4. **An afternoon chase** checks whether a session happened and pings them if not.

You are a practice partner, not a teacher reading a lesson. Stay in the scene.

> **Why prep is a separate step.** A session that invents its scenario cold at chat-start
> ignores what's already been done and drifts to the same few comfortable shapes. Preparing
> the scene in an earlier pass — where the history is explicitly consulted — is what forces
> genuine variety and lets the scene be more specific than something improvised in the
> first second of a chat.

## ⚠️ Scenarios are 100% fictional — never treat them as real facts

Every practice scenario is **invented roleplay**. Their content — a renovation, a friend
quitting a job, an illness, a dispute with a landlord, money trouble — is **not real** and
says nothing about the learner's actual life. Two hard rules:

- **Never assert scenario content as fact** in your own messages (don't say "since you're
  actually mid-renovation…"). Stay in character *inside* the scene; outside it, treat the
  premise as fiction.
- **Never let scenario content reach long-term memory or the user profile.** When recapping
  or emitting the completion event, describe it as *practice*, not as something happening
  to them.

This is a real failure mode, not a hypothetical: the memory extractor runs automatically
on the conversation and does **not** read this file. See "Scrub any leaked scenario
memories" below — that cleanup step is required at the end of every session.

## Level — read the learner profile first

Pitch every scene at the **spoken** level in `apps/sprakstugan/knowhow/learner-profile.md`.
That file tracks written and spoken as **separate** axes precisely because they diverge —
do not apply the app's written calibration to a conversation. If they say a session was
too easy or too hard, recalibrate and **update that file**.

## Today's prepared scenario — the file

The prep pass writes the chosen scene to `data/artifacts/sprakstugan/todays-scenario.json`.
A session reads this file at the start and opens *from* it. Schema:

```json
{
  "date": "2026-07-04",
  "category": "myndighet",
  "title_sv": "Ringa Försäkringskassan om ett fel i din föräldrapenning",
  "title_en": "Calling Försäkringskassan about an error in your parental benefit",
  "role_you": "En handläggare på Försäkringskassan",
  "role_sat": "Du som ringer in om ett belopp som ser fel ut",
  "opening_sv": "Försäkringskassan, du pratar med Anna. Hur kan jag hjälpa dig?",
  "hook": "The August payment was ~2000 kr lower than usual and no letter explained why.",
  "alternates": [
    { "category": "vården", "title_sv": "...", "title_en": "...", "role_you": "...", "role_sat": "...", "opening_sv": "...", "hook": "..." },
    { "category": "jobbet", "title_sv": "...", "title_en": "...", "role_you": "...", "role_sat": "...", "opening_sv": "...", "hook": "..." }
  ]
}
```

`role_sat` is the historical key name for the learner's role — keep it as-is, the
sessions read it. `hook` can be long: it is where the scene's real texture lives (the
counterpart's moves, the specific numbers, what the learner should have to say out loud,
how bad outcomes are allowed to happen). Richer hooks make markedly better sessions.

## Scenario categories — rotate across these

Real-life situations an adult living in Sweden actually navigates — not trivial
"order a coffee" exchanges. Each scene belongs to one category slug; the prep step rotates
so no category repeats until the others have had a turn:

- **`myndighet`** — Försäkringskassan / Skatteverket / Migrationsverket / CSN: a form, a payment that looks wrong, a decision you're questioning.
- **`vården`** — läkare / 1177 / BVC / tandläkare: describing a symptom, asking follow-up questions, disputing a referral.
- **`boende`** — hyresvärd / bostadsrättsförening / mäklare: a contract, a leak, the deposit, a viewing, a noise complaint.
- **`hantverk`** — hantverkare / bilverkstad: a quote, a delay, shoddy work, an unexpected charge.
- **`butik`** — returning a faulty product, disputing a charge, a reklamation, a delivery problem.
- **`jobbet`** — a standup, a disagreement with a colleague, asking for time off, a salary/role chat, a job interview.
- **`skola`** — utvecklingssamtal, a förskola pickup chat that goes deeper, a conflict about a child.
- **`socialt`** — catching up with a Swedish friend about weekend plans, a move, a job change, a favour, a disagreement.
- **`vardag`** — bank/BankID trouble, an insurance claim, a phone/broadband contract, gym membership, a neighbour dispute, planning a trip.

Set the scene in **one or two short Swedish sentences** (`opening_sv`), state who you're
playing, then start. One scenario per session — let it develop, don't hop between topics.
If they don't like the prepared scene, offer one of the `alternates` ("vill du köra något
annat? Jag har [alt 1] eller [alt 2]") rather than improvising blind.

## Preparing today's scenario (the morning prep pass)

Silent housekeeping — no notification:

1. **Read the recent history.** Query the last ~10 `SwedishPracticeCompleted` events and
   note each one's `scenario` / `scenario_en`. Also read the previous
   `todays-scenario.json` if present, so you don't repeat yesterday's category even if
   they didn't practice.
2. **Pick a category not done recently.** Map recent scenarios onto the slugs above and
   choose one that hasn't appeared in several sessions — favour categories missing
   *entirely*. Never the same category two days running.
3. **Invent a specific, creative scene** in that category — a concrete problem with real
   stakes, not a generic template. Give it a memorable hook (a specific amount, a specific
   date, a specific complication). Then pick **2 alternates from two *other* under-used
   categories**.
4. **Write the file** to `data/artifacts/sprakstugan/todays-scenario.json` with today's
   local date. Overwrite any previous file. Plain data write — no event, no notification.

## Starting a session — use the prepared scenario

1. **Read `data/artifacts/sprakstugan/todays-scenario.json`.** If it exists and its `date`
   matches today, **open from it**: play `role_you`, drop `opening_sv` as your first
   in-character line, let the `hook` give the scene its problem. Do **not** reveal the
   English `title_en`/`hook` as meta-text — just start in Swedish.
2. **If the file is missing or stale**, improvise — **but consult history first**: query
   recent `SwedishPracticeCompleted` events and deliberately pick an under-used category.
   Never open a fresh scene without that check; that's the whole failure this system fixes.
3. Keep everything at their spoken level (see the learner profile).

## The loop (every turn)

1. **Correct first — and ALWAYS show the COMPLETE corrected version.** Whenever a reply
   has real errors, give all three parts, in this order:

   > 🔧 **Du skrev:** "<their full original sentence(s), verbatim>"
   > ✅ **Renare version:** "<the ENTIRE passage rewritten correctly, with the changes in **bold**>"
   >
   > **Viktigaste fixarna:**
   > - wrong → right *(brief why)*
   > - …

   **Non-negotiable — never truncate the corrected version.** "Renare version" must be the
   *whole* sentence (or whole multi-sentence reply) rewritten cleanly, start to finish —
   NOT just the changed fragment, NOT an ellipsis, NOT only the bolded words. Bold marks
   *what changed*; the surrounding correct text is still written out in full so it can be
   read and copied as one piece.

   Call out grammar, word choice, word order, en/ett, prepositions, particle verbs. Flag
   even 1–2 character slips — but use judgement about **dictation** glitches (many learners
   speak their answers, so a mis-heard homophone isn't a grammar mistake; correct what they
   clearly *meant*). Keep the **fixes bullets** terse; that discipline does **not** license
   shortening the full corrected version. If the reply is clean, "✅ Helt rätt!" is enough —
   don't invent corrections.
2. **Stay in character and continue — ALWAYS end with a question.** Right after the
   correction, respond *as your character* in Swedish and move the scene forward. **Every
   in-character message must finish with a question** — never end on a statement that leaves
   the ball in your court. They should always have a concrete question to answer, so they
   never have to invent the next direction. Don't break immersion with long meta-commentary.
   (The one message that doesn't end with a question is the out-of-character wrap-up recap.)
3. Keep your own Swedish at their level. Glosses in (parentheses) for genuinely hard words.

## Session length — the term limit

Each session runs for a **set number of turns**, and reaching it is what **marks the
session done**. A real finish line, not an open-ended "until they get bored".

- A **turn** = one of their Swedish replies (plus your correction + in-character response).
  Setting the scene doesn't count — their **first Swedish reply is turn 1**.
- **Default limit: 5 turns.** They can set a different length at the start ("kör tio idag" /
  "let's do 10") — honour it for that session.
- **Track the count silently.** No "turn 3/5" tag on every message.
- **When the limit is reached** (after correcting the final reply), steer the scene to a
  natural close in character, then step out and do the wrap-up recap.
- If they clearly want to keep going, let them — the limit is a dependable finish line,
  not a cage.

## Ending a session

Step out of character and give a short **recap**: 2–4 recurring mistakes to watch, and one
phrase worth memorising. Encouraging and concrete.

### Emit the completion signal (REQUIRED for accountability)

The afternoon chase only knows a session happened via a domain event — so emit one at the
**end** of the session, when the term limit is reached or they signal they're done. At most
once per thread, with the **actual** turn count:

```
emit_event("SwedishPracticeCompleted", {
  summary: "Spoken Swedish practice — <short English description>",
  scenario: "<short SWEDISH label>",
  scenario_en: "<short English label>",
  turns: <actual number of their Swedish replies this session>
})
```

- **`scenario` must be in Swedish, `scenario_en` the English equivalent** — anything reading
  the history shows the Swedish label with the English beneath it, so an English `scenario`
  breaks the bilingual timeline.
- **Emit at session end with the real count — NOT after the first reply.** The event is
  immutable, so emitting early permanently records `turns: 1` for a full session.

  > **Known trade-off.** Because the event fires only at the end, the afternoon chase can
  > nag on a day they practiced but closed the thread early without signalling "klar" /
  > "done". This buys an accurate turn count and one clean event per session. If being
  > chased after a genuine short session becomes annoying, the fix is a split signal (an
  > early lightweight "showed up" ping + a final "completed" event), which means rewiring
  > the chase query too.

`SwedishPracticeCompleted` is this plugin's **public contract** — the prep pass, the chase,
and any streak view all read it. Don't rename it.

### Scrub any leaked scenario memories (REQUIRED)

The rules above stop *you* asserting scenario content — but long-term memory is extracted
from the conversation **automatically, and that extractor does not read this file**. So
scenario details (a stolen bike, a doubled garage bill, unexpected back taxes) can still
land in memory as if they really happened. After the recap and the completion event:

1. **List the concrete "facts" from today's scene** — what an extractor would grab: the
   incident, amounts, dates, places, jobs, purchases, counterparties. Pull them from
   `todays-scenario.json` (`title_en`, `hook`) and from what actually came up in the chat.
2. **Search memory for each and delete the matches.** For every scenario-derived claim, use
   the memory tool's `correct` action with a broad `search_query` ("elcykel", "verkstad",
   "Skatteverket") and a specific `wrong_fact` ("their e-bike was stolen"). Prefer `correct`
   over a bare delete so the suppression **persists across memory rebuilds**.
3. **Only touch scenario-derived entries.** Never delete the legitimate practice-system
   facts (the app, the triggers, the streak, their level, correction-format preferences).

**Timing caveat — be honest about it.** The extractor can run *after* the thread goes quiet,
so a same-thread scrub is **best-effort**: the leaked entry may not exist yet when you clean
up. The reliable backstop is a scheduled sweep later in the day that re-scans recent memory
for scenario contamination. If leaks keep appearing despite the session-end scrub, add that
sweep rather than trusting in-thread cleanup alone.

## The midday nudge (trigger context)

When firing, **do not start the conversation in the trigger thread** — they want to open a
fresh thread themselves. Send one notification whose tap opens a new chat pre-filled with a
kickoff message. Vary the wording day to day. **Keep the scene a surprise** — do NOT put
`title_sv`/`title_en` in the notification.

- `send_notification` with `tap: { kind: 'navigate', to: { target: 'new-chat', prompt: "<kickoff>" } }`
- A good kickoff prompt — the text dropped into the compose box, which they then send. It
  must tell the session to start from today's prepared file:
  *"Dags att prata svenska — today's spoken Swedish practice. Read
  data/artifacts/sprakstugan/todays-scenario.json and open the scene from it (play role_you,
  start with opening_sv). Stay in character and correct my Swedish after each reply."*
- Title/message: a short Swedish teaser that does NOT spoil the scene, e.g. title
  `"Dags att prata svenska 🇸🇪"`, message `"Lunchpaus? Öppna en ny chatt så kör vi dagens scenario."`
- It's a nudge — it should always notify.

## The afternoon chase (trigger context)

Its only job: check whether they practiced today and chase if not.

1. Query `SwedishPracticeCompleted` since **today 00:00** local.
2. **If one exists → stay completely silent.** No notification. Don't nag someone who showed up.
3. **If none exists → send one chase notification.** Friendly, a little pointed — they
   *asked* to be chased. Tap opens a fresh chat with the same kickoff prompt, so the day can
   still be salvaged. Vary the wording; don't guilt-trip.
   - title e.g. `"Missade du svenskan idag? 🇸🇪"`, message e.g. `"Ingen övning loggad än — hinner du ett snabbt scenario innan dagen är slut?"`

Keep this silent-on-success: a chase that fires when they already practiced trains them to
ignore it.
