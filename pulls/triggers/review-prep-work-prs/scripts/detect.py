#!/usr/bin/env python3
# lucidos-credentials: CRED_GITHUB
"""Detect PRs that need review prep; emit one ReviewPrepRequested per PR head.

This script is the *event source* for the review-prep rail. A cheap poll stands in
for GitHub webhooks: it runs on the cron setup creates, costs a couple of `gh` API
calls per rail, and emits nothing on a quiet cycle. The expensive part, the
multi-agent review, is a separate event-driven trigger that fires only on an emit.

ONE RAIL PER CONFIG GROUP, EACH WITH ITS OWN IDENTITY. The repos, owners and logins
come from `artifacts/review-cockpit/config.json` (see knowhow/pulls-config.md),
read through scripts/pulls/pulls_config.py. Each group names the login that can see
its owner, and every gh call is pinned to that login's token, never the ambient
account: see pulls_config.token_for.

EVERY RAIL GATES ON A REAL REQUEST. A PR is only queued when someone actually asked:
a review request naming me, an @-mention of me in the PR body or a comment, or my own
review of an earlier head. Being open and not-mine is NOT a request.

Discovery differs per group (`discovery` in the config), the gate does not:

  search  search qualifiers, `review-requested:@me` / `mentions:@me`, scoped to the
          group's repos (or the whole owner for any_repo). Scales to big repos.
  list    list each repo's open PRs (authoritative, no search-index lag; best on a
          small, fast-moving repo), then require a request signal on each.

Gating on "every open PR not authored by me" was tried and was wrong in practice: it
queued 40-minute reviews nobody had asked for. Author exclusion is still applied, but
only as a safety rail; it is not the gate.

Dedup and retry state live entirely in the event log (no local state file), so the
detector is stateless and survives restarts:

  ReviewPrepRequested    - this PR head has been queued for review
  ReviewFindingsProduced - this PR head has been reviewed (terminal)

Emit rules, in order:
  1. skip if a ReviewFindingsProduced exists for (repo, pr, sha7)   -> already done
  2. skip if I have already reviewed/commented on THIS head          -> already answered
  3. skip if the head commit is younger than DEBOUNCE_MIN            -> still pushing
  4. skip if a ReviewPrepRequested exists and is younger than STALE_HOURS -> in flight
  5. otherwise emit (covers first sight AND retry of a run that died)
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.environ.get("LUCIDOS_WORKSPACE", ""), "data", "scripts", "pulls"))
import pulls_config  # noqa: E402

# A push sequence (rebase, fixup, force-push) should collapse into ONE review, not
# one per commit. Wait until the head has been still this long before queueing it.
DEBOUNCE_MIN = 10

# A request with no findings after this long means the review died (crash, timeout,
# engine restart mid-run). Re-emit so the PR isn't silently stranded forever.
STALE_HOURS = 3


def load_rails():
    """The rails from config.json, or [] (with the reason on stderr) when it's unusable."""
    try:
        return pulls_config.rails()
    except pulls_config.ConfigError as e:
        print(f"pulls config: {e}", file=sys.stderr)
        return []


def _teams_that_ask_me():
    try:
        return pulls_config.load()["team"]["teams_that_ask_me"]
    except pulls_config.ConfigError:
        return []


TEAMS_THAT_ASK_ME = _teams_that_ask_me()


def repo_ids(rail, repo):
    """(registered folder, artifact slug) for a repo, with the any_repo fallback."""
    return rail["repos"].get(repo) or (repo, repo)


def token_for(rail):
    """The token that acts as the rail's login. See pulls_config.token_for."""
    return pulls_config.token_for(rail["me"], rail["gh_config_dir"], rail.get("credential"))


def gh(rail, *args):
    """Run a gh call as the rail's own IDENTITY. Returns stdout, or None on failure."""
    env = pulls_config.gh_env(rail["me"], rail["gh_config_dir"], rail.get("credential"))
    if not env:
        print(f"[{rail['name']}] " + pulls_config.missing_token_msg(
            rail["me"], rail["gh_config_dir"], rail.get("credential")), file=sys.stderr)
        return None
    try:
        r = subprocess.run(
            ["gh", *args], env=env, capture_output=True, text=True, timeout=60
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"[{rail['name']}] gh {' '.join(args[:2])} failed: {e}", file=sys.stderr)
        return None
    if r.returncode != 0:
        print(f"[{rail['name']}] gh {' '.join(args[:2])} rc={r.returncode}: "
              f"{r.stderr[:300]}", file=sys.stderr)
        return None
    return r.stdout



def events(event_type, limit=200):
    try:
        r = subprocess.run(
            ["lucidos", "events", "query", "--type", event_type, "--limit", str(limit)],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode != 0:
            return []
        data = json.loads(r.stdout or "[]")
        # The CLI returns a bare array today, but tolerate the wrapped shape.
        return data.get("events", []) if isinstance(data, dict) else data
    except Exception as e:  # noqa: BLE001 - detector must never hard-fail
        print(f"events query {event_type} failed: {e}", file=sys.stderr)
        return []


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def key(payload):
    return (payload.get("repo"), payload.get("pr"), (payload.get("sha") or "")[:7])


def requested_by_me(rail, repo, number):
    """Did a HUMAN actually ask ME to review this PR? Returns (ok, why, pool).

    Four ways a real ask arrives:

      reviewer   .requested_reviewers names me
      mention    "@<me>" in the PR body, an issue comment, or a review comment
      history    I already reviewed an earlier head — a new push is still mine,
                 and GitHub clears me out of requested_reviewers the moment I
                 submit, so without this the PR silently stops being my problem
                 exactly when the author answers my feedback

    A TEAM request is NOT one of them. This is a correction of the original
    design, which counted any outstanding team request as an ask because
    `review-requested:@me` expands them. Measured on one busy repo:

      named individually            -> I reviewed  3 of 3
      TEAM + someone else named     -> I reviewed  0 of 8
      TEAM only, nobody named       -> I reviewed  4 of 20

    The team request came from a `.github/CODEOWNERS` catch-all that fired on
    every PR in the repo, so it carried no information about who should look.
    A team named in the config's `team.teams_that_ask_me` is the exception:
    its request counts as asking me.

      team + others named  -> (False, "...", False)  their PR, not mine
      team only            -> (False, "...", True)   the unassigned pool

    `pool` lets the caller keep a team-only PR visible as a pool member without
    asserting it was assigned to me. Dropping it silently would be the same
    class of lie in the other direction.

    Returns (False, "", False) when the PR is genuinely unrequested, and
    (False, "unreachable", False) when a lookup FAILED — never conflate a
    network failure with "nobody asked".
    """
    me = rail["me"].lower()
    out = gh(rail, "api", f"repos/{rail['org']}/{repo}/pulls/{number}",
             "--jq", '{reviewers: [.requested_reviewers[].login], '
                     'teams: [.requested_teams[] | (.slug // .name)], body: (.body // "")}')
    if out is None:
        return False, "unreachable", False
    try:
        d = json.loads(out)
    except json.JSONDecodeError:
        return False, "unreachable", False

    reviewers = [r.lower() for r in d.get("reviewers") or []]
    teams = d.get("teams") or []

    if me in reviewers:
        return True, "review requested", False

    asking = {t.lower().split("/")[-1] for t in TEAMS_THAT_ASK_ME}
    hit = next((t for t in teams if t.lower() in asking), None)
    if hit:
        return True, f"team review requested ({hit})", False

    needle = f"@{me}".lower()
    if needle in (d.get("body") or "").lower():
        return True, "mentioned in PR body", False

    comments = gh(rail, "api", f"repos/{rail['org']}/{repo}/issues/{number}/comments",
                  "-X", "GET", "-f", "per_page=100", "--jq", '.[].body')
    if comments is None:
        return False, "unreachable", False
    if needle in comments.lower():
        return True, "mentioned in a comment", False

    review_comments = gh(rail, "api", f"repos/{rail['org']}/{repo}/pulls/{number}/comments",
                         "-X", "GET", "-f", "per_page=100", "--jq", '.[].body')
    if review_comments is None:
        return False, "unreachable", False
    if needle in review_comments.lower():
        return True, "mentioned in a review comment", False

    mine = gh(rail, "api", f"repos/{rail['org']}/{repo}/pulls/{number}/reviews",
              "-X", "GET", "-f", "per_page=100",
              "--jq", f'[.[] | select(.user.login | ascii_downcase == "{me}")] | length')
    if mine is None:
        return False, "unreachable", False
    if (mine.strip() or "0") not in ("0", ""):
        return True, "I reviewed an earlier head", False

    if teams:
        others = [r for r in reviewers if r != me]
        if others:
            return False, f"team request; {others[0]} was named", False
        return False, f"team request ({teams[0]}) — nobody named", True

    return False, "", False


def head_pushed_at(rail, repo, sha):
    """When the current head landed (ISO 8601), or None if the lookup failed.

    This is the clock a Conversation-tab comment gets measured against — see
    my_say(). A None here means "can't tell", and my_say treats it as such
    rather than as a yes.
    """
    out = gh(rail, "api", f"repos/{rail['org']}/{repo}/commits/{sha}",
             "--jq", ".commit.committer.date")
    return (out or "").strip() or None


def my_say(rail, repo, number, head):
    """The last thing I said on this PR, across BOTH surfaces I can say it on.

    LIVES HERE BECAUSE TWO CALLERS NEED IT, for the same reason requested_by_me
    does. queue.py owned this until 2026-08-17 and detect.py had no equivalent —
    so the queue could mark a PR answered while the detector queued a fresh
    40-minute review of the very same head. See "Already answered is not
    unreviewed" in review-prep-rail.md for the case.

      queue.py  needs the full row  -> renders the "Answered, waiting on them" lane
      detect.py needs one bit       -> do NOT spend 40 minutes preparing me to do
                                       something I have already done

    THE CURRENCY TEST DIFFERS PER SURFACE, and neither may be guessed:

      review   `commit_id` names the commit it was written against. A lookup.
      comment  no commit anywhere on the object. Time stands in — a comment
               written after the head landed is about that head. Coarse in one
               direction only: a comment written before a force-push reads as
               stale, which puts the PR back on me. That is the safe way to be
               wrong.

    A failed `gh` call is skipped, not counted as silence — and the bias that
    creates is the correct one for both callers: fewer things I'm known to have
    answered means more cards in the lane and more reviews prepped, never fewer.
    Erring toward "still yours" is the one direction this can be wrong in safely.

    Returns the newest entry as {kind, state, sha7, at, url, current}, or None.
    """
    me = rail["me"].lower()
    said = []

    out = gh(rail, "api", f"repos/{rail['org']}/{repo}/pulls/{number}/reviews",
             "-X", "GET", "-f", "per_page=100",
             "--jq", '[.[] | {login: .user.login, state: .state, '
                     'commit: .commit_id, at: .submitted_at, url: .html_url}]')
    if out is not None:
        try:
            for r in json.loads(out):
                if (r.get("login") or "").lower() != me:
                    continue
                if r.get("state") not in ("APPROVED", "CHANGES_REQUESTED", "COMMENTED"):
                    continue
                commit = r.get("commit") or ""
                said.append({
                    "kind": "review",
                    "state": (r.get("state") or "").lower(),
                    "sha7": commit[:7],
                    "at": r.get("at") or "",
                    "url": r.get("url"),
                    "current": bool(head and commit == head),
                })
        except (ValueError, TypeError):
            pass

    out = gh(rail, "api", f"repos/{rail['org']}/{repo}/issues/{number}/comments",
             "-X", "GET", "-f", "per_page=100",
             "--jq", '[.[] | {login: .user.login, at: .created_at, url: .html_url}]')
    if out is not None:
        # Only pay for the head's timestamp when there is something to compare
        # against it. Most PRs in the queue have no comment of mine at all.
        pushed = None
        try:
            rows = [c for c in json.loads(out) if (c.get("login") or "").lower() == me]
        except (ValueError, TypeError):
            rows = []
        if rows and head:
            pushed = head_pushed_at(rail, repo, head)
        for c in rows:
            at = c.get("at") or ""
            said.append({
                "kind": "comment",
                "state": "commented",
                # No commit on this surface — deliberately empty rather than
                # filled with the PR's current head, which would fabricate an
                # anchor the object does not have.
                "sha7": "",
                "at": at,
                "url": c.get("url"),
                # Both are UTC ISO 8601 from GitHub, so a string compare is a
                # time compare (same trick as mine.py's issue_comments).
                "current": bool(pushed and at and at >= pushed),
            })

    if not said:
        return None
    said.sort(key=lambda s: s.get("at") or "")
    latest = said[-1]
    # ANY current entry means I've had my say on this head — not just the newest
    # one. A review submitted on the current head must not be un-answered by an
    # older comment sorting after it on a tie.
    latest["current"] = any(s["current"] for s in said)
    return latest


def discover(rail):
    """Return {(repo, number)} of candidate PRs, and whether the rail was reachable."""
    found = set()
    reachable = False

    if rail["queries"]:
        for q in rail["queries"]:
            out = gh(rail, "api", "-X", "GET", "search/issues",
                     "-f", f"q={q}", "-f", "per_page=30",
                     "--jq", '.items[] | [(.repository_url|split("/")|last), .number] | @tsv')
            if out is None:
                continue
            reachable = True
            for line in out.strip().splitlines():
                if not line.strip():
                    continue
                repo, number = line.split("\t")[:2]
                if repo in rail["repos"] or rail.get("any_repo"):
                    found.add((repo, int(number)))
    else:
        for repo in rail["repos"]:
            out = gh(rail, "api", f"repos/{rail['org']}/{repo}/pulls",
                     "-X", "GET", "-f", "state=open", "-f", "per_page=50",
                     "--jq", '.[] | [.number, .user.login] | @tsv')
            if out is None:
                continue
            reachable = True
            for line in out.strip().splitlines():
                if not line.strip():
                    continue
                number, author = line.split("\t")[:2]
                if pulls_config.is_me(author):
                    continue
                found.add((repo, int(number)))

    return found, reachable


def run_rail(rail, now, done, requested):
    candidates, reachable = discover(rail)

    if not reachable:
        # Every query failed - network or credential problem, not "no PRs".
        # Emitting nothing is correct; do NOT treat this as an empty result set.
        print(f"[{rail['name']}] gh unreachable; no emit", file=sys.stderr)
        return 0, 0

    if not candidates:
        print(f"[{rail['name']}] no eligible PRs")
        return 0, 0

    emitted = 0
    eligible = 0
    for (repo, number) in sorted(candidates):
        if repo not in rail["repos"]:
            continue  # an any_repo PR: shown in Pulls, never prepped
        folder, slug = rail["repos"][repo]
        meta = gh(rail, "api", f"repos/{rail['org']}/{repo}/pulls/{number}",
                  "--jq", '{sha: .head.sha, base: .base.ref, title: .title, '
                          'url: .html_url, author: .user.login, files: .changed_files, '
                          'add: .additions, del: .deletions, draft: .draft}')
        if meta is None:
            continue
        pr = json.loads(meta)
        if pr.get("draft"):
            continue
        if pulls_config.is_me(pr.get("author")):
            continue

        # The gate. Discovery (search or list) only finds candidates; this decides.
        why = ""
        if rail.get("require_request"):
            ok, why, _pool = requested_by_me(rail, repo, number)
            if not ok:
                reason = why or "nobody asked"
                print(f"[{rail['name']}] {repo}#{number}: skip — {reason}")
                continue

        # Passed the gate: a human asked. Everything after this point is dedup and
        # debounce — reasons not to re-review, not reasons it isn't mine.
        eligible += 1

        sha7 = pr["sha"][:7]
        k = (repo, number, sha7)

        if k in done:
            continue

        # ALREADY ANSWERED IS NOT UNREVIEWED (2026-08-17). The gate above says a
        # human asked; it does not say I haven't already replied. "I reviewed an
        # earlier head" is itself one of the signals requested_by_me() matches, so
        # a PR I have just reviewed re-enters the rail on the strength of that very
        # review — and the terminal check can't stop it, because my review clears
        # no findings artifact.
        #
        # The case: a review submitted at 09:53. The 10:00 sweep matched "I
        # reviewed an earlier head", found no findings at that head, and queued a
        # 40-minute multi-agent review plus a map to prepare me to review a PR I
        # had finished reviewing seven minutes earlier. queue.py knew — it
        # wrote reviewed_current: true in the same minute — but the two scripts
        # shared the gate and not this, so the board said "answered" while the rail
        # spent 4M tokens on it.
        #
        # Deliberately AFTER the findings check: an existing artifact is cheaper to
        # confirm and means the same thing. Deliberately BEFORE debounce and the
        # in-flight check, which are about *when* to review, not *whether*.
        rev = my_say(rail, repo, number, pr["sha"])
        if rev and rev["current"]:
            print(f"[{rail['name']}] {repo}#{number} {sha7}: skip — "
                  f"I already {rev['kind'] == 'review' and 'reviewed' or 'commented on'} "
                  f"this head")
            continue

        pushed = gh(rail, "api", f"repos/{rail['org']}/{repo}/commits/{pr['sha']}",
                    "--jq", ".commit.committer.date")
        pushed_at = parse_ts((pushed or "").strip())
        if pushed_at and now - pushed_at < timedelta(minutes=DEBOUNCE_MIN):
            print(f"[{rail['name']}] {repo}#{number} {sha7}: debounce, head is fresh")
            continue

        prev = requested.get(k)
        if prev and now - prev < timedelta(hours=STALE_HOURS):
            continue
        retry = bool(prev)

        payload = {
            "summary": f"Review prep requested for {repo}#{number} at {sha7}"
                       + (" (retry — earlier run produced no findings)" if retry else ""),
            "rail": rail["name"],
            "org": rail["org"],
            "repo": repo,
            "folder": folder,
            "repo_slug": slug,
            "gh_config_dir": rail["gh_config_dir"],
            "login": rail["me"], "credential": rail.get("credential"),
            "pr": number, "sha": sha7, "head_sha": pr["sha"],
            "base": pr["base"], "title": pr["title"], "author": pr["author"],
            "url": pr["url"],
            "files_changed": pr["files"], "additions": pr["add"], "deletions": pr["del"],
            "retry": retry,
            # Why this PR is on the queue at all: which signal requested_by_me()
            # matched. Carried into the findings artifact so the
            # cockpit can show it instead of the reader guessing.
            "requested_via": why or "review-requested or mentions",
        }
        r = subprocess.run(
            ["lucidos", "events", "emit", "ReviewPrepRequested",
             "--payload", json.dumps(payload)],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode == 0:
            emitted += 1
            print(f"[{rail['name']}] emitted {repo}#{number} {sha7}"
                  + (" (retry)" if retry else ""))
        else:
            print(f"[{rail['name']}] emit failed for {repo}#{number}: "
                  f"{r.stderr[:300]}", file=sys.stderr)

    return eligible, emitted


def main():
    now = datetime.now(timezone.utc)

    # Terminal + in-flight state is shared across rails; load it once.
    done = {key(e.get("payload", {})) for e in events("ReviewFindingsProduced")}
    requested = {}
    for e in events("ReviewPrepRequested"):
        k = key(e.get("payload", {}))
        ts = parse_ts(e.get("created"))
        if ts and (k not in requested or ts > requested[k]):
            requested[k] = ts

    total_eligible = total_emitted = 0
    for rail in load_rails():
        if rail.get("prep") is False:
            continue  # lane-only group: visible in Pulls, never prepped
        eligible, emitted = run_rail(rail, now, done, requested)
        total_eligible += eligible
        total_emitted += emitted

    print(f"{total_eligible} passed the gate, {total_emitted} queued")
    return 0


if __name__ == "__main__":
    sys.exit(main())
