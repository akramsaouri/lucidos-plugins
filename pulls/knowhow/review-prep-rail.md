---
name: Review Prep Rail (PRs I'm asked to review → findings waiting)
description: "How Pulls turns PRs you're asked to review into findings waiting in the Pulls app (review-cockpit/findings/v2): the detector and request gate, the per-fire checklist, the lanes-driven pr-* pass (also run on your own PRs), the review-prep workflow harness and the sweeps. Load when ReviewPrepRequested or OwnPrPrepRequested fires, writing findings, or a prep produced nothing."
---

# Review Prep Rail

Turns "PRs I'm on the hook for" into **findings already waiting** by the time I open
them, in the [Pulls](app:review-cockpit) app. Read-only: it never comments, never pushes,
never edits the reviewed code.

Which repos, which logins and which registered repositories are involved all come from
`artifacts/review-cockpit/config.json` — see `pulls-config`. Nothing on this page names a
repo; the config does.

## The pieces

| Piece | What it is | Runs on |
|---|---|---|
| `triggers/review-prep-work-prs/scripts/detect.py` | Finds PRs I'm asked to review and emits `ReviewPrepRequested` per head | the PR-watch cron setup creates |
| **Review prep - PRs** (intent) | The deep, read-only multi-agent review of one PR at one head | `ReviewPrepRequested` |
| `triggers/review-prep-work-prs/scripts/queue.py` | Writes `review-queue.json`: the PRs on me to review right now | the queue-sweep cron, and Refresh |
| `triggers/review-prep-work-prs/scripts/mine.py` | Writes `my-prs.json` (my open PRs and what blocks each) and `shipped.json` | the status-sweep cron, and Refresh |
| `.../scripts/own_prep.py` | Called by `mine.py`: emits `OwnPrPrepRequested` per new head of my own PRs | after each status sweep |
| **Own PR prep** (intent) | The lanes-driven pr-* pass on my own PR, no review | `OwnPrPrepRequested` |
| `.../scripts/auto_conflicts.py` | Called by `mine.py`: asks the conflict resolver to start on my conflicted PRs, only for repos with `auto_resolve_conflicts` | after each status sweep |
| **Prep a PR for review on demand** (script) | The Prep / Re-prep button: validates and emits the real `ReviewPrepRequested` | `ReviewPrepManualRequested` |
| **Refresh PR status on demand** (script) | Runs `mine.py` and `queue.py` now | `PrStatusRefreshRequested` |

Every Pulls file lands under `data/artifacts/review-cockpit/`.

**Both prep rails are silent.** The Pulls app is the delivery surface. A finished prep sends
no notification; the only exception is a finding that needs acting on right away (a
build-breaker, or something that would embarrass the team in production).

## The detector and its gate

`detect.py` builds one rail per config group (`pulls_config.rails()`), each pinned to the
group's login. Discovery is `search` (`review-requested:@me` / `mentions:@me`, scoped to
the group's repos, or the whole owner for `any_repo`) or `list` (each repo's open PRs:
authoritative, no search-index lag). **Discovery only finds candidates; the gate decides.**

`requested_by_me()` counts four signals:

| Signal | Source | Why it counts |
|---|---|---|
| reviewer | `.requested_reviewers` names me | the direct case |
| mention | `@<me>` in the body, an issue comment or a review comment | "can you look at this?" is a request |
| history | I already reviewed an earlier head | GitHub drops me from `requested_reviewers` the moment I submit, so without this the PR stops being mine exactly when the author answers me |
| team | the request names a team in `team.teams_that_ask_me` | opt-in only |

**A team request is not an ask by default.** CODEOWNERS catch-alls put a team on every PR,
so a team-only PR is the unassigned *pool*: `queue.py` shows it as such, the rail never
preps it. **A failed lookup is never "nobody asked"**: it returns `unreachable`, distinct
from a genuine no, so a VPN blip can't silently drop a real request.

Then, in order: skip my own PRs (any login in `me`; they go to Own PR prep), skip drafts,
skip a head that already has findings, skip a head I already reviewed or commented on
(see `detect.my_say()`), debounce a head younger than 10 minutes (a push sequence becomes
one review), skip a request younger than 3 hours (in flight), otherwise emit. A request
older than 3 hours with no findings is a dead run and is re-emitted.

Dedup lives in the event log (`ReviewPrepRequested`, `ReviewFindingsProduced`), so the
detector is stateless. **It is SHA-keyed:** a new head must be re-reviewed, an unmoved one
must not.

The payload carries everything the reviewer needs: `rail`, `org`, `repo`, `folder` (the
registered repository), `repo_slug`, `gh_config_dir`, `login`, `pr`, `sha` (sha7),
`head_sha`, `base`, `title`, `author`, `url`, `files_changed`, `additions`, `deletions`,
`retry`, and `requested_via` (which signal matched). **The reviewer trusts the payload and
does not re-derive it.**

## Per-fire checklist for "Review prep - PRs"

1. **Read the payload.** The gate and dedup already ran. If `payload.author` is one of my
   logins, refuse: emit `ReviewPrepRefused` with `reason: "own_pr"` and stop.
2. **Step 0: the lanes-driven pr-* pass**, in its own coding-agent child (§ Step 0). It never
   blocks the review.
3. **Deep review, pinned to `head_sha`**: spawn a coding agent with
   `run_coding_agent(folder=<payload.folder>)`. In it, record the pre-reset SHA, reset the
   session's own branch to the head (§ Checkout), check the diff against
   `origin/<base>` (§ The base), run the harness (§ Invocation).
4. **Harvest everything, refuted included**, with evidence (§ Harvest). Copy each verifier
   row's `severity` onto its finding unchanged.
5. **Base-branch check** on any finding you'd hand to the author as theirs:
   `git show origin/<base>:<path>`, and set `pre_existing: true` when the defect is already
   there (§ `pre_existing`).
6. **Save and announce**: `lucidos data write` the findings artifact, then emit
   `ReviewFindingsProduced` (§ Output contract).
7. **Leave no change behind, last**: `git reset --hard <pre-reset SHA>` (§ Park the branch).
   Never before step 6. If the child died first, park it yourself. **Never `rm` anything
   outside the worktree** (`/tmp` included) during cleanup: an unattended session has no
   grant for it, the whole chained command is refused, and macOS purges `/tmp` itself.
8. **Read-only throughout** (§ Read-only invariants).
9. **Silent**: no notification unless step 4 found something to act on right away.

## Step 0: the lanes-driven pr-* pass

**pr-lanes decides what runs.** Run `/pr-lanes` first, then exactly the skills its
`lanes[].next` names, nothing more. The same pass serves both rails: before the deep review
on `ReviewPrepRequested`, and as the whole job on `OwnPrPrepRequested`.

The skills (pr-lanes, pr-summary, pr-intent, pr-story, pr-behaviour, pr-check, pr-recall) are Claude
Code skills from the pr-understanding set in the skillz marketplace; setup checks they are
installed. Each one's fenced JSON block is saved beside the findings:

| Skill | Runs when | Invocation | Schema | Artifact |
|---|---|---|---|---|
| pr-lanes | always, first | `/pr-lanes <owner>/<repo>#<n>` (includes pr-recall **match** hits in `recall[]`) | `pr-skills/lanes/v2` | `artifacts/review-cockpit/lanes/<slug>-<pr>-<sha7>.json` |
| pr-summary | a lane has `next: "pr-summary"` (pr-lanes emits a `summary` lane first on every PR, trust-only included) | `/pr-summary <owner>/<repo>#<n>` | `pr-skills/summary/v1` | `.../summary/<slug>-<pr>-<sha7>.json` |
| pr-intent | a lane has `next: "pr-intent"` | `/pr-intent <owner>/<repo>#<n>` | `pr-skills/intent/v1` | `.../intent/<slug>-<pr>-<sha7>.json` |
| pr-story | a lane has `next: "pr-story"` | `/pr-story <owner>/<repo>#<n>` | `pr-skills/story/v3` (v2 still read) | `.../story/<slug>-<pr>-<sha7>.json` |
| pr-behaviour | a lane has `next: "pr-behaviour"` | `/pr-behaviour <owner>/<repo>#<n>` | `pr-skills/behaviour/v1` | `.../behaviour/<slug>-<pr>-<sha7>.json` |
| pr-check | a lane has `next: "pr-check"` | `/pr-check <owner>/<repo>#<n> --depth quiz` | `pr-skills/check/v1` (`mode: "quiz"`) | `.../check/<slug>-<pr>-<sha7>.json` |

- **Never run from lanes:** `next: "pr-recall"` (its match hits are already in the lanes
  file; `/pr-recall create` belongs to the merge rail, see `pr-recall-rail`) and
  `next: null` (the `trust` lane). A lanes file with no lanes ends the pass.
- **pr-intent on my own PR** takes the PR body as the stated why. An empty body returns
  `status: "needs_why"`: save it as is, the app shows it. Never invent a why.
- **pr-behaviour** gets no screenshots on an unattended run; never launch a simulator from
  this rail.
- **Lanes gates the pass, not the review.** A `trust`-only PR still gets the full review.
- **The quiz has no answer key on disk**, deliberately. Grading re-reads the code at the
  quiz's `head_sha` (see `pr-check-rails`).

`<slug>-<pr>-<sha7>` is exactly the findings key (`payload.repo_slug`, `payload.pr`,
`payload.sha`), so the app joins every file by name. `<owner>/<repo>` for the skills comes
from the payload `url`.

**Use one separate coding-agent child for the whole pass**, spawned before the reviewer
with `run_coding_agent(folder=<payload.folder>)`. The reviewing session already runs close
to its context limit, and the pass costs minutes against the review's 40. Its prompt
carries:

- the pinned identity, **with no `$(...)`**: tell it to prefix every `gh` call with
  `GH_CONFIG_DIR=<payload.gh_config_dir as an absolute path>` (an `export` may not persist
  between its shell calls), and to run `GH_CONFIG_DIR=<dir> gh api user --jq .login` first.
  If that doesn't print `payload.login`, stop and report "identity unpinned". **Never**
  `gh auth switch`. An unattended, trigger-rooted session has every command containing a
  command substitution refused, and every `gh` call needs the trigger's **Use cloud CLIs**
  side-effect grant;
- expand `~` from `echo $HOME` before writing any literal path into the prompt;
- the head, `payload.head_sha`. Each skill resolves the head itself: if it differs, the PR
  moved, so **still save**, under the SHA the skill pinned (its `pr.head_sha`), and say so;
- read-only and no checkout: read with `git show <sha>:<path>` after
  `git fetch origin refs/pull/<n>/head`; no redirects to `/tmp`, pipe instead;
- never `Skill("code-review…")`;
- return every JSON block verbatim, lanes first, then one per skill in lane order.

The trigger thread (not the child) writes each block with
`lucidos data write artifacts/review-cockpit/<lanes|summary|intent|story|behaviour|check>/<slug>-<pr>-<sha7>.json --from <tmp>`
after checking `schema` and `pr.head_sha[:7] == sha7`, then emits one event:

```bash
lucidos events emit PrPrepSkillsProduced --summary "pr-* pass on storefront#812: lanes → intent, story" \
  --payload '{"repo":"storefront","repo_slug":"store","pr":812,"sha":"3f9c2ab","head_sha":"<40>",
              "own_pr":false,"asked":["pr-intent","pr-story"],
              "paths":{"lanes":"artifacts/review-cockpit/lanes/store-812-3f9c2ab.json",
                       "intent":"artifacts/review-cockpit/intent/store-812-3f9c2ab.json",
                       "story":"artifacts/review-cockpit/story/store-812-3f9c2ab.json"},
              "missing":[]}'
```

`asked` lists the skills lanes named (minus pr-recall and null); `missing` lists any that
produced no valid block. A partial pass still saves what it has.

## Own PRs: the pass without a review

`own_prep.py` runs at the end of `mine.py`. For each of my non-draft PRs in a listed repo
whose head is at least 10 minutes old, it emits one `OwnPrPrepRequested` per head unless a
lanes file for that key exists or a request is younger than 3 hours. The payload matches
`ReviewPrepRequested` plus `own_pr: true` and `login`; `head_sha` is null (my-prs.json
carries sha7 only), so the save check is `pr.head_sha[:7] == payload.sha`.

**Own PR prep** runs Step 0 exactly as above, writes the files, emits
`PrPrepSkillsProduced` with `own_pr: true`, and never notifies. No review, no findings, no
comments, no pushes.

## Checkout: reset the session's own branch, never `EnterWorktree`

`EnterWorktree` cannot work unattended: it needs a consent disclosure the permission tool
can't display. **`git checkout --detach` doesn't hold either**: the Lucidos worktree
watchdog checks the session branch back out mid-run, and from then on the agents read the
base branch while nothing fails loudly. Point the session's own branch at the head
instead, which the watchdog has no reason to undo:

```bash
git rev-parse HEAD              # record: the pre-reset SHA, needed to park
git fetch origin refs/pull/<n>/head
git reset --hard <head_sha>     # on the session's own branch
git rev-parse HEAD              # confirm
```

A mid-run detached HEAD is usually the review agents' own `git checkout`s, not the
watchdog. The test is **which commit**, not attached vs detached:
`git reflog | awk '{print $1}' | sort -u` should list only the pre-reset SHA and the head.
If HEAD ever moved to another commit, re-verify the findings from agents that read the
working tree after it moved.

Paths: the Scope agent absolutises `scope.files`; strip the worktree prefix on the way out
so every `file` in the artifact is repo-relative.

### Park the branch, or the thread asks for review

After the reset the session branch carries the PR's commits, so the thread shows a Diff
and waits for someone to acknowledge a change the rail never made. **Last command of every
prep run, after the write and the emit:**

```bash
git reset --hard <pre-reset SHA>
```

Not `main`: the clone's local `main` can have drifted, and parking on it would import its
commits. Park on what the rail found. The PR's commits survive under `origin/<branch>`, the
worktree ends empty, and the worktree reaper removes it. A clean prep thread still stays
in the thread list until archived by hand; there is no engine path that archives it.

## The base: always `origin/<base>`

The payload's `base` names a branch on GitHub. A session worktree's local branch of that
name is whatever the clone last pulled, and against a drifted local `main` a 7-file PR
scoped ~300 files. **Use `origin/<base>...<head_sha>`**, and check the resulting file
count and +/- against the payload's `files_changed` / `additions` / `deletions` before
invoking the harness: those come from GitHub and are the only independent check. A merge
commit at the head is normal; the three-dot form against `origin/<base>` still gives the
author's own changes.

## Invocation: the `review-prep` workflow, by name

The harness ships as `scripts/pulls/harness/review-prep.js`; setup installs it at
`~/.claude/workflows/review-prep.js`. Invoke it **by name**, with compact args:

```js
Workflow({ name: "review-prep", args: {
  pr: { org, repo, number, title, author, head_sha, base_ref, files_changed, additions, deletions },
  spec: "origin/<base>...<head_sha>",
  toolchain: "which checks can run here, and which can't",
  notes: "repo conventions and traps worth every agent knowing",
  finders: [ { key, prompt }, … ],   // per-PR correctness angles + one cleanup angle
  sweeps:  [ { key, prompt }, … ],   // CI toolchain / completeness passes
  verify_cap: 88
} })
```

Phases: Scope → Find (parallel finders) → Verify (one adversarial verifier per distinct
`(file,line)`) → Sweep (run the repo's CI toolchain, then criticise the review) → Verify2 →
Synthesize. The orchestration stays on disk and only the per-PR angles go in `args`:
a 30 KB script passed inline killed a session on prompt length.

- **`Workflow` must be allowed** (in `.lucidos/cc-allowed-tools` and the spawn's
  `allowed_tools`). Without it the call waits on a prompt that never renders, times out,
  and falls through to a degraded single-context review with no verdicts.
- **Never `Skill("code-review")` or `Skill("code-review:code-review")`.** A marketplace
  plugin collides on that name and ends in `gh pr comment` on the live PR. Never pass
  `--fix` or `--comment`. Never run `/simplify`.
- Keep each finder prompt short; split a finder with more than ~4 questions into two
  rather than letting it die on prompt length.
- Budget: a ~40-file PR is ~40-60 agents, ~4M subagent tokens, ~40 minutes. Finder count is
  fixed; verifier count scales with how much is wrong, not how big the PR is.

### The session can die after the workflow succeeds

A reviewing session ending on `Prompt is too long` is not a lost run. The full structured
return is written to
`/private/tmp/claude-<uid>/<worktree-slug>/<cc-session-id>/tasks/<task-id>.output`
(`{summary, agentCount, logs, result, workflowProgress, totalTokens, totalToolCalls}`,
`result` = `{pr, spec, scope, counts, findings, refuted, synthesis}`), and the trigger
thread can build the artifact from it. Check for it before re-running 40 minutes.

`logs` is the only place a dead sub-agent is named (`[find:<key>] failed: Prompt is too
long`). **A dead agent is a coverage gap and must reach `observations`**, or "unreviewed"
reads as "clean".

## Harvest: keep the full verified set

The harness returns every kept finding (`synthesis.reported` is only the display slice, so
`run.counts.reported` stays meaningful). Harvest all of them, not the slice. Refutations
must carry their quoted counter-evidence: if the return lacks it, take it from the verifier
agents' `StructuredOutput` in the transcript directory (`journal.jsonl` has a
started/result pair per agent; each `agent-<id>.jsonl` holds the prompt at line 0 as a
string or a content array, and `agent-<id>.meta.json` names its `agentType`). Record
`run.claude_code_version` (`claude --version`): those transcripts are Claude Code internals
and a silent layout change is diagnosable only by version.

## Output contract — schema `review-cockpit/findings/v2`

One artifact per PR head, at `artifacts/review-cockpit/findings/<repo_slug>-<pr>-<sha7>.json`:

```json
{
  "schema": "review-cockpit/findings/v2",
  "pr":  { "repo","repo_slug","number","title","url","author",
           "head_sha","sha7","base_ref","files_changed","additions","deletions",
           "requested_via" },
  "run": { "generator","source","generated_at","claude_code_version",
           "elapsed_min","agents","subagent_tokens","tool_calls",
           "transcript_path","cap_bound",
           "counts": { "total","reported","confirmed","plausible","refuted","on_test_files" } },
  "findings": [ { "id","file","line","verdict","severity","category","summary",
                  "failure_scenario","evidence","verifier_agent",
                  "reported","is_test","pre_existing" } ],
  "refuted":  [ "same shape, verdict REFUTED, evidence REQUIRED" ],
  "observations": [ "things you'd have asked about" ]
}
```

- **`verdict`**: `CONFIRMED`, `PLAUSIBLE` or `REFUTED`.
- **`severity`**: `blocking` (breaks the build, data or customer-visible behaviour,
  introduced by the PR), `should-fix` (a real correctness or behaviour risk worth raising)
  or `nit` (convention, wording, style, cleanup). Independent of the verdict: a true
  wording issue is CONFIRMED + nit. The app counts `blocking` + `should-fix` as issues, and
  for artifacts without the field falls back to the category (`correctness`, `security`,
  `performance` are issues). Never drop it.
- **`pre_existing`**: `true` when you checked `origin/<base>` and the defect is already
  there. It does **not** mean drop the finding — "this PR makes an existing problem
  reachable" is often the most useful line in a review. It means don't hand it to the
  author as something they did. **Absent means not checked, never "new"**: only set it
  after looking.
- **`file`** is repo-relative; **`is_test`** is computed from the path (the app sorts source
  before test within each verdict band).
- **`reported: true`** marks the harness's display slice. Provenance only: the app shows
  every finding.
- Strip `[same root cause also at: <the same file:line>]` self-references from summaries.
- **`requested_via`** is copied verbatim from the payload.
- **`refuted[]`** entries must carry `evidence`.

```bash
lucidos data write artifacts/review-cockpit/findings/store-812-<sha7>.json --from <tmp>
lucidos events emit ReviewFindingsProduced \
  --summary "review-prep on storefront#812 (N files): V verified, R reported, X refuted" \
  --payload '{"repo":"storefront","pr":812,"sha":"<sha7>","base":"<base>","source":"workflow-review-prep","verified":V,"reported":R,"refuted":X,"confirmed":C,"plausible":P,"files_changed":F,"elapsed_min":M,"cap_bound":false,"url":"<pr url>"}'
```

The app re-reads the findings directory on every `ReviewFindingsProduced`.

### How the app reads it

- **Restatements fold at render, never in the artifact.** One verifier per location writes
  one row per candidate, so a line several finders noticed comes back several times. The
  app folds rows at the same location whose backticked symbols overlap (median pairwise
  overlap ≥ 0.20 folds the whole location; ≥ 0.45 joins a sub-group), most severe row
  first. Counts always read the unfolded array, and select-all picks primaries only.
- **Picks key on the finding `id`, carrying `"<file>:<line>"` as `loc`.** Prose changes every
  run, so a content hash never matches across runs; location does. A pick from an older
  head at the same location is surfaced ("you picked this spot at A — same issue, or
  new?"), never silently re-applied. The ledger is `artifacts/review-cockpit/triage.json`.
- **The review is composed in the app and posted by hand.** Picking N findings makes one
  numbered review with `blob/<head_sha>/<path>#L<line>` permalinks. It targets a
  **submitted review** (`pulls/N/reviews`, `event=COMMENT`), never a Conversation comment
  and never APPROVE / REQUEST_CHANGES: a plain comment leaves me in `requested_reviewers`
  and the PR still reads "review required". Two exits, both keeping a human in between:
  copy and open the Files tab, or a prefilled (never auto-sent) thread.

## The Prep button

`not prepped yet` on a review card is a schedule fact (poll, debounce, 40-minute review).
The Prep button emits `ReviewPrepManualRequested`; `prep-a-pr-for-review-on-demand` re-reads
the live head, skips the debounce and the request gate (a click is the most direct request
there is), and emits the real `ReviewPrepRequested` with `manual: true`. It refuses an
unlisted repo or a group with `prep: false`, a head that already has findings (unless
Re-prep asked to replace them), and a head with a review **genuinely running**: it checks
the thread list for a live "Review prep - PRs" thread, because a request event proves an
intention, never a state. **Every refusal emits `ReviewPrepRefused`** (`reason`, `detail`,
same key), and the app drops its optimistic lock and shows the reason.

## The sweeps: `mine.py` and `queue.py`

Both overwrite one snapshot and emit one event per sweep (`MyPrStatusSnapshotted`,
`ReviewQueueSnapshotted`), which the app listens for. A failed identity or rail is recorded
(`identities_failed`, `rails_failed`), never written as an empty result, so the app can say
"unreachable" instead of showing a confident empty lane. With no usable config they write
nothing and exit non-zero.

- **`mine.py`** reads my open PRs per identity, scoped to the owners that identity watches,
  in one GraphQL call each, and derives a state per PR: `conflict`, `comments`, `rerequest`,
  `changes`, `ci`, `mergeable`, `approved`, `waiting`, `draft`. It reads all three comment
  surfaces (inline threads, Conversation comments, review bodies), clears an ask by its own
  author's later approval, flags reviewers whose last review sits on an old head (GitHub
  doesn't re-request on push), and fills in `reviewDecision` when a repo without required
  reviews leaves it null. For groups with `shipped_lane` it also writes `shipped.json`, my
  merges of the last 7 days. It caches reviewers' avatars under `avatars/`.
- **`queue.py`** is the review lane as a live reading, joined to findings: it reuses
  `detect.requested_by_me()` and `detect.my_say()` (one gate, two callers), so the lane and
  the rail never disagree. A PR I've had my say on drops to "Answered, waiting on them" and
  comes back when the author pushes. It prunes findings and skill files for PRs that
  merged or closed.

`mergeable` is computed lazily by GitHub, so two back-to-back sweeps can legitimately
disagree (`UNKNOWN` then `MERGEABLE`).

## Read-only invariants

These bind the review rails (detector, sweeps, review prep, own PR prep). The conflict
resolver is the one shipped rail that writes, and it is scoped separately (see
`pr-button-rails`).

- No commits, no pushes, no PR comments, no reviews, no labels. Never `--fix` / `--comment`.
- No writes to tracked files in the reviewed repo; scratch goes to `/tmp`.
- Never touch `.claude/worktrees/*` or any other checkout: those are live human sessions.
- Leave the session worktree parked and clean.
- Unattended: **no questions**. Record what you'd ask as an `observations` entry.

## Side-effect grants (Command Safety)

When Settings → Permissions → Command safety is on, the review rails need **Use cloud CLIs**
(`cloud_cli`) for their `gh` calls; the shipped trigger.toml files declare it, and setup asks
the user to grant it. Reads, `git fetch`, the worktree reset and `lucidos data write` are
otherwise everything they do. A run that fails naming any other grant has drifted into
mutation: treat it as a bug, not a reason to widen the grant.

## Gotchas

- **`spawn-thread --to` takes the workspace PATH, never its name.** A name resolves against
  `$LUCIDOS_WORKSPACES_ROOT` and can land on a stale dev checkout advertising a dead port.
  The scripts pass `$LUCIDOS_WORKSPACE` and refresh the port from the engine's env.
- **A 404 from GitHub on a private repo can mean the wrong identity.** GitHub hides what a
  token can't see. Check `pulls_config.py` (it prints each identity's token state) before
  concluding a repo is gone.
- **An org with an IP allow list answers search with 422 and REST with 403** off its
  network. The sweeps report it as unreachable, never as zero PRs.
- **A script gets `CRED_GITHUB` only because its file declares it** (`# lucidos-credentials:`
  header). A credential under any other name never reaches the scripts; they fall back to
  `gh`.
