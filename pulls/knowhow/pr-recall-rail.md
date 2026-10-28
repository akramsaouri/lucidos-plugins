---
name: PR Recall Rail (cards on merge)
description: How PRs you reviewed turn into pr-recall cards once they merge — the merge-watch detector (triggers/pr-recall-merge-watch/scripts/detect.py, on a cron setup offers; reviewed-by gate, event-log dedup via PrRecallCardsCreated), the "PR recall - cards on merge" intent trigger that runs `/pr-recall create` in a coding agent against the registered repo, the card store (artifacts/pr-recall/cards.json, written only by the skill's store.py), and the event payloads. Load when the PrRecallRequested trigger fires, when a merged PR has no recall cards, when cards.json looks wrong, or when asked about "recall cards", "pr-recall", "remember this PR".
---

# PR Recall Rail

Same cheap-detector / expensive-worker split as the review-prep rail (`review-prep-rail`
owns the identity, dedup and read-only conventions this file follows).

| Piece | Kind | Does |
|---|---|---|
| `triggers/pr-recall-merge-watch/scripts/detect.py` | script, on the merge-watch cron setup offers | A few `gh api` GETs per listed repo; emits `PrRecallRequested` per newly merged PR I reviewed. Silent. |
| **PR recall - cards on merge** | intent, `on: PrRecallRequested` | Spawns a coding agent that runs `/pr-recall create`, which writes cards through `store.py`. Emits `PrRecallCardsCreated`. Silent. |

The `pr-recall` Claude Code skill (from the pr-understanding set in the skillz marketplace)
owns the card shape and the `create` procedure: read its SKILL.md, don't restate it here.
Setup checks it is installed.

## Scope and gate (detector)

Every repo the Pulls config lists (`pulls-config`), each read as its group's login.

- **Discovery**: `search/issues` with `repo:<owner/repo> is:pr is:merged reviewed-by:<login>
  -author:<login> merged:>=<today-14d>`.
- **Gate**: `pulls/<n>/reviews` holds a review by that login in a non-`PENDING` state
  (APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED). A bare Conversation comment is not
  a review.
- `pulls/<n>` says `merged: true` with a `merge_commit_sha`.
- Identity: `pulls_config.gh_env_for(...)` → `GH_TOKEN`, never the ambient account.

An org with an IP allow list answers search with 422 and REST with 403 off its network.
The detector logs that as *unreachable*, never as zero merges, and catches up on the next
run on the network: the window is 14 days and dedup is event-based.

## Dedup and retry (event log, no state file)

Key is `(repo, pr)`: a merged PR's merge SHA never changes. The payload still carries
`merge_sha`.

- `PrRecallCardsCreated` at the key → terminal. **Emitted for zero cards too**: zero is a
  valid outcome and must stop the retries.
- `PrRecallRequested` younger than 6 h → in flight, skip.
- Older request, no cards → retry (`retry: true`, `attempt: N`), up to 3 attempts, then give
  up (stderr says so).
- At most 3 emits per run, so a backlog spreads out. Event store unreadable → emit nothing.

Dry run (emits nothing): `python3 data/triggers/pr-recall-merge-watch/scripts/detect.py --dry-run`
from the workspace root.

## `PrRecallRequested` payload

```json
{"summary": "...", "repo": "acme-corp/storefront", "folder": "storefront", "repo_slug": "store",
 "pr": 759, "url": "https://github.com/acme-corp/storefront/pull/759", "title": "...", "author": "sam-lee",
 "merge_sha": "<40>", "merge_sha7": "be56c6c", "sha": "be56c6c", "head_sha": "<40>",
 "merged_at": "...", "base": "main", "gh_config_dir": "~/.config/gh", "login": "octo-dev",
 "credential": null, "reviewed_states": ["APPROVED","COMMENTED"], "attempt": 1, "retry": false}
```

`repo` here is `owner/name` (the skill's form), unlike `ReviewPrepRequested` where `repo`
is the bare GitHub name and `folder` the registered repository.

## The worker (intent trigger)

1. **Trust the payload**; don't re-derive the gate.
2. **Prefetch the PR yourself, BEFORE spawning: the child never calls `gh`.** The child is
   a trigger-rooted, unattended session: any command containing `$(...)` (or a `mktemp`
   capture, or a redirect outside the workspace) is refused outright, and every `gh` call
   needs the trigger's **Use cloud CLIs** grant. The worker (this intent thread) does the
   reads with `run_python`, identity pinned through `data/scripts/pulls/pulls_config.py`
   (`gh_env(payload.login, payload.gh_config_dir, payload.credential)`; the token stays in
   the subprocess env, never in a prompt or an event):
   - dir: `/tmp/pr-recall/<repo_slug>-<pr>-<merge_sha7>/` (a literal path);
   - `pr.json`: `gh pr view -R <repo> <pr> --json number,url,title,body,author,state,mergedAt,headRefName,headRefOid,baseRefOid,baseRefName,files,additions,deletions,closingIssuesReferences`;
   - `pr.diff`: `gh pr diff -R <repo> <pr>`;
   - `reviews.json`: `gh api repos/<repo>/pulls/<pr>/reviews` (and `comments.json` from
     `pulls/<pr>/comments` if the skill uses review threads).

   If any read fails, stop: no spawn, no emit (step 6).
3. Spawn a coding agent with `run_coding_agent(folder=<payload.folder>)` as a **child**.
   A one-PR card pass is small. The prompt carries:
   - the prefetched inputs (the literal dir and file names) and: **"Do not run `gh` at all —
     every GitHub fact you need is in these files. If the skill's steps call `gh`, read the
     matching file instead."**
   - the store as a literal absolute path, built from `$LUCIDOS_WORKSPACE` before you write
     the prompt (no `$HOME` or `$(...)` in it):
     `export PR_RECALL_STORE="<workspace>/data/artifacts/pr-recall/cards.json"`, and
     `LUCIDOS_WORKSPACE` likewise if unset, so store.py writes through `lucidos data write`;
   - one plain command per step, no command substitution;
   - the instruction: run the `pr-recall` skill, `create <repo>#<pr>` (e.g.
     `/pr-recall create acme-corp/storefront#759`). Scope is decided: I reviewed it;
   - read-only: no checkout, no branch move, no commit / push / comment / review / label.
     The only write is `store.py upsert`. Never hand-edit cards.json;
   - finish with the skill's fenced `json` block (schema `pr-skills/recall/v1`).
4. **Verify from the store, not the child's claim**: `python3 ~/.claude/skills/pr-recall/store.py path`,
   then count cards in cards.json with a matching repo (case-insensitive) and `pr`.
5. Save the child's JSON block (if any) to
   `artifacts/pr-recall/runs/<repo_slug>-<pr>-<merge_sha7>.json` with `lucidos data write`:
   an audit trail, above all for zero-card runs whose reason lives nowhere else.
6. Emit:
   ```bash
   lucidos events emit PrRecallCardsCreated --summary "pr-recall: N card(s) for storefront#759" \
     --payload '{"repo":"acme-corp/storefront","pr":759,"merge_sha":"<40>","merge_sha7":"be56c6c","sha":"be56c6c","cards":N,"card_ids":[...],"status":"ok|not_merged|no_cards","run_path":"artifacts/pr-recall/runs/store-759-be56c6c.json"}'
   ```
   `status: no_cards` when the skill decided nothing outlives the merge. If the child failed,
   **do not emit**: the detector retries after 6 h. Don't notify either.
7. If the session worktree ended with a moved branch or a diff (it shouldn't), park it on the
   SHA it started at, per `review-prep-rail` § Park the branch.

## Store facts

- `artifacts/pr-recall/cards.json`, `{"schema":"pr-recall/cards/v1","cards":[...]}`: the
  pr-recall skill's own store (its `store.py` defaults to this path in a Lucidos
  workspace), so it sits beside, not under, `artifacts/review-cockpit/`. Cards for all repos
  in one file; ids `<owner/repo>#<pr>-<n>`.
- `store.py upsert` replaces a PR's cards (re-running is safe), validates fields and the
  140-character `fact`, and refuses to overwrite a file it can't parse.
- Readers: pr-lanes (`store.py overlap`) on every prep pass, the Pulls app (to name a recall
  hit's files), and `pr-recall match` by hand.
