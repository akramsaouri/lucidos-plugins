#!/usr/bin/env python3
# lucidos-credentials: CRED_GITHUB
"""Spawn a coding agent to rebase a conflicted PR, on a click from the Pulls app.

WHY THIS EXISTS
---------------
The Pulls app can already *tell* you a PR is conflicted — mine.py reads
`mergeable: CONFLICTING` off GitHub every 30 minutes. Acting on it was the one
thing that still meant leaving the app: find the clone, fetch, rebase, fix the
hunks, force-push. This closes that loop from the card that reported it.

An iframe cannot run `git`, and no SDK call spawns a process. So the app emits
`PrConflictResolutionRequested` and this script — running natively — starts the
coding-agent thread. Same emit → SSE → scheduler → exec round trip as the
Open PR trigger and the status refresher, for the same reason.

WHAT IT DOES *NOT* DO
---------------------
It does not resolve anything itself. It validates, dedups, gathers the facts a
resolver needs, and spawns a Claude Code session against the registered repo.
The judgement — which side of a hunk survives — is the coding agent's, because
that is a code question, not a scheduling one.

THE THREE FACTS THE PROMPT CANNOT BE WRITTEN WITHOUT
----------------------------------------------------
1. **The head branch may be checked out in a live worktree.** Conflicted PRs
   often are (a `.claude/worktrees/<name>` holding the branch). `git checkout
   <branch>` in a fresh worktree then fails with "already checked out", and the
   fix is NOT to steal the branch — those are the user's live sessions. The resolver detaches at the PR head and pushes with
   `HEAD:refs/heads/<branch>`, never checking the branch name out at all. This
   script detects the situation and says so in the prompt, because a force-push
   to a branch someone has open locally is a fact the human needs told.
2. **Which GitHub identity can see the repo.** Several accounts can share one
   machine and the ambient default may be none of them — see
   knowhow/pulls-config.md. Wrong
   identity means a 404 that reads like a deleted PR.
3. **How this repo is allowed to be integrated** — `conflict_style`, and it is NOT
   derivable from the merge style. The original reasoning here was that a
   squash-merging repo's branches are disposable, so a post-rebase force-push is
   routine. That reads backwards. A branch whose history
   is discarded at land time is precisely the branch you never need to rewrite: a
   `Merge branch 'main' into <branch>` commit costs nothing, because the squash
   throws it away with everything else.

   And on some repos rewriting is not available anyway. A tracked
   `.claude/settings.json` (a TEAM file) can deny:

       "Bash(git push -f*)", "Bash(git push --force*)"

   `--force*` prefix-matches `--force-with-lease`, so the rule written to stop the
   dangerous form swallows the safe lease-pinned one the rail was built around.
   Deny beats allow in Claude Code, so no allowlist entry anywhere rescues it, and
   a resolver once finished a clean verified rebase and then could not publish it. Rebase-and-cannot-push is not a degraded outcome, it is a
   wasted run.

   So `conflict_style` is per repo, in the Pulls config: `merge` where force is
   denied, `rebase` (the default) where it is not.
   `merge` publishes with a plain `git push`, the same shape the comment-addressing
   rail already uses, which is fast-forward-only and therefore cannot strand a
   local checkout at all.

DEDUP
-----
One resolver per (repo, pr, head sha). A second click while one is in flight is
a no-op with a toast, not a second agent racing the first on the same branch.
The window is bounded by RESOLVE_TTL_MIN so a crashed session doesn't wedge the
button forever; a new commit changes the SHA and is a new request either way.
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.environ.get("LUCIDOS_WORKSPACE", ""), "data", "scripts", "pulls"))
import pulls_config  # noqa: E402


class _Repos:
    """repo full name -> how to reach it, read from the Pulls config on each lookup.

    `repo` is the name registered in Settings → Repositories (what `spawn-thread
    --repo` resolves); `gh_config_dir`, `credential` and `login` say WHO to act
    as. All are needed: a gh config dir can hold several accounts and its
    active-account pointer decides which one `gh` becomes, so a `gh auth switch`
    anywhere re-points every script that names only the dir. See
    scripts/pulls/pulls_config.py. Only repos the config LISTS are here: an
    any_repo PR shows in Pulls but gets no write rail.

    A mapping, so the Ask rail and the stranded-worktree check that import this
    module keep reading `REPOS.get(full)` as before.
    """

    def get(self, full, default=None):
        try:
            r = pulls_config.repo(full)
        except pulls_config.ConfigError as e:
            print(f"pulls config: {e}", file=sys.stderr)
            return default
        if not r or not r["listed"]:
            return default
        return {"repo": r["registered_repo"], "gh_config_dir": r["gh_config_dir"],
                "login": r["login"], "credential": r["credential"],
                "conflict_style": r["conflict_style"], "local_path": r["local_path"]}

    def __contains__(self, full):
        return self.get(full) is not None


REPOS = _Repos()

RESOLVE_TTL_MIN = 90
REF_OK = re.compile(r"^[\w./\-]+$")
SHA_OK = re.compile(r"^[0-9a-f]{7,40}$")


def die(msg):
    print(f"resolve-pr-conflicts: {msg}", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Reaching the engine: `--to` takes the workspace PATH, never its name.
#
# `spawn-thread --to <name>` resolves the NAME against $LUCIDOS_WORKSPACES_ROOT,
# falling back to ~/workspaces. A leftover dev checkout there can still advertise a
# port in its .lucidos/ports that nothing has listened on since the move to the
# packaged app. The CLI dialled it and got connection refused, which was the whole
# of one outage of this trigger.
# Nothing about the message pointed at the real cause: the engine WAS running, just
# not where a stale file said it was.
#
# The live engine tells every subprocess where it is, so ask it rather than a file:
#
# 1. `--to $LUCIDOS_WORKSPACE` (absolute) bypasses the name lookup entirely. The
#    engine still checks the basename against the workspace it serves, so a
#    mistargeted spawn is a 409, never a silent write into the wrong workspace.
# 2. The CLI reads the target's port from <ws>/.lucidos/ports, and the packaged
#    engine never writes that file. Its port is ephemeral — assigned at boot — so a
#    file written once is wrong after the next restart. Refresh it from the injected
#    env on every spawn: cheap, and self-healing across restarts.
# 3. Scheme is derived, not assumed. The packaged engine serves plain HTTP on
#    loopback while the CLI defaults to https, which fails against it with a TLS
#    "record overflow". `--insecure-http` is right only while the base URL really is
#    http://, so read it instead of hardcoding the flag.
# ---------------------------------------------------------------------------
def engine_spawn_flags():
    """`--to` (and maybe `--insecure-http`) for the engine that spawned us."""
    ws_dir = os.environ.get("LUCIDOS_WORKSPACE", "").rstrip("/")
    if not ws_dir:
        die("$LUCIDOS_WORKSPACE is unset — cannot tell which engine to spawn into")

    base = os.environ.get("LUCIDOS_API_BASE_URL", "")
    port = os.environ.get("LUCIDOS_API_PORT", "").strip()
    if not port and "://" in base:
        port = base.rsplit(":", 1)[-1].strip("/")
    if not port.isdigit():
        die(f"no usable engine port in $LUCIDOS_API_PORT / $LUCIDOS_API_BASE_URL "
            f"({base!r}) — refusing to guess one")

    # Rewrite only the API_PORT line. A dev workspace's ports file also carries
    # PG_PORT and DATABASE_URL, and clobbering those to fix a spawn would be a
    # far worse bug than the one this fixes.
    ports_file = os.path.join(ws_dir, ".lucidos", "ports")
    try:
        with open(ports_file) as fh:
            lines = fh.read().splitlines()
    except OSError:
        lines = []
    out, seen = [], False
    for line in lines:
        if line.startswith("API_PORT="):
            out.append(f"API_PORT={port}")
            seen = True
        else:
            out.append(line)
    if not seen:
        out.insert(0, f"API_PORT={port}")
    wanted = "\n".join(out) + "\n"
    current = "\n".join(lines) + "\n" if lines else None

    if wanted != current:
        os.makedirs(os.path.dirname(ports_file), exist_ok=True)
        tmp = f"{ports_file}.tmp"
        with open(tmp, "w") as fh:
            fh.write(wanted)
        os.replace(tmp, ports_file)

    flags = ["--to", ws_dir]
    if base.startswith("http://"):
        flags.append("--insecure-http")
    return flags


def events(event_type, limit=50):
    r = subprocess.run(
        ["lucidos", "events", "query", "--type", event_type, "--limit", str(limit)],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        return []
    try:
        return json.loads(r.stdout)
    except ValueError:
        return []


def already_running(repo, pr, sha7):
    """A resolver started for this exact head, recently, and not yet finished."""
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=RESOLVE_TTL_MIN)
    done = {
        (e["payload"].get("repo"), e["payload"].get("pr"), e["payload"].get("sha7"))
        for e in events("PrConflictResolutionFinished", 100)
    }
    for e in events("PrConflictResolutionStarted", 100):
        p = e.get("payload", {})
        if (p.get("repo"), p.get("pr"), p.get("sha7")) != (repo, pr, sha7):
            continue
        if (repo, pr, sha7) in done:
            continue
        try:
            when = datetime.fromisoformat(e["created"].replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        if when > cutoff:
            return e
    return None


def live_worktree(clone, branch):
    """Is `branch` checked out somewhere? Returns the path, or None.

    `git worktree list --porcelain` prints `branch refs/heads/<name>` per entry.
    A branch that is checked out cannot be checked out again — and when the
    holder is `.claude/worktrees/*` it is a live human session that must not be
    disturbed (knowhow/review-prep-rail.md § Read-only invariants).
    """
    try:
        r = subprocess.run(["git", "worktree", "list", "--porcelain"], cwd=clone,
                           capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    path = None
    for line in r.stdout.splitlines():
        if line.startswith("worktree "):
            path = line.split(" ", 1)[1]
        elif line.strip() == f"branch refs/heads/{branch}":
            return path
    return None


def clone_path(repo_name, local_path=None):
    """Where the registered repo lives on disk: the config's `local_path`, else the
    path Lucidos registered it under."""
    for p in (local_path, pulls_config.registered_path(repo_name)):
        if p:
            p = os.path.expanduser(p)
            if os.path.isdir(os.path.join(p, ".git")) or os.path.isfile(os.path.join(p, ".git")):
                return p
    return None


def build_prompt(pl, cfg, clone, held_by):
    repo_full, pr, url = pl["repo"], pl["pr"], pl["url"]
    head, base, sha7 = pl["head_ref"], pl["base_ref"], pl["sha7"]
    style = cfg.get("conflict_style", "rebase")

    holder = ""
    if held_by:
        if style == "merge":
            holder = (
                f"\n**`{head}` is currently checked out at `{held_by}`.** Do not touch that "
                f"worktree and do not try to check the branch out — git will refuse, and it "
                f"is a live session. Work detached, as described below. Your push only ADDS "
                f"a commit, so that checkout is merely behind afterwards: note in your final "
                f"message that it catches up losslessly with `git pull --ff-only`.\n"
            )
        else:
            holder = (
                f"\n**`{head}` is currently checked out at `{held_by}`.** Do not touch that "
                f"worktree and do not try to check the branch out — git will refuse, and it is "
                f"a live session. Work detached, as described below. Note in your final message "
                f"that after your push that checkout is behind and needs "
                f"`git fetch && git reset --hard origin/{head}`.\n"
            )

    # The two shapes differ in three places — how you integrate, how you abort, and
    # how you publish. Everything else (the stop rule, verification, the report) is
    # identical, so only these blocks are swapped.
    if style == "merge":
        integrate = f"""Merge the current base into the PR head and resolve every conflict:

```
git merge origin/{base}
```

**This repo's history may NOT be rewritten**, so do not rebase and do not amend: its
`.claude/settings.json` denies `git push --force*`, which prefix-matches
`--force-with-lease` too, and a rebased branch would have no way to reach the remote.
If the repo squash-merges, this merge commit is discarded when the PR lands anyway.

If a hunk is not yours to settle (see below), `git merge --abort`."""
        publish = f"""If — and only if — the merge is complete and verification passed:

```
git push origin HEAD:refs/heads/{head}
```

**No `--force`, no `--force-with-lease`, no lease pin.** This push only adds commits, so
it is a plain fast-forward. A non-fast-forward rejection means someone pushed while you
worked and your base is stale — that is the CORRECT outcome. Do not force past it, do not
rebase to make it go through: stop and report it."""
    else:
        integrate = f"""Rebase onto the current base and resolve every conflict:

```
git rebase origin/{base}
```

Rebasing is this repo's expected shape — do not add a merge commit.

If a hunk is not yours to settle (see below), `git rebase --abort`."""
        publish = f"""If — and only if — the rebase is complete and verification passed:

```
git push --force-with-lease=refs/heads/{head}:{sha7} origin HEAD:refs/heads/{head}
```

`--force-with-lease` pinned to `{sha7}` is what makes this safe: if anyone pushed to the
branch while you worked, the push is refused instead of overwriting them. If it is
refused, do not retry with `--force` — stop and report it."""

    return f"""Resolve the merge conflict on {repo_full}#{pr} so it can merge into `{base}`.

{url}
Head branch `{head}` at `{sha7}`, base `{base}`. GitHub reports `mergeable: CONFLICTING`.
{holder}
## How to get to the code

Your session worktree is a clone of `{repo_full}`. Detach at the PR head rather than
checking the branch out — the branch may be checked out elsewhere, and detaching works
either way:

{pulls_config.shell_identity(cfg)}

```
git fetch origin refs/pull/{pr}/head {base}
git checkout --detach {sha7}
git rev-parse HEAD          # confirm you are at {sha7}
```

## What to do

{integrate}

**Resolve only what is mechanically unambiguous.** Both sides moved, an import list
diverged, a rename collided with an edit, formatting churn — those you settle from the
code. But if a hunk encodes a *product* decision (two different behaviours for the same
case, one side deleting logic the other extended), that is not yours to pick: abort,
push nothing, and report which hunk and what the two choices imply. A silently-dropped
change is far worse than a conflict that is still there.

After each resolution, read the surrounding function — not just the hunk. The most common
bad integration is one that conflicts cleanly and leaves a call site pointing at a
signature that changed on the other side.

## Verify before pushing

Build it, and run whatever test scope covers the touched files. If the repo has no fast
check, say so in the report rather than implying you verified something you didn't.
Compiling is the minimum bar; passing the tests around the change is the real one.

## Publishing

{publish}

**Run the push as a bare command** — not `cd … && export … && git push …`. A compound
command defeats the permission matcher and is denied on a form that would otherwise be
allowed, which once cost two denials and a full re-run.

If a PreToolUse hook blocks the push with an instruction (this repo gates every
feature-branch push behind `.claude/hooks/require-code-review-before-push.sh`, cleared
with `.claude/hooks/mark-code-review.sh`), follow it — that is a repo policy, not an
obstacle. A denial from the PERMISSION layer is different: stop and report it, never
reshape the command to slip past.

Then confirm GitHub agrees:

```
gh api repos/{repo_full}/pulls/{pr} --jq '.mergeable_state'
```

## Do not

- Do not touch `.claude/worktrees/*` or any worktree other than your own.
- Do not comment on the PR, request reviews, add labels, or merge it.
- Do not change behaviour beyond what resolving the conflict requires. This is a conflict
  resolution, not a refactor, not a cleanup, not a drive-by fix of something you noticed.
- Do not amend or reword commits that are not in conflict.

## Report

Finish with: each conflicted file and which way it was resolved and why, what you ran to
verify and the result, whether you pushed, and the PR's `mergeable_state` afterwards.
If you stopped early, what is left for a human to decide.

## Last step, whatever the outcome

The Pulls app holds this PR's Rebase button disabled while you run, and releases it on
this event. Emit it even when you stopped early or pushed nothing — otherwise the card
stays stuck on "rebasing" until a 90-minute timeout:

```
lucidos events emit PrConflictResolutionFinished --summary "<one line: what happened>" --payload '{{"repo":"{repo_full}","pr":{pr},"sha7":"{sha7}","outcome":"resolved","pushed":true,"new_sha7":"<sha after push>","files":<n>,"verified":"<what you ran>"}}'
```

`outcome` is `resolved` (pushed a clean rebase), `stopped` (a hunk needed a human), or
`failed` (rebase or verification broke). Keep the payload on ONE line — a shell-quoted
JSON argument split across lines is a different command.

`sha7` must stay `{sha7}` — the head you were asked about. The app keys the lock on it,
so reporting the new SHA there would leave the old one held forever.
"""


def main():
    prepare = "--prepare" in sys.argv
    payload = json.loads(os.environ.get("TRIGGER_EVENT_PAYLOAD", "{}"))

    repo_full = (payload.get("repo") or "").strip()
    try:
        pr = int(payload.get("pr"))
    except (TypeError, ValueError):
        die(f"bad pr number: {payload.get('pr')!r}")
    head = (payload.get("head_ref") or "").strip()
    base = (payload.get("base_ref") or "").strip()
    sha7 = (payload.get("sha7") or "").strip()
    url = (payload.get("url") or "").strip()

    cfg = REPOS.get(repo_full)
    if not cfg:
        die(f"{repo_full!r} isn't listed in the Pulls config (artifacts/review-cockpit/config.json) "
            f"— add it there and register the clone first")
    if not (REF_OK.match(head) and REF_OK.match(base)):
        die(f"refusing branch names {head!r} -> {base!r}")
    if not SHA_OK.match(sha7):
        die(f"{sha7!r} is not a sha")
    if not url.startswith(f"https://github.com/{repo_full}/pull/"):
        die(f"url {url!r} does not belong to {repo_full}#{pr}")

    # A fork head is a different job: no push rights, so the resolution would have
    # to go through the contributor. Refuse rather than half-do it.
    if payload.get("cross_repo"):
        die(f"#{pr} is from a fork ({payload.get('head_repo')}) — cannot push to its branch")

    running = already_running(repo_full, pr, sha7)
    if running:
        msg = (f"resolver already in flight for {repo_full}#{pr} @ {sha7} "
               f"(started {running.get('created')}) — not spawning a second")
        if prepare:
            print(json.dumps({"action": "noop", "reason": msg}))
            return 0
        print(msg)
        return 0

    clone = clone_path(cfg["repo"], cfg.get("local_path"))
    if not clone:
        die(f"no clone found for registered repo {cfg['repo']!r}")
    held_by = live_worktree(clone, head)

    prompt = build_prompt(
        {"repo": repo_full, "pr": pr, "url": url, "head_ref": head,
         "base_ref": base, "sha7": sha7},
        cfg, clone, held_by,
    )

    started_payload = {
        "summary": f"Coding agent started on the {repo_full}#{pr} rebase"
                   + (f" ({head} is open at {os.path.basename(held_by)})" if held_by else ""),
        "repo": repo_full, "pr": pr, "sha7": sha7, "url": url,
        "head_ref": head, "base_ref": base,
        "cc_repo": cfg["repo"],
        "conflict_style": cfg.get("conflict_style", "rebase"),
        "branch_held_by": held_by,
    }

    # --prepare: build everything, spawn nothing. See knowhow/pr-button-rails.md.
    if prepare:
        print(json.dumps({
            "action": "spawn",
            "repo": cfg["repo"],
            "title": f"Resolve conflicts: {repo_full.split('/')[-1]}#{pr}",
            "prompt": prompt,
            "started_payload": started_payload,
            "started_event": "PrConflictResolutionStarted",
        }))
        return 0

    # `--to` takes the workspace PATH plus the live engine's port, not the
    # workspace NAME — see engine_spawn_flags() for why the name route is a trap.
    r = subprocess.run(
        ["lucidos", "spawn-thread",
         *engine_spawn_flags(),
         "--cc",
         "--repo", cfg["repo"],
         "--relation", "top",
         "--title", f"Resolve conflicts: {repo_full.split('/')[-1]}#{pr}",
         "--message", prompt],
        capture_output=True, text=True, timeout=120,
    )
    if r.returncode != 0:
        die(f"spawn failed: {r.stderr[:500]}")

    # `spawn-thread` prints a markdown thread link; the uuid in it is the handle
    # the app uses to deep-link the user into the session it just started.
    link = r.stdout.strip()
    m = re.search(r"thread:[^/]+/([0-9a-f-]{36})", link)
    thread_id = m.group(1) if m else None

    subprocess.run(
        ["lucidos", "events", "emit", "PrConflictResolutionStarted", "--payload",
         json.dumps({**started_payload, "thread_id": thread_id})],
        capture_output=True, text=True, timeout=60,
    )
    print(f"spawned {link} for {repo_full}#{pr} @ {sha7}"
          + (f" (branch open at {held_by})" if held_by else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
