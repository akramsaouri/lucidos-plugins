#!/usr/bin/env python3
# lucidos-credentials: CRED_GITHUB
"""Snapshot the PRs that are ON ME TO REVIEW right now, across every configured identity.

THE HOLE THIS FILLS. The cockpit's "On me to review" lane was built by globbing
`artifacts/review-cockpit/findings/*.json`. That made the lane a *findings
reader*, not a queue: an artifact is an immutable fact about a SHA, so once one
existed the card existed forever. Three failure modes followed, all of them
"the list is wrong":

  1. My OWN PRs appeared in it. One was reviewed as an experiment subject and
     its artifacts stayed on disk — so it sat in "On me" as a conflict AND in
     "On me to review", as if someone had asked me to review my own work.
  2. Merged, closed, or withdrawn PRs never left. Nothing on disk changes when a
     review request is revoked or the PR lands.
  3. A PR someone asked me to review that the rail hadn't prepped yet was
     INVISIBLE — no artifact, no card — which is the exact moment the lane most
     needs to say something.

So the queue is a live reading, like my-prs.json, and findings are joined ONTO
it. Same split mine.py already draws: facts go in the event log, live state goes
in an overwritten snapshot with a staleness clock.

ONE GATE, TWO CALLERS. The eligibility rules live in detect.py and are imported
here, never re-implemented. If this file had its own copy of "did someone ask
me", the queue and the rail that preps it would drift, and the lane would show
cards no review was ever scheduled for (or hide ones that were).

ALREADY-ANSWERED IS NOT STILL-ON-ME. If I've had my say on the current head, the
ball is back with the author and the PR drops out of the lane. If they pushed
after I spoke, it comes back. This is the mirror image of the stale-reviewer
check in mine.py — same question, other side of the table.

AND "MY SAY" IS NOT ONLY A SUBMITTED REVIEW. GitHub splits comments across three
objects and a Conversation-tab comment is not a review, so a queue that reads
`pulls/N/reviews` alone cannot see the Pulls app's own primary output — the
composed comment I paste onto the PR. One PR sat in "On me to review" for two
hours after I had posted 900 words on it. See detect.my_say().

THAT TEST NOW LIVES IN detect.py TOO, and is imported rather than copied
(2026-08-17). It was defined here, and detect.py had no equivalent — so this
script could write `reviewed_current: true` in the same minute the detector
queued a fresh 40-minute review of the identical head. Two questions, one
answer: the board's "is the ball still mine" and the rail's "is this worth
preparing" are the same bit, and a second copy would drift the same way a second
copy of the gate would.
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detect  # noqa: E402  - shared gate; see "ONE GATE, TWO CALLERS" above
import pulls_config  # noqa: E402  - put on sys.path by detect

RAILS = detect.load_rails()

OUT = "artifacts/review-cockpit/review-queue.json"


def collect(rail):
    """Return (rows, reachable) for one rail."""
    candidates, reachable = detect.discover(rail)
    if not reachable:
        print(f"[{rail['name']}] gh unreachable; not reporting an empty queue",
              file=sys.stderr)
        return [], False

    rows = []
    for (repo, number) in sorted(candidates):
        folder, slug = detect.repo_ids(rail, repo)
        meta = detect.gh(
            rail, "api", f"repos/{rail['org']}/{repo}/pulls/{number}",
            "--jq", '{sha: .head.sha, base: .base.ref, title: .title, url: .html_url, '
                    'author: .user.login, files: .changed_files, add: .additions, '
                    'del: .deletions, draft: .draft, state: .state, '
                    'created: .created_at, updated: .updated_at}')
        if meta is None:
            continue
        try:
            pr = json.loads(meta)
        except (ValueError, TypeError):
            continue

        # A draft is still being written; a closed/merged PR is nobody's problem.
        if pr.get("draft") or pr.get("state") != "open":
            continue

        # THE OWN-PR FIX. Never mine, on any rail. A search rail's
        # qualifiers can surface my own PR through `mentions:@me` (I get mentioned
        # on my own PRs constantly), so excluding by author is not redundant with
        # the gate — it's the only thing that catches that path.
        if pulls_config.is_me(pr.get("author")):
            print(f"[{rail['name']}] {repo}#{number}: skip — mine")
            continue

        # THE GATE. A team request is not an ask — see detect.requested_by_me.
        # `pool` splits the "nobody asked" case in two: a team-only request with
        # no individual named is genuinely unassigned work (visible, but never
        # claimed to be mine), while a team request that named someone else is
        # their PR and drops out entirely.
        why, pool = "review-requested or mentions", False
        if rail.get("require_request"):
            ok, why, pool = detect.requested_by_me(rail, repo, number)
            if not ok and not pool:
                print(f"[{rail['name']}] {repo}#{number}: skip — "
                      f"{why or 'nobody asked'}")
                continue
            if not ok:
                print(f"[{rail['name']}] {repo}#{number}: pool — {why}")

        head = pr["sha"] or ""
        rev = detect.my_say(rail, repo, number, head)
        reviewed_current = bool(rev and rev["current"])

        rows.append({
            "identity": rail["name"],
            "rail": rail["name"],
            "org": rail["org"],
            "repo": f"{rail['org']}/{repo}",
            "repo_name": repo,
            "repo_slug": slug,
            "folder": folder,
            "number": number,
            "title": pr["title"],
            "url": pr["url"],
            "author": pr["author"],
            "sha7": head[:7],
            "head_sha": head,
            "base_ref": pr["base"],
            "files_changed": pr["files"],
            "additions": pr["add"],
            "deletions": pr["del"],
            "requested_via": why,
            # False for a team-only PR: real work, but nobody assigned it to me.
            # The lane renders these in a separate, quieter section — putting them
            # under "On me to review" is the exact false assertion this fixes.
            "assigned": not pool,
            # Whether I've already had my say on THIS head, on EITHER surface —
            # a submitted review or a Conversation-tab comment. The lane hides
            # these rather than dropping them from the artifact: "you answered
            # it" is a different answer from "it was never on you", and the
            # count line should be able to tell them apart.
            "reviewed_current": reviewed_current,
            # `kind` is review | comment. The app prints it, because "you
            # reviewed this" and "you commented on this" are different claims
            # and only one of them clears a review request on GitHub.
            "my_review": ({
                "kind": rev["kind"],
                "state": rev["state"],
                "sha7": rev["sha7"],
                "at": rev["at"],
                "url": rev.get("url"),
            } if rev else None),
            "created_at": pr["created"],
            "updated_at": pr["updated"],
        })
    return rows, True


PRUNE_DIRS = [
    ("artifacts/review-cockpit/findings", ".json"),
    ("artifacts/review-cockpit/raw", ".json"),
    ("artifacts/pr-understanding", ".html"),
    ("artifacts/pr-understanding/before-components", ".html"),
]

# store-763-4cd3feb.json, builtin-store-1601-3c49e70.json, and the map files,
# which key by REPO FOLDER instead: storefront-app-632-08f25d7.html. Both forms are
# matched against the known keys below rather than a generic pattern, because a
# greedy `[a-z]+` silently fails on a hyphenated folder name (it matched
# `storefront` in `storefront-app-632` and then found no digits, so every map file was
# skipped in the first version of this).
ART_RE = re.compile(
    r"^(?:builtin-|workflow-)?(?P<key>.+?)-(?P<num>\d+)-(?P<sha>[0-9a-f]{6,})\."
)


def _slug_map():
    """artifact key -> (rail, github repo name). Keyed by BOTH the artifact slug
    (findings/raw) and the repo folder (pr-understanding maps), built from the
    same RAILS the gate uses so a new repo cannot be pruned against the wrong
    identity."""
    out = {}
    for rail in RAILS:
        for repo, (folder, slug) in rail["repos"].items():
            out[slug] = (rail, repo)
            out[folder] = (rail, repo)
    return out


def prune(live_keys, dry_run=False):
    """Delete findings/maps for PRs that are MERGED or CLOSED.

    WHY THIS IS HERE. Every artifact is keyed by (pr, head sha), so a re-push
    adds a file rather than replacing one — one PR alone left three. Nothing
    ever removed them, and artifact count is a performance axis (best-practices
    rule 8). The sweep already knows which PRs are live, so it is the cheapest
    place to notice the rest.

    CONSERVATIVE BY CONSTRUCTION. Absence from the live queue is NOT the test:
    a PR drops out of the gate when I have had my say on the current head, and
    its findings must survive that. Only a PR the API confirms as merged/closed
    is pruned. An unreachable rail prunes nothing, for the same reason a failed
    rail is not an empty queue.
    """
    ws = os.environ.get("LUCIDOS_WORKSPACE")
    if not ws:
        print("prune: $LUCIDOS_WORKSPACE unset — skipping", file=sys.stderr)
        return 0

    slugs = _slug_map()
    by_pr = {}
    for rel, ext in PRUNE_DIRS:
        d = os.path.join(ws, "data", rel)
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if not fn.endswith(ext):
                continue
            m = ART_RE.match(fn)
            if not m or m.group("key") not in slugs:
                continue
            key = (m.group("key"), int(m.group("num")))
            if key in live_keys:      # still on the board — never touch it
                continue
            by_pr.setdefault(key, []).append(os.path.join(rel, fn))

    removed = 0
    for (slug, number), paths in sorted(by_pr.items()):
        rail, repo = slugs[slug]
        state = detect.gh(
            rail, "api", f"repos/{rail['org']}/{repo}/pulls/{number}",
            "--jq", '(if .merged then "merged" else .state end)')
        if state is None:                      # unreachable: prune nothing
            continue
        state = state.strip().lower()
        if state not in ("merged", "closed"):  # still open, just off the board
            continue
        for p in sorted(paths):
            if dry_run:
                print(f"  would delete [{state}] {slug}#{number}: {p}")
                removed += 1
                continue
            # No `lucidos data delete` subcommand exists (write/path only), so
            # remove on disk and let the engine's file watcher pick it up.
            try:
                os.remove(os.path.join(ws, "data", p))
                removed += 1
            except OSError as exc:
                print(f"prune: {p}: {exc}", file=sys.stderr)
    return removed


def main():
    if not RAILS:
        # No usable config is not an empty queue: write nothing, say why.
        print("no Pulls config to sweep; nothing written", file=sys.stderr)
        return 1
    rows, failed = [], []
    for rail in RAILS:
        got, ok = collect(rail)
        if not ok:
            # A failed rail is NOT an empty queue. Recorded so the cockpit can say
            # "<group> is unreachable" instead of rendering a confident empty lane.
            failed.append(rail["name"])
            continue
        rows.extend(got)

    # Assigned work first, then the unassigned pool, each newest-first.
    rows.sort(key=lambda r: (not r["assigned"], r["reviewed_current"], -r["number"]))

    doc = {
        "schema": "review-cockpit/review-queue/v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "rails_failed": failed,
        "counts": {
            "total": len(rows),
            # on_me counts ASSIGNED work only. A team-only PR is in `pool`: real,
            # visible, and nobody's — counting it here is how the lane started
            # asserting requests that never happened.
            "on_me": sum(1 for r in rows
                         if r["assigned"] and not r["reviewed_current"]),
            "pool": sum(1 for r in rows
                        if not r["assigned"] and not r["reviewed_current"]),
            "reviewed": sum(1 for r in rows if r["reviewed_current"]),
        },
        "prs": rows,
    }

    tmp = "/tmp/review-queue.json"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=2)
    r = subprocess.run(["lucidos", "data", "write", OUT, "--from", tmp],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        print(f"write failed: {r.stderr[:300]}", file=sys.stderr)
        return 1

    subprocess.run(
        ["lucidos", "events", "emit", "ReviewQueueSnapshotted", "--payload", json.dumps({
            "summary": f"{doc['counts']['on_me']} PRs awaiting my review"
                       + (f", {doc['counts']['pool']} unassigned in the pool"
                          if doc["counts"]["pool"] else "")
                       + (f" ({', '.join(failed)} unreachable)" if failed else ""),
            **doc["counts"], "rails_failed": failed,
        })],
        capture_output=True, text=True, timeout=60,
    )

    print(f"{len(rows)} in queue, {doc['counts']['on_me']} awaiting me, "
          f"{doc['counts']['pool']} unassigned"
          + (f", failed: {failed}" if failed else ""))

    # Prune artifacts for PRs that have landed. Only rails that answered are
    # considered, so a gh outage never mistakes unreachable for merged.
    if not failed:
        live = set()
        for r in rows:
            # A live PR must be protected under BOTH naming schemes: findings
            # key by artifact slug, maps by repo folder.
            live.add((r["repo_slug"], r["number"]))
            live.add((r["folder"], r["number"]))
        n = prune(live, dry_run=os.environ.get("PRUNE_DRY_RUN") == "1")
        if n:
            print(f"pruned {n} artifact(s) for merged/closed PRs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
