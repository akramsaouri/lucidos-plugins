#!/usr/bin/env python3
# lucidos-credentials: CRED_GITHUB
"""Queue the review-prep rail for one PR, on a click from the Pulls app.

WHY THIS EXISTS
---------------
The review lane shows every PR someone asked me to review, and marks the ones
the rail hasn't reached yet as `not prepped yet`. That chip is a schedule fact:
the detector polls hourly, debounces a fresh head for 10 minutes, and the review
itself takes ~40 minutes — so a PR opened five minutes ago correctly reads
"pending" and there was no way to say "do this one now, I'm about to read it".

This is that button. The app emits `ReviewPrepManualRequested`, this script
validates it and emits the real `ReviewPrepRequested` — the same event
`detect.py` emits on its own schedule, so the ~40-min findings review picks it
up unchanged.
Nothing downstream can tell a manual queueing from a scheduled one, deliberately.

WHY IT IS NOT THE APP EMITTING `ReviewPrepRequested` DIRECTLY
-------------------------------------------------------------
Two reasons, both load-bearing:

1. **The payload needs the GitHub identity.** Several accounts can share one
   machine and the ambient default may be none of them (see
   knowhow/pulls-config.md). The rails come from the Pulls config through
   `detect.load_rails()`, one table, no copy, and the payload is built here
   rather than trusted from the app.

2. **The queue artifact's head SHA is up to an hour old.** Prepping the SHA the
   card was rendered with would key findings to a head that has already moved,
   and the cockpit would show them as `stale prep` the moment they landed. So the
   head is re-read from GitHub at click time and the CURRENT one is queued.

WHAT IT DELIBERATELY SKIPS
--------------------------
`DEBOUNCE_MIN` — the 10-minute "the author may still be pushing" wait. That guard
exists because a rebase-and-force-push sequence would otherwise queue one 40-min
review per intermediate commit. A human pressing a button is not that; the whole
point of the button is "now", and a debounce would make it look broken.

The eligibility gate (`requested_by_me`) is skipped too, for a stronger reason: a
click IS a request, and the most direct one there is. The gate exists to stop the
rail appointing itself (a full review of a PR nobody had asked about), which
cannot happen when the user pressed the button themselves.

WHAT IT REFUSES
---------------
| Case | Exit | Why |
|---|---|---|
| repo not on any rail | 1 | no identity can see it, and no registered clone to review in |
| `gh` unreachable | 1 | a failed lookup is not a green light — same rule as the detector |
| PR closed / merged / draft | 1 | ~40 min and millions of tokens on code nobody will land |
| findings already exist for the CURRENT head | 0 | benign — unless `force` (below) |
| a review is genuinely RUNNING for this head | 0 | benign — a second click must not spawn a second review |

The two benign cases exit 0 on purpose: they are duplicate-click outcomes, not
failures, and a scheduler error notification for "it was already running" trains
the user to ignore error notifications.

EVERY REFUSAL IS ANNOUNCED (`ReviewPrepRefused`)
------------------------------------------------
Exiting 0 quietly was the other half of the 2026-08-19 bug. A refusal printed to
a trigger thread's stdout is a refusal nobody reads, so the app kept rendering
the optimistic `reviewing` lock it set on click and the card sat at "started 0m
ago" indefinitely. Both benign exits now emit `ReviewPrepRefused` with the same
(repo, pr, sha) key the other rail events use, so the app can drop its lock and
say which guard caught the click. See `refuse()`.

LIVENESS, NOT EVENT AGE
-----------------------
The in-flight guard asks the thread projection whether a reviewer thread is
actually running, because a `ReviewPrepRequested` event proves only that a run
was ASKED FOR. A cancelled or crashed review leaves its event behind and used to
lock the button for the full `STALE_HOURS` window with nothing running. See
`reviewer_running()`.

`force`: A REDO IS NOT A DUPLICATE CLICK
----------------------------------------
The findings guard treats "an artifact exists at this head" as "there is nothing
to do", which is right for a double-click and wrong for the case the Re-prep
button exists for: a run that was current and WRONG. The rail has three recorded
ways to produce one — a corrupted tree (a review of `main` from minute six), a
base resolved against a stale local branch (a ~300-file diff against a real 7), and a toolchain that never ran, so every verdict is statically argued.
Each lands a complete, correctly-keyed artifact. Nothing in the event log can tell
it from a good one, so the human pressing the button is the only signal there is,
and swallowing it makes the control look dead — which is exactly how it presented.

So `force: true` from the app skips the FINDINGS check only. The in-flight check
still applies unconditionally: a second review of a head already under review is
two 40-minute runs racing to overwrite one path, which no label on a button
justifies. The existing artifact is left alone rather than moved aside — the write
is keyed on (repo, pr, sha7) and overwrites when the new run finishes, so the old
findings stay readable in the cockpit for the whole ~40 minutes instead of the card
going blank the moment the redo starts.
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
# The rail owns RAILS, gh(), events() and the identity table. Imported, never
# re-implemented: a second copy of "which config dir sees which org" is the one
# duplication that silently 404s.
sys.path.insert(0, os.path.normpath(
    os.path.join(HERE, "..", "..", "review-prep-work-prs", "scripts")))
import detect  # noqa: E402

SHA_OK = re.compile(r"^[0-9a-f]{7,40}$")


def die(msg, code=1):
    print(f"review-prep-on-demand: {msg}", file=sys.stderr)
    sys.exit(code)


def emit(event_type, payload):
    """Best-effort domain event. A refusal that cannot be announced is still a
    refusal, so a failed emit must never turn an exit-0 into a crash."""
    try:
        r = subprocess.run(
            ["lucidos", "events", "emit", event_type, "--payload", json.dumps(payload)],
            capture_output=True, text=True, timeout=60)
        return r.returncode == 0
    except Exception:
        return False


def refuse(reason, detail, *, repo=None, pr=None, sha7=None, url=None):
    """Exit 0 without queueing, and SAY SO ON THE EVENT LOG.

    A benign refusal still has to be VISIBLE. This script used to `print()` and
    exit 0, and the print goes to a trigger thread nobody reads: the click was
    absorbed in total silence while the app went on rendering the optimistic
    `reviewing` lock it had already set. That is exactly how 2026-08-19 played
    out — six clicks on one PR between 18:33 and 18:58, every one refused
    here, none of them queued, and the card claiming a review had `started 0m
    ago` the whole time because nothing ever contradicted it.

    So every non-queueing exit emits `ReviewPrepRefused`, carrying the same
    (repo, pr, sha) key the request and findings events use. The app subscribes
    to it, drops the optimistic lock, and tells the user which of the guards
    caught the click. A silent guard is indistinguishable from a broken button;
    an announced one is a fact the UI can render.
    """
    emit("ReviewPrepRefused", {
        "summary": f"Review prep for {repo}#{pr} at {sha7} was not queued: {detail}",
        "repo": repo, "pr": pr, "sha": sha7, "sha7": sha7, "url": url,
        "reason": reason, "detail": detail,
    })
    print(f"review-prep-on-demand: {detail}")
    sys.exit(0)


# The trigger whose thread IS the ~40-minute review. The map rail
# ("Review prep - PR map") also subscribes to ReviewPrepRequested, but it
# finishes in minutes and its liveness says nothing about whether findings are
# coming, so it deliberately does not count here.
REVIEWER_TRIGGER = "Review prep - PRs"


def reviewer_running():
    """Is a review actually running right now? True / False / None (unknown).

    THE IN-FLIGHT GUARD USED TO ASK THE WRONG QUESTION. It read the event log
    for a recent `ReviewPrepRequested` and treated its existence as proof a
    review was under way — but the event records that a run was ASKED FOR, not
    that it is still alive. A review thread that was stopped, crashed, or died
    to an engine restart leaves its request event behind, and the guard then
    refuses every retry for the full STALE_HOURS window while nothing whatsoever
    is running. That is the 2026-08-19 lockout: an 18:28 review was cancelled
    at 18:29, and the button stayed dead until 21:28 would have
    aged the event out.

    The detector's 3-hour retry exists for precisely this case, so the rail
    always recovered eventually — which is why this read as a UI bug for months
    rather than a stuck guard. A button means NOW; waiting three hours for a
    scheduled sweep to notice the corpse is not now.

    Liveness comes from the thread projection instead, which knows what is
    actually executing. `None` on any failure, so the caller stays conservative
    rather than treating an unreadable projection as an all-clear.
    """
    try:
        r = subprocess.run(
            ["lucidos", "threads", "list", "--status", "running",
             "--source", "trigger", "--limit", "200"],
            capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            return None
        rows = json.loads(r.stdout)
    except Exception:
        return None
    if not isinstance(rows, list):
        return None
    return any(row.get("trigger_name") == REVIEWER_TRIGGER for row in rows)


def find_rail(full_name):
    """org/repo -> (rail, bare repo name), or (None, None)."""
    for rail in detect.load_rails():
        if not rail.get("prep"):
            continue  # a group that turns prep off gets no Prep button either
        for name in rail["repos"]:
            if f"{rail['org']}/{name}" == full_name:
                return rail, name
    return None, None


def main():
    raw = os.environ.get("TRIGGER_EVENT_PAYLOAD")
    if not raw:
        die("no TRIGGER_EVENT_PAYLOAD — this trigger only runs on an event")
    payload = json.loads(raw)

    full = (payload.get("repo") or "").strip()
    number = payload.get("pr")
    clicked_sha7 = (payload.get("sha7") or "").strip()
    if not full or not isinstance(number, int):
        die(f"malformed payload: repo={full!r} pr={number!r}")
    if clicked_sha7 and not SHA_OK.match(clicked_sha7):
        die(f"malformed sha7 {clicked_sha7!r}")

    rail, repo = find_rail(full)
    if not rail:
        die(f"{full} is not on any review-prep rail — nothing can review it")
    folder, slug = rail["repos"][repo]

    meta = detect.gh(
        rail, "api", f"repos/{rail['org']}/{repo}/pulls/{number}",
        "--jq", '{sha: .head.sha, base: .base.ref, title: .title, url: .html_url, '
                'author: .user.login, files: .changed_files, add: .additions, '
                'del: .deletions, draft: .draft, state: .state}')
    if meta is None:
        # Same rule as the detector: a failed lookup is not "nothing to do".
        die(f"gh could not read {full}#{number} — not queueing on a failed lookup")
    pr = json.loads(meta)

    if pr.get("state") != "open":
        die(f"{full}#{number} is {pr.get('state')} — not queueing a review for it")
    if pr.get("draft"):
        die(f"{full}#{number} is a draft — it is still being written")

    head = pr.get("sha") or ""
    if not SHA_OK.match(head):
        die(f"unreadable head sha for {full}#{number}")
    sha7 = head[:7]
    moved = bool(clicked_sha7) and sha7 != clicked_sha7

    # The two guards worth keeping from the detector. Both read the event log, so
    # they survive restarts and cannot drift out of sync with what actually ran.
    #
    # The findings guard is the only one `force` may skip: it asks "does an
    # artifact exist", and a Re-prep click is a statement that the one on disk is
    # wrong. The in-flight guard below asks "is a review running right now", which
    # no button label makes safe to ignore — two runs racing to write one path.
    force = bool(payload.get("force"))
    done = {detect.key(e.get("payload", {}))
            for e in detect.events("ReviewFindingsProduced")}
    if (repo, number, sha7) in done and not force:
        refuse("findings_exist",
               f"{full}#{number} already has findings at {sha7} — nothing to queue",
               repo=repo, pr=number, sha7=sha7, url=pr["url"])
    replacing = (repo, number, sha7) in done

    now = datetime.now(timezone.utc)
    for e in detect.events("ReviewPrepRequested"):
        if detect.key(e.get("payload", {})) != (repo, number, sha7):
            continue
        ts = detect.parse_ts(e.get("created"))
        if not (ts and now - ts < timedelta(hours=detect.STALE_HOURS)):
            break   # newest first; an older one is a dead run the detector will retry
        mins = int((now - ts).total_seconds() // 60)
        # A recent request is a SUSPICION of a live run, never proof of one. Ask
        # the thread projection what is actually executing before refusing: the
        # window this guard covers is three hours, and spending it locked out of
        # a button because a previous run was cancelled is worse than the double
        # -review it protects against. Unknown (None) still refuses — an
        # unreadable projection is not an all-clear.
        running = reviewer_running()
        if running is False:
            print(f"review-prep-on-demand: a request for {full}#{number} at {sha7} "
                  f"exists from {mins} min ago but no reviewer thread is running "
                  f"— treating it as dead and re-queueing")
            break
        detail = (f"a review of {full}#{number} at {sha7} started {mins} min ago "
                  f"— not queueing a second one")
        if running is None:
            detail += " (could not confirm liveness, so assuming it is alive)"
        refuse("already_in_flight", detail,
               repo=repo, pr=number, sha7=sha7, url=pr["url"])
        break

    out = {
        "summary": f"Review prep requested for {repo}#{number} at {sha7} "
                   f"(asked for from the Pulls app"
                   f"{', replacing existing findings' if replacing else ''})",
        "rail": rail["name"],
        "org": rail["org"],
        "repo": repo,
        "folder": folder,
        "repo_slug": slug,
        "gh_config_dir": rail["gh_config_dir"],
        "login": rail["me"], "credential": rail.get("credential"),
        "pr": number, "sha": sha7, "head_sha": head,
        "base": pr["base"], "title": pr["title"], "author": pr["author"],
        "url": pr["url"],
        "files_changed": pr["files"], "additions": pr["add"], "deletions": pr["del"],
        "retry": False,
        # Marks the queueing, not the PR. The reviewer and the map rail ignore it;
        # it is here so the event log can tell a button press from a poll.
        "manual": True,
        # Set only when this run overwrites an artifact that already existed at
        # this exact head — the deliberate-redo case. The rails ignore it too; it
        # is what makes "why are there two runs at one SHA" answerable later.
        "replaces_findings": replacing,
        # Carried verbatim from the queue row when the app had one, because the
        # cockpit prints it under a lane that asserts a request exists. A manual
        # prep on a PR with no recorded signal says so rather than inventing one.
        "requested_via": payload.get("requested_via") or "prepped on request",
    }
    r = subprocess.run(
        ["lucidos", "events", "emit", "ReviewPrepRequested",
         "--payload", json.dumps(out)],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        die(f"emit failed: {r.stderr[:300]}")

    print(f"queued {full}#{number} at {sha7}"
          + (" (replacing the findings already on disk)" if replacing else "")
          + (f" (the head moved from {clicked_sha7} since the click)" if moved else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
