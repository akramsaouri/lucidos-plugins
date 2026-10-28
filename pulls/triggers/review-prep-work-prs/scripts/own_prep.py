#!/usr/bin/env python3
"""Queue the lanes-driven pr-* pass for MY OWN open PRs; emit OwnPrPrepRequested per head.

Called at the end of mine.py (same sweep, same schedule), after my-prs.json is written.
The review prep rail excludes my PRs by construction, so without this pr-lanes' "-> pr-intent"
on my own PR was a to-do nobody ran. See knowhow/review-prep-rail.md § "Own PRs".

Gate, per PR in my-prs.json:
  1. not a draft
  2. repo is listed in the Pulls config (a registered repo + artifact slug)
  3. no lanes file for <slug>-<pr>-<sha7> yet  -> terminal
  4. head pushed >= DEBOUNCE_MIN ago           -> a push sequence collapses to one pass
  5. no OwnPrPrepRequested for that key younger than STALE_HOURS -> in flight
Never hard-fails: a status sweep must not break because this queue step did.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from detect import load_rails, DEBOUNCE_MIN, STALE_HOURS, events, parse_ts, key  # noqa: E402

RAILS = load_rails()

MY_PRS = "artifacts/review-cockpit/my-prs.json"


def data_path(rel):
    return subprocess.run(["lucidos", "data", "path", rel],
                          capture_output=True, text=True, check=True).stdout.strip()


def repo_table():
    """'org/repo' -> (rail, folder, slug)."""
    out = {}
    for rail in RAILS:
        for gh_repo, (folder, slug) in rail["repos"].items():
            out[f"{rail['org']}/{gh_repo}"] = (rail, folder, slug)
    return out


def main():
    now = datetime.now(timezone.utc)
    try:
        with open(data_path(MY_PRS)) as f:
            prs = json.load(f).get("prs", [])
    except Exception as e:  # noqa: BLE001
        print(f"own_prep: cannot read {MY_PRS}: {e}", file=sys.stderr)
        return 0

    table = repo_table()
    requested = {}
    for e in events("OwnPrPrepRequested"):
        k = key(e.get("payload", {}))
        ts = parse_ts(e.get("created"))
        if ts and (k not in requested or ts > requested[k]):
            requested[k] = ts

    emitted = 0
    for pr in prs:
        name = f"{pr.get('repo')}#{pr.get('number')} {pr.get('sha7')}"
        if pr.get("draft"):
            continue
        hit = table.get(pr.get("repo"))
        if not hit:
            print(f"own_prep: {name}: skip, no registered folder for this repo")
            continue
        rail, folder, slug = hit
        number, sha7 = pr["number"], (pr.get("sha7") or "")[:7]
        if not sha7:
            continue
        lanes_rel = f"artifacts/review-cockpit/lanes/{slug}-{number}-{sha7}.json"
        try:
            if os.path.exists(data_path(lanes_rel)):
                continue
        except Exception:  # noqa: BLE001
            pass
        pushed = parse_ts(pr.get("pushed_at"))
        if pushed and now - pushed < timedelta(minutes=DEBOUNCE_MIN):
            print(f"own_prep: {name}: debounce, head is fresh")
            continue
        folder_repo = pr["repo"].split("/", 1)[1]
        k = (folder_repo, number, sha7)
        prev = requested.get(k)
        if prev and now - prev < timedelta(hours=STALE_HOURS):
            continue
        payload = {
            "summary": f"Own PR prep requested for {folder_repo}#{number} at {sha7}"
                       + (" (retry)" if prev else ""),
            "rail": rail["name"], "org": rail["org"], "repo": folder_repo,
            "folder": folder, "repo_slug": slug,
            "gh_config_dir": rail["gh_config_dir"], "login": rail["me"],
            "credential": rail.get("credential"),
            "pr": number, "sha": sha7, "head_sha": None,
            "base": pr.get("base_ref"), "title": pr.get("title"), "url": pr.get("url"),
            "own_pr": True, "retry": bool(prev),
        }
        r = subprocess.run(["lucidos", "events", "emit", "OwnPrPrepRequested",
                            "--payload", json.dumps(payload)],
                           capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            emitted += 1
            print(f"own_prep: emitted {name}")
        else:
            print(f"own_prep: emit failed for {name}: {r.stderr[:300]}", file=sys.stderr)
    print(f"own_prep: {emitted} queued")
    return 0


if __name__ == "__main__":
    sys.exit(main())
