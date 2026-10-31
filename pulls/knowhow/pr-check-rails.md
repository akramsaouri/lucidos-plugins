---
name: PR Check Rails (quiz grading + drill)
description: "How the Pulls app's PR understanding checks are served: grading a quiz or teach-back at the quiz's SHA with stale detection (PrCheckAnswersSubmitted to PrCheckGraded), and opening a drill session (PrDrillRequested). Load when either trigger fires, a grade never arrived or looks stale, or the user asks to be quizzed, graded, drilled or to teach back a PR."
---

# PR Check Rails

Vocabulary: Check has three depths — Quiz, Teach-back, Drill (a Socratic back-and-forth; "Drill" is the only name used in events, flags, triggers and UI).

The quiz itself is produced by the review-prep rail's pr-* pass (`review-prep-rail`
§ Step 0) at `artifacts/review-cockpit/check/<slug>-<pr>-<sha7>.json`. These two rails
serve what the Pulls app does with it. Skill: `~/.claude/skills/pr-check/SKILL.md` (from the
pr-understanding set in the skillz marketplace; setup checks it is installed) — it owns the
question/grade/correction formats.

| Trigger | Kind | `go_to_review` |
|---|---|---|
| **PR check - grade answers** | intent, `on: PrCheckAnswersSubmitted` | false (silent) |
| **PR check - drill** | intent, `on: PrDrillRequested` | **true** — the user chats in it |

Both are read-only toward GitHub and the repo: no comment, review, label, push, commit,
checkout or branch move. Neither notifies.

## Normalising the payload (both rails)

The app sends `{repo, pr, sha, …}`. Accept either form of each:

| Field | Accept | Resolve to |
|---|---|---|
| `repo` | `owner/name` **or** registered repository name | the Pulls config, through `data/scripts/pulls/pulls_config.py`: `repo(owner/name)` or `repo_by_registered_name(name)` |
| `sha` | 7–40 hex | `sha7 = sha[:7]`; the full SHA from the quiz artifact's `pr.head_sha`, else `git rev-parse` after fetch |

The resolved repo gives the folder for `run_coding_agent` (`registered_repo`), the artifact
`slug`, the `gh_config_dir` and the `login` (see `pulls-config`).

A repo the config doesn't list, a non-hex sha, or a non-integer pr → refuse: emit the result event with
`"error"` set (below) and stop. Identity is always pinned in the child prompt: prefix every `gh` call with
`GH_CONFIG_DIR=<dir, as a literal absolute path>` (an `export` may not persist between the
child's shell calls), and first run, as its own plain command,
`GH_CONFIG_DIR=<dir> gh api user --jq .login`. If that isn't the expected login, stop and report "identity
unpinned"; never `gh auth switch`. **No `$(...)` anywhere in the child's commands**
(2026-10-14): these children are trigger-rooted and unattended, so Lucidos always refuses
command substitution there (whatever the Command guard toggle says) and refuses every
`gh` call unless the trigger's side-effect grant has **Use cloud CLIs** ticked. The shipped
trigger.toml files declare it; with Command safety on, the user grants it at setup. The
`export GH_TOKEN=$(gh auth token …)` form can never run in these sessions. An org with an IP
allow list answers 403 "IP allow list" off its network: unreachable, not a wrong answer.

## Grading — `PrCheckAnswersSubmitted`

Payload: `{repo, pr, sha, depth: "quiz"|"teachback", answers | explanation}`.
`answers` may be `[{id, answer}]` or `{ "<id>": "<answer>" }`; pass it through as given.

1. Normalise. For `quiz`, read the quiz artifact
   `artifacts/review-cockpit/check/<slug>-<pr>-<sha7>.json` (must be `mode: "quiz"`).
   Missing → error `"no quiz at <path>"`.
2. Spawn a coding-agent **child** (`run_coding_agent(folder=<folder>)`, default relation,
   unattended; a Sonnet-sized model is plenty). The prompt carries identity, the PR as
   `<owner>/<repo>#<n>`, the SHA, and:
   - **quiz**: "Run the pr-check skill in grade mode: `/pr-check <owner>/<repo>#<n> --grade`.
     Here is the quiz JSON: <verbatim>. Here are my answers: <verbatim>. Grade against
     the quiz's `head_sha`, not the current head; if the current `headRefOid` differs, the
     skill prints the Stale line and sets `stale: true`."
   - **teachback**: "Run `/pr-check <owner>/<repo>#<n> --depth teachback "<explanation>"`,
     but **pin to <full sha>** instead of resolving the current head (read with
     `git show <sha>:<path>`, diff against `git merge-base <base> <sha>`). Then compare with
     the current `headRefOid` and, if different, add `"current_head"` and `"stale": true`
     to the JSON and print the Stale line." (The skill only defines stale for `--grade`;
     this rail adds it for teach-back so the app has one rule.)
   - read-only rules; `git fetch origin refs/pull/<n>/head` if the SHA is missing locally;
     reply with the skill's single fenced `json` block verbatim.
3. Validate: `schema == "pr-skills/check/v1"`, `mode` is `grade` (quiz) or `teachback`,
   `pr.head_sha` starts with `sha7`. Add `"stale"` (default false) and
   `"graded_at"` if absent, and `"answers"` / `"explanation"` echoing what was graded.
4. Write `artifacts/review-cockpit/check/<slug>-<pr>-<sha7>.<depth>.graded.json` with
   `lucidos data write … --from <tmp>`. `<depth>` is `quiz` or `teachback`, keyed to the
   **submitted** sha7 even when stale. A re-submission overwrites (latest attempt wins).
5. Emit:
   ```bash
   lucidos events emit PrCheckGraded --summary "pr-check quiz graded for storefront#812 @3f9c2ab: 2/3 correct" \
     --payload '{"repo":"<as received>","pr":812,"sha":"3f9c2ab","depth":"quiz",
                 "path":"artifacts/review-cockpit/check/store-812-3f9c2ab.quiz.graded.json",
                 "stale":false}'
   ```
   On failure (refused payload, child died, no JSON): same event with `"path": null` and
   `"error": "<one line>"`, so the app can drop its spinner. Never leave the click
   unanswered — same lesson as `ReviewPrepRefused` in `review-prep-rail`.

## Drill — `PrDrillRequested`

Payload: `{repo, pr, sha}`. The drill is a conversation, so it must live in a thread the
user can type into with the repo at hand: an **interactive Claude Code session**, same shape
as the Ask-about-a-PR rail.

1. Normalise; resolve the full SHA and the title/url (quiz or findings artifact for that
   key if present, else `gh pr view --json title,url,headRefOid` with pinned identity).
2. `run_coding_agent(folder=<folder>, relation="top", title="Drill: <slug>#<pr> @<sha7>")`.
   `top` so the session is NOT in the trigger's unattended privilege tree — it waits for
   the user, and any out-of-worktree action raises a card they answer. The prompt:
   - the identity rule above; PR `<owner>/<repo>#<n>`, title, url, pinned `<full sha>`;
   - "Run `/pr-check <owner>/<repo>#<n> --depth drill`, pinned to <full sha> (read with
     `git show <sha>:<path>`; fetch `refs/pull/<n>/head` if missing). Follow the skill's
     per-turn budget and stop rules. Then wait for my answers."
   - optional context if it exists: the lanes line(s) and story steps from
     `artifacts/review-cockpit/{lanes,story}/<slug>-<pr>-<sha7>.json` (paste the JSON, it's
     small) — don't paste findings, they'd spoil the drill;
   - read-only rules; no checkout needed for reading.
3. Emit with the spawned session's thread id:
   ```bash
   lucidos events emit PrDrillStarted --summary "drill opened for storefront#812 @3f9c2ab" \
     --payload '{"repo":"<as received>","pr":812,"sha":"3f9c2ab","thread_id":"<uuid>"}'
   ```
   On a failed spawn: same event with `"thread_id": null, "error": "<one line>"`.
4. Keep the trigger thread's own reply to one line pointing at the session. Both threads
   land in Current (trigger thread via `go_to_review: true`, the session because an
   interactive coding-agent session always does); the session is where the user chats.
