---
name: PR button rails — the prepare/spawn split
description: How the Pulls app (review-cockpit) buttons that start a coding agent (Resolve conflicts, Ask / Discuss about a PR) spawn one — run.py --prepare in an intent trigger, then run_coding_agent — and why they are intent triggers rather than script triggers; how the conflict resolver integrates (rebase vs merge per repo), dedups and checks for stranded worktrees; the Open PR, Refresh and Prep buttons; and in-app Merge, which calls GitHub through a proxy after a live pre-flight. Load when a Pulls button does nothing, when a rail reports "spawn failed ... no thread of its own", when editing resolve-pr-conflicts or ask-about-a-pr-on-demand scripts, when adding a button that starts an agent, or before turning on in_app_merge for a group.
---

# PR button rails — the prepare/spawn split

An iframe cannot run `git` or reach the OS, so every Pulls button that needs either emits
an event and a trigger does the work natively.

| Button | Event | Trigger | Does |
|---|---|---|---|
| Resolve conflicts | `PrConflictResolutionRequested` | Resolve PR conflicts on demand (intent) | `resolve-pr-conflicts/scripts/run.py --prepare`, then a coding agent |
| Ask / Discuss | `ReviewQuestionAsked` | Ask about a PR on demand (intent) | `ask-about-a-pr-on-demand/scripts/run.py --prepare`, then a coding agent |
| Prep / Re-prep | `ReviewPrepManualRequested` | Prep a PR for review on demand (script) | emits `ReviewPrepRequested` (see `review-prep-rail`) |
| Refresh | `PrStatusRefreshRequested` | Refresh PR status on demand (script) | runs `mine.py` and `queue.py` |
| Open PR (every GitHub link) | `PrOpenRequested` | Open PR in browser (script) | opens the URL natively, in the config's browser |
| Merge | — | none | calls GitHub through a proxy (last section) |

The app offers Prep and Resolve only on repos the Pulls config lists (and Prep only where
the group's `prep` is on), and hides a button when no unpaused trigger answers its event,
so it never offers what a rail will refuse or emits into nothing. An **Address comments**
button exists in the app for a comment-addressing rail that does **not** ship with Pulls:
it appears only if such a rail is installed and answers `PrCommentResolutionRequested`.

`triggers/resolve-pr-conflicts/` has no trigger.toml of its own and is still live: the
Resolve trigger runs its `run.py`, the stranded-worktree check runs its
`check_worktree.py`, and the Ask script imports `REPOS` and `engine_spawn_flags()` from its
`run.py` by path. Don't delete it as an orphan.

## Why these are intent triggers, not script triggers

A script trigger runs with no thread of its own, and a subprocess with no thread behind it
cannot create a top-level thread:

> HTTP 403: This request comes from a Lucidos subprocess with no thread of its own, so
> creating a top-thread has no subtree to stay inside.

So `lucidos spawn-thread --relation top` fails from a script trigger while the rest of the
script works perfectly, and the app's card sits on "starting" until its lock expires.
**Do not fix that by passing `--mode human`**: it would stamp an agent's spawn as the user
pressing the button, which makes the event log lie about who did what. A *thread* does the
spawning, with its own authorized tool.

## The split

Each script has two modes. **`--prepare`** does everything except spawn:

- validates the payload (refs, sha shape, url ownership, fork check);
- resolves the repo against `REPOS` in `resolve-pr-conflicts/scripts/run.py`, which reads
  the Pulls config: the registered repository, the login and gh config dir, the conflict
  style, the local path;
- re-reads live state and refuses on a moved head or an in-flight duplicate;
- builds the full coding-agent prompt;
- prints ONE JSON object and exits 0:

```json
{
  "action": "spawn",
  "repo": "storefront",
  "title": "Resolve conflicts: storefront#852",
  "prompt": "…the whole prompt…",
  "started_event": "PrConflictResolutionStarted",
  "started_payload": { "…minus thread_id…" }
}
```

`"action": "noop"` with a `reason` (nothing to do, or already running) and a non-zero exit
with the reason on stderr are both successful outcomes that spawn nothing.

**No flag** spawns through the CLI itself. That is for running a rail by hand from a chat
thread, which has a thread and passes the gate: the debugging path, not production.

## What the intent thread does

1. Run the script with `--prepare`, passing the event payload as `TRIGGER_EVENT_PAYLOAD`
   and the type as `TRIGGER_EVENT_TYPE`.
2. On `noop` or a non-zero exit: report and stop. No spawn, no Started event.
3. On `spawn`: `run_coding_agent` with `folder` = the JSON's `repo`, `prompt`, `title`, and
   `relation: "top"` (the trigger's job ends once the agent runs; it must not wait 40
   minutes).
4. Emit `started_event` with `started_payload` plus `thread_id`. **Not optional**: the app
   holds the button on the Started event and releases it on Finished. Skipping it leaves
   the button live while an agent works, which is how two agents end up on one branch.

Use `run_coding_agent`, not the unflagged script from `run_bash`: the gate's exact
condition is engine-internal and has changed without warning.

## Resolve conflicts

The resolver detaches at the PR head (it never checks the branch name out, since the branch
may be checked out in a live worktree), integrates the base, verifies, and pushes with
`HEAD:refs/heads/<branch>`. A fork head is refused: there are no push rights on someone
else's branch.

**`conflict_style` is per repo, in the config, and cannot be inferred:**

- `rebase` (default): `git rebase origin/<base>`, then
  `git push --force-with-lease=refs/heads/<branch>:<sha7>`. The lease pinned to the head the
  rail saw refuses the push if anyone pushed meanwhile; never retry with `--force`.
- `merge`: `git merge origin/<base>` and a plain fast-forward push. Use it on a repo whose
  tracked `.claude/settings.json` denies `Bash(git push --force*)`: that prefix also matches
  `--force-with-lease`, deny beats allow, and a rebased branch could never be published.

**The stop rule is the point.** The agent settles only what is mechanically unambiguous
(both sides moved, import lists diverged, a rename collided with an edit). A hunk that
encodes a product decision is reported, not guessed, and the run aborts the rebase or merge.

**Dedup:** one resolver per `(repo, pr, head sha)`, for 90 minutes. A second click is a
no-op with a reason; a new head is a new request. `auto_conflicts.py` emits the same request
after a status sweep for repos with `auto_resolve_conflicts`, at most 3 times a day per PR
and never twice for one head.

### A force-push strands every other checkout of the branch (rebase style)

After a rebase-style resolution, any other worktree of that branch points at commits that no
longer exist upstream, and `git status` there reads exactly like genuine unpushed work.
Committing and pushing from it would force the old history back over the agent's work.

On `PrConflictResolutionFinished`, **Check stranded worktree after rebase** runs
`check_worktree.py`: it finds worktrees holding the branch (`git worktree list --porcelain`,
so any tool's worktrees), fetches in the main clone only, and compares with
`git cherry` (patch id, so a rebased commit still matches). A `+` commit whose subject
exists upstream is the resolved copy; one with no namesake is real local work. It emits
`PrWorktreeStrandVerified` with a verdict the card shows: `gone` / `synced` (nothing),
`dirty` and `unique` (do not reset), `safe` (offers a reset command to **copy**; the app
never runs it).

## Ask / Discuss

The app composes the prompt (the anchor is the finding, map section or PR the user pointed
at, already loaded in the app) and sends it with `repo` (owner/name), `number`, `sha7`,
`anchor` and a `client_ref`. The script owns the two things the app can't know: which
registered repository the session runs in and which identity sees the owner, both from the
config, never from the payload. An unlisted repo falls back to the payload's `folder` only
if it names a registered repository. `ReviewQuestionThreadStarted` echoes `client_ref`, so
only the tab that asked opens the new thread.

The session reads at the head with `git show <sha>:<path>` and detaches only to run
something. It is read-only by instruction: never comment, review or push.

## Diagnosing "the button does nothing"

1. `lucidos events query --type <Requested event> --limit 1`. No row: the app never emitted
   (a UI bug, or the button was hidden because no trigger answers it).
2. `lucidos events query --type TriggerExecuted` for the same minute. `failed` within seconds
   is a crash at startup; `ok` with no agent thread means the script chose `noop`.
3. The script's stderr carries a full sentence for every refusal; read it in the trigger
   thread or the engine log (`grep`, never `cat`: it is large).
4. Run the script by hand with `--prepare` and the real payload. It is side-effect-free.

## Adding a button that starts an agent

Emit a Requested event from the app, write a script with a `--prepare` mode returning the
JSON above, and ship an **intent** trigger on that event. Resolve repos through
`pulls_config` (or the resolver's `REPOS`), never a second table.

## In-app Merge

Merge is the one write that isn't a rail: it needs no git and no worktree, just one HTTP
call whose answer is worth having under the finger that tapped. A group with
`in_app_merge: true` (and a `github.proxy` in the config) merges from the row through
`lucidos.proxy(<proxy>)`, so the token never enters the frame. Every other group links to
GitHub.

- **Flow:** tap → *Checking* → live pre-flight → `lucidos.ui.confirm` built from what the
  pre-flight read → *Merging* → `PUT /repos/<owner>/<repo>/pulls/<n>/merge` with
  `merge_method: squash`, `sha` pinned to the head the pre-flight checked, and
  `commit_title: "<PR title> (#n)"` → *Merged*, then `PrMergedFromPulls` (a record) and
  `PrStatusRefreshRequested`. Every refusal gives the button back. The confirm stays: a
  merge can't be undone, and a stray tap on a phone must not merge.
- **The pre-flight is the gate**, read live, never trusted from the sweep: the PR is open,
  not a draft, still at the row's head, mergeable and `clean` (`unstable` goes on to the
  check read so the refusal can name the check); every check run on the head completed as
  success, neutral or skipped (check runs, not the combined status, which can read
  "pending" forever with zero statuses; zero runs is refused); and GitHub's review rule:
  each reviewer's latest APPROVED / CHANGES_REQUESTED / DISMISSED review is their verdict,
  my own reviews don't count, and it needs an approval on this head and no changes
  requested.
- **Quirks:** every call sends a `User-Agent` (without one GitHub answers 403 "Request
  forbidden by administrative rules"); merging an already-merged PR answers 200, so the
  pre-flight stops on `merged: true` before any PUT; a lost PUT may still have merged, so the
  app re-reads the PR before saying anything.

**Before turning it on for a group**, check: can the proxy's account see the repo? Does the
repo allow squash merges (the PUT hard-codes squash)? Does it have branch protection? On a
private repo on GitHub's free plan there is none, so the pre-flight is the only gate: never
loosen it expecting GitHub to catch something.

**Testing it:** stub `lucidos.proxy` with scripted GitHub replies and assert on the request
log: no refusal or cancel may send a PUT, and the happy path sends exactly one. Never test
by merging a real PR.
