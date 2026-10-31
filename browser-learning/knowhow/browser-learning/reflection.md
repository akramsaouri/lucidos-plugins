---
name: Browser Learning — Reflection
description: How to run the periodic reflection pass over recent BrowserLearningObserved events and fold them into site knowhow. Loaded by the browser-knowhow-reflection trigger.
---

# Browser Learning — Reflection

You're running a periodic reflection pass over recent `BrowserLearningObserved` events. Your job is to fold them into `knowhow/sites/<domain>/` files — deduplicating, choosing the right shape per cluster, emitting `BrowserKnowhowUpdated` for each file you actually write, keeping `knowhow/sites/index.md` listing every site file, and closing the window with one `BrowserReflectionCompleted`.

## What you have

`BrowserLearningObserved` event payloads contain:
- `domain` — registrable domain (e.g. `linkedin.com`)
- `url` — full URL where the observation happened
- `kind` — `selector`, `flow`, or `gotcha`
- `observation` — what the prior agent saw
- `suggested_update` — optional concrete edit they proposed
- `thread_id` — the originating thread, for context if you need it

## The pass

### 0. Keep the index whole

Per-site files sit one level below the depth the knowhow catalogue lists, so
`knowhow/sites/index.md` (id `sites/index`) is the only way an agent finds them. Before
anything else, every pass:

- **No index yet** → create `knowhow/sites/index.md` with the frontmatter and table shown
  under "The index" below, one row per domain directory already under `knowhow/sites/`.
- **Index exists** → list the directories under `knowhow/sites/` and add a row for any
  domain, or any file, the table is missing. Never remove a row or rewrite one the user
  wrote; only add what is missing.

Writing the index counts as writing a file for the report, but not for
`BrowserKnowhowUpdated` (that event is per site file).

### 1. Pick the time window

The window is `[since, until)`. Fix both ends **before** you read any observation:

- `until` = the current time, in UTC ISO 8601. Observations recorded while you work fall
  after it and are the next pass's to read, so none slip between two passes.
- `since` = the `window_until` of the most recent `BrowserReflectionCompleted` event. If
  there is none (the first pass on this version), use the `created` time of the most
  recent `BrowserKnowhowUpdated` event. If there is none of those either (the first pass
  ever), leave `since` off and read every observation.

```bash
lucidos events query --type BrowserReflectionCompleted --limit 1
lucidos events query --type BrowserKnowhowUpdated --limit 1   # only if the first one is empty
lucidos events query --type BrowserLearningObserved --since <since> --until <until> --limit 1000
```

`query` returns newest first; process the observations oldest first. If there are none in
the window, skip to step 6 and record an idle pass.

### 2. Group

Group observations by `(domain, kind)`. Each group becomes at most one knowhow file edit.

Within a group, cluster further by what they're actually about — three reports that "the composer button moved to the kebab menu" are one cluster, even if the wording differs. Agents won't always write identical text; pattern-match on the substance, not the surface.

### 3. Per cluster, decide

Load the existing site file (`knowhow/sites/<domain>/<selectors|flows|gotchas>.md`) once per group. Then for each cluster:

- **Already covered, accurately** → no-op. Skip.
- **Already covered, but stale or wrong** → update the existing entry. Trailing one-line note on what changed is fine; don't sprawl.
- **Not covered** → add a new entry. If the file doesn't exist yet, create it with proper frontmatter (see below).
- **Suggestion is off-base** (observation is real but `suggested_update` would harm the file) → write what's actually right, ignore the suggestion.
- **Single low-confidence sighting** (one observation, no `suggested_update`, no clear action) → leave a `# unverified — saw once on YYYY-MM-DD` note in the relevant file rather than authoritatively rewriting. Let the next live thread confirm or contradict.
- **Site directory doesn't exist** → create `knowhow/sites/<domain>/` and start the relevant file with frontmatter.

**Whenever you create a site file the index doesn't list (a new domain, or a new file under a listed one), add it to `knowhow/sites/index.md` in the same run.** Those files sit one level below the depth the knowhow catalogue lists, so nothing announces that the id exists — the index is the only thing that makes them reachable. A site file you write and do not list is a file no future thread will ever load, and it will read as "no knowhow for this site" forever. Add the domain, the files it now has, and the full knowhow ids (`sites/<domain>/<file>`, no `.md`).

Three reports of the same thing > one report of the same thing. Weight clusters by sighting count when deciding how aggressively to rewrite.

### 4. Write

Keep it terse. Site knowhow is reference material:
- One bullet per selector
- A short numbered list per flow
- A one-paragraph note per gotcha

If you're writing more than a screen of text per cluster, you're paraphrasing — cut it down. Don't paraphrase the agent's prose into your own; their wording is closer to ground truth than yours.

### 5. Emit `BrowserKnowhowUpdated` — once per file you actually wrote

```bash
lucidos events emit BrowserKnowhowUpdated \
  --summary "Updated <domain> <kind>: <one-line>" \
  --payload '{
    "domain": "<domain>",
    "file": "knowhow/sites/<domain>/<file>.md",
    "kind": "<kind>",
    "observations_folded": <count>,
    "source_threads": ["<thread_id>", ...]
  }'
```

If a group ended in no-ops, don't emit anything for it.

### 6. Close the window: emit `BrowserReflectionCompleted` — every pass

Emit it once at the end of every pass that could read the window, idle ones included. It is
the next pass's lower bound, so a window of no-ops is not re-read every night.

```bash
lucidos events emit BrowserReflectionCompleted \
  --summary "Browser reflection: <n> observations reviewed, <m> files written" \
  --payload '{
    "window_since": "<since, or null on the first pass ever>",
    "window_until": "<until>",
    "observations_reviewed": <count>,
    "observations_folded": <count>,
    "files_written": <count>
  }'
```

**`window_until` claims every observation before it was reviewed.** If you stop early (see
"Don't fall behind silently"), set `window_until` to the `created` time of the oldest
observation you did *not* review, so the rest carries to the next pass. Never claim a
window you only half read. If you couldn't read the window at all, emit nothing here: the
next pass retries the same window.

### 7. Report & notification

**If this workspace has a `night-job-reports` knowhow, follow it** for the report shape,
the status word, the `NightJobReported` emit and the push threshold. Job slug
`browser-reflection`.

Status mapping:

- Ran fully, folded nothing worth reading → `OK`
- Wrote one or more site knowhow files → `REVIEW`
- Couldn't read the observation window → `BROKEN`
- No new `BrowserLearningObserved` events in the window → `IDLE`

`numbers` keys: `observations_reviewed`, `observations_folded`, `files_written`,
`sites_touched`.

Under that contract a productive pass is `REVIEW` and does **not** push — the files it
wrote are read in the morning, not in the night. The trigger stays invisible on quiet days,
but still leaves a `NightJobReported` row so a silent night is distinguishable from a dead
one.

**Without `night-job-reports`:** send a notification only if you wrote something material
(one or more site files) or couldn't read the window. Otherwise stay silent — this trigger
should be invisible on quiet days. `BrowserReflectionCompleted` already records that the
pass ran.

## The index

`knowhow/sites/index.md` belongs to the workspace, not the plugin: the plugin never ships
it, so installing, updating or uninstalling the plugin never touches it. You create it the
first time (step 0) and only ever add to it. Seed shape:

```markdown
---
name: Browser Site Knowhow — Index
description: The list of sites this workspace has recorded browser knowhow for, with the exact knowhow id of each file. Load this before driving the browser against any site, to find out whether a file already exists for the domain — the per-site files sit below listing depth and are not discoverable on their own.
---

# Browser Site Knowhow — Index

Per-site browser knowhow lives at `knowhow/sites/<domain>/<selectors|flows|gotchas>.md`,
one level below the depth the knowhow catalogue lists, so none of these files surface on
their own. Check the table, then load the id you need with `load_knowhow`. The
browser-learning reflection pass adds a row whenever it writes to a new domain.

## Sites

| Domain | Files | Knowhow ids |
|---|---|---|
| example.com | flows, gotchas | `sites/example.com/flows`, `sites/example.com/gotchas` |
```

Keep the table sorted by domain. Anything the user added below the table (grouping notes,
caveats) is theirs: leave it.

## File conventions

Each site knowhow file starts with frontmatter:

```yaml
---
name: <Domain> Selectors
description: Verified selectors for <domain>. Maintained by the browser-learning reflection pass.
---
```

Use sub-headings to group related entries (`## Login flow`, `## Settings`, `## Composer`). Each entry small and scannable — this gets read in 5 seconds by an agent in a hurry, not studied.

## What not to do

- **Don't open the browser.** This is a reflection pass, not a verification pass. If a selector needs verification, leave a `# unverified` note and let the next live thread confirm.
- **Don't archive scraped content here.** That belongs in artifacts.
- **Don't editorialize** ("the LinkedIn UI is a mess"). Just record the fact.
- **Don't add timestamps to every line** — git history covers that. Only add a date on `# unverified` notes so the next agent knows how stale the unverified claim is.
- **Don't fall behind silently.** If the observation backlog is huge (say, >50 events in one window), you can process the oldest 50 and let the rest carry to the next pass, with `window_until` set as step 6 says — but say so in the report when you do.
