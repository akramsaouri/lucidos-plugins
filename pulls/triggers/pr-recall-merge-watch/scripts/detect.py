#!/usr/bin/env python3
# lucidos-credentials: CRED_GITHUB
"""PR recall — merge watch. Cheap detector for the pr-recall rail.

Finds PRs I personally REVIEWED (submitted a non-pending review) that have since
MERGED, in every repo the Pulls config lists, and emits one
`PrRecallRequested` per new one. The intent trigger "PR recall - cards on merge"
subscribes and runs `pr-recall create` in a coding agent. Procedure and rationale:
knowhow/pr-recall-rail.md.

Read-only toward GitHub: `gh api` GETs only. No state file — dedup is rebuilt from
the event log every run, same pattern as review-prep-work-prs/scripts/detect.py:

  PrRecallCardsCreated  at (repo, pr)  -> done, never re-emit (merge sha is fixed)
  PrRecallRequested     at (repo, pr)  -> in flight if younger than STALE_HOURS;
                                          given up after MAX_ATTEMPTS requests

The search qualifier is DISCOVERY; the gate is the reviews endpoint (a review by
the pinned login in a non-PENDING state). Identity is pinned per repo with
scripts/pulls/pulls_config.py (GH_TOKEN per login), never the ambient gh account.

  --dry-run   print what would be emitted, emit nothing
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.environ.get("LUCIDOS_WORKSPACE", ""), "data", "scripts", "pulls"))
import pulls_config  # noqa: E402


def load_repos():
    """Every repo the Pulls config lists, with its identity. [] when the config is unusable."""
    try:
        out = []
        for g in pulls_config.groups():
            for listed in g["repos"]:
                r = pulls_config.repo(listed["full"])
                out.append({"repo": r["full"], "folder": r["registered_repo"], "slug": r["slug"],
                            "gh_config_dir": r["gh_config_dir"], "login": r["login"], "credential": r["credential"],
                            "credential": r["credential"]})
        return out
    except pulls_config.ConfigError as e:
        print(f"pulls config: {e}", file=sys.stderr)
        return []


REPOS = load_repos()

WINDOW_DAYS = 14        # only merges this recent are considered
STALE_HOURS = 6         # a request with no cards after this long died -> retry
MAX_ATTEMPTS = 3        # then give up on that PR (stderr says so)
MAX_EMITS_PER_RUN = 3   # spread a backlog over several hourly runs
DRY_RUN = "--dry-run" in sys.argv


def log(msg):
    print(msg, file=sys.stderr)


def gh(r, *args):
    env = pulls_config.gh_env_for(r)
    if env is None:
        log(f"[{r['repo']}] {pulls_config.missing_token_msg(r['login'], r['gh_config_dir'], r['credential'])}")
        return None
    try:
        p = subprocess.run(["gh", *args], env=env, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        log(f"[{r['repo']}] gh {' '.join(args[:2])} failed: {e}")
        return None
    if p.returncode != 0:
        log(f"[{r['repo']}] gh {' '.join(args[:2])} exit {p.returncode}: {p.stderr[:300]}")
        return None
    return p.stdout


def events(event_type):
    """Events of a type, or None when the store can't be read (never read as 'none')."""
    try:
        p = subprocess.run(["lucidos", "events", "query", "--type", event_type, "--limit", "1000"],
                           capture_output=True, text=True, timeout=60)
        if p.returncode != 0:
            log(f"events query {event_type} exit {p.returncode}: {p.stderr[:200]}")
            return None
        data = json.loads(p.stdout or "[]")
        return data.get("events", []) if isinstance(data, dict) else data
    except Exception as e:  # noqa: BLE001
        log(f"events query {event_type} failed: {e}")
        return None


def pkey(payload):
    return (str(payload.get("repo", "")).lower(), int(payload.get("pr") or 0))


def parse_ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def reviewed_by_me(r, number):
    """(True, states) if the login submitted a non-pending review; None if unreachable."""
    out = gh(r, "api", f"repos/{r['repo']}/pulls/{number}/reviews", "--paginate",
             "--jq", f'.[] | select(.user.login == "{r["login"]}" and .state != "PENDING") | .state')
    if out is None:
        return None
    states = sorted(set(s for s in out.split() if s))
    return (bool(states), states)


def main():
    now = datetime.now(timezone.utc)
    since = (now - timedelta(days=WINDOW_DAYS)).strftime("%Y-%m-%d")

    created = events("PrRecallCardsCreated")
    requested = events("PrRecallRequested")
    if created is None or requested is None:
        log("event store unreachable: cannot dedup, emitting nothing")
        return

    done = {pkey(e.get("payload", {})) for e in created}
    asks = {}
    for e in requested:
        asks.setdefault(pkey(e.get("payload", {})), []).append(parse_ts(e.get("created")))

    emitted = 0
    for r in REPOS:
        q = f"repo:{r['repo']} is:pr is:merged reviewed-by:{r['login']} -author:{r['login']} merged:>={since}"
        out = gh(r, "api", "-X", "GET", "search/issues", "-f", f"q={q}", "-f", "per_page=50")
        if out is None:
            # An org with an IP allow list answers search with 422 ("cannot be
            # searched") and REST with 403 off its network. Unreachable, never
            # "zero merges".
            log(f"[{r['repo']}] unreachable — skipped (not the same as zero merges; "
                f"an org with an IP allow list needs its VPN)")
            continue
        items = json.loads(out).get("items", [])
        print(f"[{r['repo']}] {len(items)} merged PR(s) reviewed-by {r['login']} since {since}")
        for it in sorted(items, key=lambda i: i["number"]):
            n = it["number"]
            k = (r["repo"].lower(), n)
            if k in done:
                print(f"  #{n} skip — cards already created")
                continue
            prior = [t for t in asks.get(k, []) if t]
            if len(prior) >= MAX_ATTEMPTS:
                print(f"  #{n} skip — gave up after {len(prior)} requests with no cards")
                continue
            if any(now - t < timedelta(hours=STALE_HOURS) for t in prior):
                print(f"  #{n} skip — request in flight")
                continue
            if (it.get("user") or {}).get("login") == r["login"]:
                print(f"  #{n} skip — my own PR")
                continue
            gate = reviewed_by_me(r, n)
            if gate is None:
                print(f"  #{n} skip — reviews unreachable")
                continue
            ok, states = gate
            if not ok:
                print(f"  #{n} skip — no submitted review by {r['login']}")
                continue
            meta = gh(r, "api", f"repos/{r['repo']}/pulls/{n}")
            if meta is None:
                print(f"  #{n} skip — PR metadata unreachable")
                continue
            m = json.loads(meta)
            if not m.get("merged") or not m.get("merge_commit_sha"):
                print(f"  #{n} skip — not merged per pulls endpoint")
                continue
            if emitted >= MAX_EMITS_PER_RUN:
                print(f"  #{n} deferred — per-run cap {MAX_EMITS_PER_RUN} reached")
                continue
            msha = m["merge_commit_sha"]
            payload = {
                "repo": r["repo"], "folder": r["folder"], "repo_slug": r["slug"],
                "pr": n, "url": m["html_url"], "title": m.get("title", ""),
                "author": (m.get("user") or {}).get("login"),
                "merge_sha": msha, "merge_sha7": msha[:7], "sha": msha[:7],
                "head_sha": (m.get("head") or {}).get("sha"),
                "merged_at": m.get("merged_at"), "base": (m.get("base") or {}).get("ref"),
                "gh_config_dir": r["gh_config_dir"], "login": r["login"], "credential": r["credential"],
                "reviewed_states": states, "attempt": len(prior) + 1, "retry": bool(prior),
            }
            summary = f"pr-recall requested for {r['slug']}#{n} (merged {msha[:7]}, reviewed: {','.join(states)})"
            if DRY_RUN:
                print(f"  #{n} WOULD EMIT PrRecallRequested: {summary}")
                emitted += 1
                continue
            p = subprocess.run(["lucidos", "events", "emit", "PrRecallRequested",
                                "--summary", summary, "--payload", json.dumps(payload)],
                               capture_output=True, text=True, timeout=60)
            if p.returncode == 0:
                emitted += 1
                print(f"  #{n} emitted PrRecallRequested")
            else:
                log(f"  #{n} emit failed: {p.stderr[:300]}")
    print(f"done: {emitted} {'would be ' if DRY_RUN else ''}emitted")


if __name__ == "__main__":
    main()
