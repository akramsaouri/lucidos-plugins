#!/usr/bin/env python3
"""Auto-start the conflict resolver on MY OWN PRs when GitHub reports a conflict.

Called at the end of mine.py, right after my-prs.json is written. mine.py runs on
its cron and on every Refresh, so a conflict is picked up on the first sweep after
GitHub has computed mergeability.

It does not resolve anything. It emits the same PrConflictResolutionRequested the
Pulls app's Rebase button emits, so the "Resolve PR conflicts on demand" trigger
and resolve-pr-conflicts/scripts/run.py do the validation, the in-flight dedup and
the spawn exactly as for a click. The card shows "rebasing" the same way.

Gate, per PR in my-prs.json:
  1. the repo has `auto_resolve_conflicts: true` in the Pulls config (off by default)
  2. mergeable == CONFLICTING, not a draft, not a fork head
  3. never requested before for this (repo, pr, sha7) - by a click or by us.
     A resolver that STOPPED on a product hunk must not be re-spawned on the
     same head every sweep; a new head (new push, or the resolver's own push
     that went stale again) is a new request.
  4. at most DAILY_CAP auto requests per PR in 24h - a base that keeps moving
     under a long-lived branch must not loop agents.
Never hard-fails: the status sweep must not break because of this step.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.environ.get("LUCIDOS_WORKSPACE", ""), "data", "scripts", "pulls"))
import pulls_config  # noqa: E402


def auto_repos():
    """`owner/repo` for every repo the config opts in to automatic conflict resolution."""
    try:
        return {r["full"] for g in pulls_config.groups() for r in g["repos"]
                if r["auto_resolve_conflicts"]}
    except pulls_config.ConfigError as e:
        print(f"auto_conflicts: {e}", file=sys.stderr)
        return set()


DAILY_CAP = 3
MY_PRS = "artifacts/review-cockpit/my-prs.json"


def events(t, limit=200):
    r = subprocess.run(["lucidos", "events", "query", "--type", t, "--limit", str(limit)],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return []
    try:
        return json.loads(r.stdout)
    except ValueError:
        return []


def main():
    AUTO_REPOS = auto_repos()
    if not AUTO_REPOS:
        return 0
    try:
        path = subprocess.run(["lucidos", "data", "path", MY_PRS], capture_output=True,
                              text=True, check=True).stdout.strip()
        with open(path) as f:
            prs = json.load(f).get("prs", [])
    except Exception as e:  # noqa: BLE001
        print(f"auto_conflicts: cannot read {MY_PRS}: {e}", file=sys.stderr)
        return 0

    cands = [p for p in prs
             if p.get("repo") in AUTO_REPOS and p.get("mergeable") == "CONFLICTING"
             and not p.get("draft") and not p.get("cross_repo")]
    if not cands:
        return 0

    seen, auto_recent = set(), {}
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    for t in ("PrConflictResolutionRequested", "PrConflictResolutionStarted"):
        for e in events(t):
            pl = e.get("payload", {})
            k = (pl.get("repo"), pl.get("pr"), pl.get("sha7"))
            seen.add(k)
            if t == "PrConflictResolutionRequested" and pl.get("auto"):
                try:
                    when = datetime.fromisoformat(e["created"].replace("Z", "+00:00"))
                except (KeyError, ValueError):
                    continue
                if when > cutoff:
                    pk = (pl.get("repo"), pl.get("pr"))
                    auto_recent[pk] = auto_recent.get(pk, 0) + 1

    for p in cands:
        k = (p["repo"], p["number"], p["sha7"])
        if k in seen:
            continue
        if auto_recent.get((p["repo"], p["number"]), 0) >= DAILY_CAP:
            print(f"auto_conflicts: {p['repo']}#{p['number']} hit {DAILY_CAP}/24h, leaving it for the button")
            continue
        payload = {
            "summary": f"Auto: resolve conflicts on {p['repo']}#{p['number']} ({p['head_ref']} -> {p['base_ref']})",
            "repo": p["repo"], "pr": p["number"], "url": p["url"], "sha7": p["sha7"],
            "head_ref": p["head_ref"], "base_ref": p["base_ref"],
            "head_repo": p.get("head_repo"), "cross_repo": False, "auto": True,
        }
        r = subprocess.run(["lucidos", "events", "emit", "PrConflictResolutionRequested",
                            "--payload", json.dumps(payload)],
                           capture_output=True, text=True, timeout=60)
        print(f"auto_conflicts: requested {p['repo']}#{p['number']} @ {p['sha7']} exit={r.returncode}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print(f"auto_conflicts failed: {e}", file=sys.stderr)
        sys.exit(0)
