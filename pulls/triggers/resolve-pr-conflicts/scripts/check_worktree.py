#!/usr/bin/env python3
# lucidos-credentials: CRED_GITHUB
"""After a resolver force-pushes, work out whether the human's own checkout of
that branch is now stranded — and whether resetting it would lose anything.

WHY THIS EXISTS
---------------
The resolver rebases detached and force-pushes, so it never touches the human's
worktree. That is correct and also the whole problem: a second checkout of the
same branch (a Superconductor session, a `.claude/worktrees/*` session) is left
pointing at pre-rebase commits that no longer exist on the remote, and *git
cannot warn about it*. `git status` there says "your branch and origin have
diverged, 7 and 14 different commits" — which is indistinguishable from a branch
with genuine local work on it. Commit and push from that state and you force the
pre-rebase history back over the agent's work.

The Pulls app used to render a flat "reset it after the push" warning. That put
the whole job on the reader: find the worktree, work out whether the divergence
is the rebase or real work, and reconstruct the command. Worse, it said the same
thing whether the reset was safe or would have destroyed something.

WHAT "SAFE" MEANS HERE, PRECISELY
---------------------------------
`git cherry <upstream> <head>` compares commits by PATCH ID, not SHA. A commit
that was rebased keeps its patch id, so it comes back marked `-` (already
upstream) even though its SHA changed. A commit marked `+` has no equivalent
upstream at all — that is genuine local work a hard reset would destroy.

So the verdict is:

  synced  -> already at the remote head. Nothing to do, nothing to say.
  gone    -> the worktree was removed while we worked. Nothing to say.
  dirty   -> uncommitted changes. NEVER offer a reset; the human decides.
  unique  -> `git cherry` found `+` commits. Do NOT offer a reset — name them.
  safe    -> clean tree, every local commit accounted for upstream. Offer it.

`dirty` outranks `unique` because it is the more urgent thing to look at, and a
dirty tree makes the commit comparison a partial picture anyway.

READ-ONLY, AND NOT IN SOMEONE ELSE'S WORKTREE
---------------------------------------------
Everything here is read-only: `status --porcelain`, `cherry`, `rev-parse`,
`log`. The one network call — `git fetch` — is run in the MAIN CLONE, never in
the human's worktree, because worktrees share the object store and the ref
namespace: fetching in the clone is what updates `origin/<branch>` for all of
them. Nothing in the human's worktree is modified, and the reset itself is
always the human's own keystroke.
"""
import json
import os
import re
import subprocess
import sys

REF_OK = re.compile(r"^[A-Za-z0-9._/-]{1,200}$")


def die(msg):
    print(f"worktree-check: {msg}", file=sys.stderr)
    sys.exit(1)


def git(cwd, *args, timeout=60):
    """Run a git command, returning (ok, stdout). Never raises."""
    try:
        r = subprocess.run(["git", *args], cwd=cwd, capture_output=True,
                           text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    return r.returncode == 0, (r.stdout if r.returncode == 0 else r.stderr).strip()


def clone_path(repo_name):
    """Where the registered repo lives on disk. Single source: run.py's clone_path,
    loaded by file path (run.py's main() is __name__-guarded, so loading it runs nothing)."""
    import importlib.util
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "run.py")
    spec = importlib.util.spec_from_file_location("pr_conflict_resolver", src)
    if not spec or not spec.loader:
        die(f"cannot load clone_path from {src}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    try:
        local = (mod.pulls_config.repo_by_registered_name(repo_name) or {}).get("local_path")
    except mod.pulls_config.ConfigError:
        local = None
    return mod.clone_path(repo_name, local)


def verify(clone, worktree, branch):
    """Is a hard reset of `worktree` onto origin/`branch` lossless?

    Returns the payload the app renders. See the module docstring for the
    verdict ladder.
    """
    if not os.path.isdir(worktree):
        return {"verdict": "gone"}

    upstream = f"origin/{branch}"

    # Fetch in the CLONE. Worktrees share refs, so this is what moves
    # origin/<branch> for the stranded one — without running anything in it.
    ok, out = git(clone, "fetch", "origin", branch, timeout=120)
    if not ok:
        return {"verdict": "unknown", "detail": f"fetch failed: {out[:200]}"}

    ok, local = git(worktree, "rev-parse", "HEAD")
    ok2, remote = git(worktree, "rev-parse", upstream)
    if not (ok and ok2):
        return {"verdict": "unknown", "detail": "could not resolve HEAD/upstream"}
    if local == remote:
        return {"verdict": "synced"}

    ok, porcelain = git(worktree, "status", "--porcelain")
    if not ok:
        return {"verdict": "unknown", "detail": "status failed"}
    dirty = [l for l in porcelain.splitlines() if l.strip()]

    # Patch-id comparison. `+` = no equivalent upstream.
    #
    # BUT `+` alone is too blunt to gate on. Resolving a conflict CHANGES the
    # commit's content, so its patch id changes — meaning the one commit the
    # rebase actually touched always comes back `+`. Gate on that naively and
    # the verdict is "unsafe" after literally every conflict resolution, which
    # is the one case this whole check exists for.
    #
    # So each `+` commit is asked a second question: does a commit with the
    # same subject exist in the range we're behind by? If yes, this is the
    # rebased-and-resolved copy of it — the remote version is the one to keep,
    # and it is named on the card so the human sees what they're trusting. If
    # no, nothing upstream corresponds to it and it is genuine local work.
    #
    # Residual risk, accepted knowingly: two unrelated commits could share a
    # subject (this repo really does have "refactor: simplify from pre-push
    # review" twice), so a dropped commit could in principle be matched by a
    # coincidental namesake. That is why `resolved` commits are LISTED rather
    # than silently folded into the safe count.
    ok, cherry = git(worktree, "cherry", upstream, "HEAD")
    if not ok:
        return {"verdict": "unknown", "detail": "cherry failed"}

    ok, ahead_log = git(worktree, "log", "--format=%s", f"HEAD..{upstream}")
    upstream_subjects = set(ahead_log.splitlines()) if ok else set()

    unique, resolved, rebased = [], [], 0
    for line in cherry.splitlines():
        if line.startswith("+ "):
            sha = line[2:].strip()
            _, subj = git(worktree, "log", "-1", "--format=%s", sha)
            entry = {"sha7": sha[:7], "subject": subj[:120]}
            (resolved if subj in upstream_subjects else unique).append(entry)
        elif line.startswith("- "):
            rebased += 1

    behind = 0
    ok, cnt = git(worktree, "rev-list", "--count", f"HEAD..{upstream}")
    if ok and cnt.isdigit():
        behind = int(cnt)

    common = {"rebased": rebased, "behind": behind, "worktree": worktree,
              "name": os.path.basename(worktree), "branch": branch,
              "resolved": resolved}

    # Dirty first: it is the more urgent thing to look at, and it makes the
    # commit comparison a partial picture anyway.
    if dirty:
        return {**common, "verdict": "dirty", "dirty": len(dirty),
                "unique": unique}
    if unique:
        return {**common, "verdict": "unique", "unique": unique}
    return {**common, "verdict": "safe",
            "command": f"cd {worktree} && git fetch && git reset --hard {upstream}"}


def main():
    payload = json.loads(os.environ.get("TRIGGER_EVENT_PAYLOAD", "{}"))

    # Only a push can strand a worktree. A resolver that stopped early or failed
    # left the branch exactly where the human's checkout still points.
    if not payload.get("pushed"):
        print("resolver did not push — nothing can be stranded")
        return 0

    repo_full = (payload.get("repo") or "").strip()
    pr = payload.get("pr")
    sha7 = (payload.get("sha7") or "").strip()

    # The Finished event is written by the coding agent from a prompt template,
    # so treat every field as untrusted. `branch_held_by` is not in it at all —
    # it lives on the Started event this pairs with.
    started = subprocess.run(
        ["lucidos", "events", "query", "--type", "PrConflictResolutionStarted",
         "--limit", "100"],
        capture_output=True, text=True, timeout=60,
    )
    if started.returncode != 0:
        die(f"could not read Started events: {started.stderr[:300]}")
    try:
        rows = json.loads(started.stdout)
        rows = rows.get("events", rows) if isinstance(rows, dict) else rows
    except json.JSONDecodeError:
        die("Started events were not JSON")

    match = None
    for e in rows:
        p = e.get("payload", {})
        if (p.get("repo") == repo_full and str(p.get("pr")) == str(pr)
                and p.get("sha7") == sha7):
            match = p
            break
    if not match:
        print(f"no Started event for {repo_full}#{pr} @ {sha7} — nothing to check")
        return 0

    held_by = match.get("branch_held_by")
    if not held_by:
        print("branch was not checked out anywhere — nothing to check")
        return 0

    # A merge-style resolution ADDS a commit; it never rewrites history. So the
    # human's checkout of that branch is merely BEHIND, not stranded, and
    # `git pull --ff-only` catches it up losslessly. Running the verdict ladder
    # here would be worse than useless: the merge commit has no upstream patch-id
    # equivalent, so `git cherry` reports it `+` and the verdict comes back
    # `unique` — "do not reset, you have local work" — about a worktree that is
    # in no danger at all. Same reason the comment-addressing rail has no
    # counterpart to this script.
    if match.get("conflict_style") == "merge":
        print(f"{held_by}: merge-style resolution — a fast-forward push strands nothing")
        return 0

    branch = (match.get("head_ref") or "").strip()
    if not REF_OK.match(branch):
        die(f"refusing branch name {branch!r}")

    cc_repo = match.get("cc_repo")
    clone = clone_path(cc_repo) if cc_repo else None
    if not clone:
        die(f"no clone found for registered repo {cc_repo!r}")

    result = verify(clone, held_by, branch)
    verdict = result["verdict"]

    if verdict in ("gone", "synced"):
        print(f"{held_by}: {verdict} — nothing to surface")
        return 0

    summaries = {
        "safe": f"{os.path.basename(held_by)} is stranded but every commit is upstream — reset is lossless",
        "unique": f"{os.path.basename(held_by)} has {len(result.get('unique', []))} commit(s) NOT upstream — do not reset",
        "dirty": f"{os.path.basename(held_by)} has uncommitted changes — do not reset",
        "unknown": f"could not verify {os.path.basename(held_by)}: {result.get('detail', '')}",
    }

    subprocess.run(
        ["lucidos", "events", "emit", "PrWorktreeStrandVerified", "--payload",
         json.dumps({"summary": summaries.get(verdict, verdict),
                     "repo": repo_full, "pr": pr, "sha7": sha7, **result})],
        capture_output=True, text=True, timeout=60,
    )
    print(f"{held_by}: {verdict}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
