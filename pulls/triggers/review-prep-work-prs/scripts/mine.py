#!/usr/bin/env python3
# lucidos-credentials: CRED_GITHUB
"""Snapshot the status of MY open PRs across every configured GitHub identity.

This is the OTHER half of the morning question. The review-prep rail answers
"what's on me to review"; this answers "what's on me to unblock". They are
deliberately separate scripts with separate outputs, because they have opposite
gates: the rail excludes my PRs, this one is only my PRs.

WHY A SNAPSHOT ARTIFACT AND NOT EVENTS. Findings are immutable facts about a
SHA — an event log is the right shape. PR status is the opposite: it's a live
reading that is wrong the moment someone pushes. Appending it to the event log
would accumulate thousands of superseded rows to answer "what is true now".
So this overwrites one artifact, and the cockpit reads it with a staleness clock.

EVERY IDENTITY, ONE SHAPE. The identities come from the Pulls config
(knowhow/pulls-config.md): each distinct login + gh config dir + credential the
groups use. `author:@me` resolves per identity, and the query is scoped to the
owners that identity's groups watch. A work login often cannot see a personal
org and the other way round, which is why one token can never answer for all.

ONE GRAPHQL CALL PER IDENTITY. The REST path would be 1 list + 3 per PR
(reviews, threads, checks) — ~45 calls for 15 PRs. GraphQL gets the same data
in 2 calls total, which is what makes this cheap enough to run hourly.

STATE IS DERIVED HERE, NOT IN THE UI. The cockpit renders what this computes.
Putting the "is it blocked" logic in JS would mean re-deriving it from raw
GitHub enums in a place that can't be tested and can't see history.

IT CARRIES CONTENT, NOT JUST COUNTS. Every field here used to be a scalar a
human reads and then acts on elsewhere. `threads` breaks that pattern
deliberately: "1 unresolved comment thread" is enough to know a PR is blocked
and useless for doing anything about it — you still have to open GitHub, read
the ask, and decide. The bodies travel with the row so the app can show what
was asked without a trip to GitHub.
"""

import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detect  # noqa: E402  - puts scripts/pulls on sys.path
import pulls_config  # noqa: E402  - identities and tokens; see gh_graphql below

OUT = "artifacts/review-cockpit/my-prs.json"
SHIPPED_OUT = "artifacts/review-cockpit/shipped.json"
AVATAR_DIR = "artifacts/review-cockpit/avatars"
AVATAR_INDEX = f"{AVATAR_DIR}/index.json"

# Matches BRIEF_WINDOW_DAYS in the app: the shipped-by-me rail sits directly
# opposite `Shipped without me`, and two "last N days" rails on one board
# disagreeing about N would be unreadable.
SHIPPED_WINDOW_DAYS = 7

def load_identities():
    """Each identity with the owners it watches and the owners whose groups show
    the Shipped-by-me lane. [] (reason on stderr) when the config is unusable."""
    try:
        cfg = pulls_config.load()
    except pulls_config.ConfigError as e:
        print(f"pulls config: {e}", file=sys.stderr)
        return []
    out = []
    for ident in pulls_config.identities(cfg):
        gs = [pulls_config.group(g, cfg) for g in ident["groups"]]
        out.append({**ident, "shipped_owners": [g["owner"] for g in gs if g["shipped_lane"]]})
    return out


IDENTITIES = load_identities()


def owner_scope(owners):
    """`user:a user:b`: search qualifiers that keep a query to the watched owners.
    `user:` matches repos owned by a user or an org; several are OR'd."""
    return " ".join(f"user:{o}" for o in owners)

QUERY = """
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes { ... on PullRequest {
      number title url isDraft createdAt updatedAt headRefOid
      headRefName baseRefName isCrossRepository
      headRepository { nameWithOwner }
      repository { nameWithOwner }
      mergeable
      reviewDecision
      commits(last: 1) { nodes { commit {
        committedDate
        statusCheckRollup { state }
      } } }
      reviewThreads(first: 100) { nodes {
        id isResolved isOutdated path line originalLine
        comments(first: 10) { nodes { author { login } bodyText createdAt url } }
      } }
      comments(last: 50) { nodes {
        author { login __typename } bodyText createdAt url
      } }
      latestReviews(first: 20) { nodes {
        author { login } state submittedAt commit { oid } bodyText url
      } }
      reviews(last: 30) { nodes {
        author { login } state submittedAt commit { oid }
      } }
      reviewRequests(first: 20) { nodes { requestedReviewer {
        ... on User { login }
        ... on Team { name }
      } } }
    } }
  }
}
"""



# What I shipped myself. A deliberately thin document next to QUERY above: a
# merged PR is terminal, so reviewDecision, reviewThreads and the three comment
# surfaces describe an argument that is over. What survives is what the rail is
# for — what landed, where, how big, and whether anyone looked before it did.
SHIPPED_QUERY = """
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url mergedAt createdAt additions deletions changedFiles
      baseRefName
      repository { nameWithOwner }
      latestReviews(first: 20) { nodes { author { login } state } }
    } }
  }
}
"""

# OPT-IN PER GROUP (`shipped_lane` in the config). The lane answers "what did I
# land this week" for an owner where nothing else on the board records my own
# merges, typically one with no review culture. Where there is a review rail
# over the same merges it is noise. The owner filter lives HERE rather than in
# the app so the sweep stops paying for rows nothing renders: an unscoped
# `is:merged` returned 149 merges in 30 days for one identity, every one of them
# collected, written to the artifact and then discarded at render.
#
# THIS ALSO RETIRES THE PAGING PRESSURE. An unscoped query returned exactly 50
# rows, the page size, which is what a silent cap looks like, and a busy week on
# one owner evicted the merges the lane was for. Scoping removes the competition
# rather than out-running it. Paging stays, cheaply: one page in the normal case.
SHIPPED_MAX_PAGES = 4


def shipped(ident, days):
    """MY merges, newest first — the mirror of the merge-brief rail.

    WHY THIS IS NOT A BRIEF, AND MUST NOT BECOME ONE. `Shipped without me` exists
    because I did NOT see those merges: the brief is the substitute for having
    read the PR. Here I wrote the code, so a paragraph explaining it back to me
    is the purest possible noise. So this rail carries no LLM, no `brief` field, and no
    per-merge run: it is a fact table the sweep already had the credentials and
    the round trip to collect.

    THE ONE JUDGEMENT IT DOES MAKE is `reviewed`: did a human other than me
    approve or comment before this landed. Where the lane is turned on that is
    often nobody, by agreement, and saying so plainly is the honest version of a rail whose
    sibling is titled "without me". It is read off `latestReviews`, which the
    query already pays for, rather than a second call per PR.

    WINDOW AND SCOPE. 7 days, and only the owners whose groups turn the lane
    on, both asked of the API rather than filtered here. See SHIPPED_MAX_PAGES.
    """
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    q = f"is:pr is:merged author:@me {owner_scope(ident['shipped_owners'])} merged:>={since}"
    nodes, after = [], None
    for _ in range(SHIPPED_MAX_PAGES):
        page = gh_graphql(ident, q, doc=SHIPPED_QUERY, after=after, envelope=True)
        # A failed page mid-walk is NOT a short week. Returning what we have so
        # far would write a truncated rail that looks complete.
        if page is None:
            return None
        nodes.extend(page.get("nodes") or [])
        info = page.get("pageInfo") or {}
        if not info.get("hasNextPage"):
            break
        after = info.get("endCursor")
        if not after:
            break
    else:
        print(f"[{ident['name']}] shipped: stopped at {SHIPPED_MAX_PAGES} pages "
              f"({len(nodes)} merges) — the rail may be short", file=sys.stderr)
    me = ident["login"]
    out = []
    for pr in nodes:
        reviewers = sorted({
            (r.get("author") or {}).get("login")
            for r in (pr.get("latestReviews") or {}).get("nodes") or []
            if (r.get("author") or {}).get("login")
            and (r.get("author") or {}).get("login") != me
        })
        out.append({
            "identity": ident["name"],
            "repo": pr["repository"]["nameWithOwner"],
            "number": pr["number"],
            "title": pr["title"],
            "url": pr["url"],
            "base_ref": pr["baseRefName"],
            "merged_at": pr["mergedAt"],
            "created_at": pr["createdAt"],
            "additions": pr["additions"],
            "deletions": pr["deletions"],
            "files_changed": pr["changedFiles"],
            # [] means it landed with nobody else's eyes on it. That is normal
            # on some owners and notable on others, so the app decides how to
            # read it — this only records which it was.
            "reviewed_by": reviewers,
        })
    out.sort(key=lambda p: p["merged_at"] or "", reverse=True)
    return out

def gh_graphql(ident, query_str, doc=None, after=None, envelope=False):
    """Run the search query as this identity, pinned by token.

    Same rule as every Pulls script: a gh config dir picks the account LIST, not
    the account, so the login's token is passed as GH_TOKEN. pulls_config keeps
    one implementation: this script and the queue must never disagree about who
    they are. See pulls_config.token_for for the failure it prevents.

    `doc` selects the GraphQL document. It defaults to QUERY (open PRs, with
    every review surface attached); SHIPPED_QUERY passes its own, because a
    merged PR has no live review state worth 100 threads of payload.

    `envelope` returns the whole `search` object rather than just its nodes, so
    a paging caller can read `pageInfo`. Default stays nodes-only: the open-PR
    path has one page by construction (nobody has 50 open PRs) and every
    existing caller wants the list.
    """
    env = pulls_config.gh_env_for(ident)
    if not env:
        print(f"[{ident['name']}] " + pulls_config.missing_token_msg(
            ident["login"], ident["gh_config_dir"], ident["credential"]), file=sys.stderr)
        return None
    args = ["gh", "api", "graphql", "-F", f"q={query_str}"]
    if after:
        args += ["-F", f"after={after}"]
    args += ["-F", "query=@-"]
    try:
        r = subprocess.run(
            args, input=doc or QUERY, env=env,
            capture_output=True, text=True, timeout=90,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"[{ident['name']}] graphql failed: {e}", file=sys.stderr)
        return None
    if r.returncode != 0:
        print(f"[{ident['name']}] graphql rc={r.returncode}: {r.stderr[:300]}",
              file=sys.stderr)
        return None
    try:
        search = json.loads(r.stdout)["data"]["search"]
        return search if envelope else search["nodes"]
    except (ValueError, KeyError) as e:
        print(f"[{ident['name']}] bad graphql response: {e}", file=sys.stderr)
        return None


def stale_reviewers(pr, me):
    """Reviewers whose last review sits on a commit that is no longer the head,
    with no re-request outstanding for them.

    This is the "I addressed the feedback and never clicked the re-request
    arrows" hole. GitHub does NOT re-request a reviewer when you push — the
    review just silently ages against a commit nobody is looking at anymore.
    The PR then shows a reviewer's avatar and reads as "in review" while in
    fact zero people have been asked to look at the current code.

    Only CHANGES_REQUESTED and COMMENTED count. A stale APPROVED is a different
    animal: unless the repo dismisses stale approvals it still counts, so
    nagging about it would be noise.
    """
    head = pr["headRefOid"] or ""
    pending = {
        (n["requestedReviewer"] or {}).get("login")
        or (n["requestedReviewer"] or {}).get("name")
        for n in pr["reviewRequests"]["nodes"]
    }
    out = []
    for r in pr["latestReviews"]["nodes"]:
        login = (r.get("author") or {}).get("login")
        if not login or login == me or login in pending:
            continue
        if r["state"] not in ("CHANGES_REQUESTED", "COMMENTED"):
            continue
        reviewed = (r.get("commit") or {}).get("oid") or ""
        # No commit association at all -> can't prove it's stale. Skip rather
        # than guess; a false "re-request this" is worse than a miss.
        if reviewed and reviewed != head:
            out.append({"login": login, "state": r["state"],
                        "reviewed_sha7": reviewed[:7],
                        "submitted_at": r["submittedAt"]})
    return out


def answered_changes(pr, me):
    """True when every CHANGES_REQUESTED review has already been answered by a
    later push AND its author has an outstanding re-request.

    THE HOLE THIS CLOSES. `reviewDecision` stays CHANGES_REQUESTED until that
    reviewer submits a *new* review — a push does not clear it, and neither
    does re-requesting them. So the classifier's `changes` branch kept firing
    on a PR where the feedback was addressed, the reviewers were re-asked, and
    the ball is squarely with them. It reads "changes requested / on me" on a
    PR I have nothing left to do on.

    stale_reviewers() cannot catch it, and correctly so: it excludes anyone
    with a pending request, because its whole job is "nobody is looking at
    this code". Here somebody IS looking — that is the point — which is why
    this is a separate question rather than a loosened version of that one.

    CONSERVATIVE IN THE SAME DIRECTION AS EVERYTHING ELSE HERE. A review with
    no commit association cannot be proven stale, so it counts as unanswered;
    a reviewer who is not in reviewRequests counts as unanswered (that is the
    `rerequest` state's job, and it is checked first). Being wrong toward
    "still on me" costs a second look; being wrong the other way silently
    drops a real change request off the board.
    WHY IT READS `reviews`, NOT `latestReviews`. This is the trap that made the
    first version of this function a silent no-op. `latestReviews` is "the
    current position of each reviewer" — and GitHub DROPS a reviewer from it
    entirely once they are re-requested, because their old verdict is no longer
    their position. So on exactly the PRs this function exists for,
    `latestReviews` comes back EMPTY while `reviewDecision` still says
    CHANGES_REQUESTED. The full `reviews` list keeps the submission, which is
    the only place the "which commit did they review" fact survives.
    """
    head = pr["headRefOid"] or ""
    pending = {
        (n["requestedReviewer"] or {}).get("login")
        or (n["requestedReviewer"] or {}).get("name")
        for n in pr["reviewRequests"]["nodes"]
    }
    # Latest CHANGES_REQUESTED per author, out of the full submission history.
    latest = {}
    for r in (pr.get("reviews") or {}).get("nodes") or []:
        login = (r.get("author") or {}).get("login")
        if not login or login == me:
            continue
        prev = latest.get(login)
        if prev is None or (r.get("submittedAt") or "") >= (prev.get("submittedAt") or ""):
            latest[login] = r

    found = False
    for login, r in latest.items():
        if r.get("state") != "CHANGES_REQUESTED":
            continue
        found = True
        reviewed = (r.get("commit") or {}).get("oid") or ""
        if not reviewed or reviewed == head:
            return False          # they requested changes on the current code
        if login not in pending:
            return False          # answered, but nobody was re-asked
    return found


def requested_reviewers(pr):
    """Logins (or team names) with an outstanding review request on this PR.

    Empty means literally nobody has been asked — which is a *stall*, not a
    wait, and the cockpit colors it differently. Exposed as a field on every
    row so no consumer has to parse the `reason` sentence to learn it.
    """
    out = [
        (n["requestedReviewer"] or {}).get("login")
        or (n["requestedReviewer"] or {}).get("name")
        for n in pr["reviewRequests"]["nodes"]
    ]
    return [r for r in out if r]


def approvals(pr, me):
    """Per-author approval timestamps: {login: submittedAt}.

    `latestReviews` is one row per author, so a login appears here only while
    APPROVED is that person's CURRENT position — approve-then-request-changes
    correctly drops out, because the approval is no longer what they think.

    ONE definition, used by every comment surface. It lived inside
    issue_comments() until 2026-08-18, which is exactly why inline threads
    never got the rule: a copy that only one caller can see is a rule that only
    one surface obeys. See answered_by_approval() for what it's for.
    """
    out = {}
    for r in (pr.get("latestReviews") or {}).get("nodes") or []:
        if r.get("state") != "APPROVED":
            continue
        login = (r.get("author") or {}).get("login")
        if login and login != me:
            out[login] = r.get("submittedAt") or ""
    return out


def review_decision(pr, me):
    """GitHub's reviewDecision, filled in when the repo leaves it null.

    `reviewDecision` is only set on repos whose branch protection REQUIRES
    reviews. On a repo without that rule it stays null forever, so an approved, green, mergeable PR
    classified as `waiting — no reviewer assigned` and the cockpit told me to go
    find a reviewer for a PR that already had one sign-off. When GitHub gives no
    decision, someone's CURRENT position being APPROVED (latestReviews, minus
    me) is the decision.
    """
    d = pr.get("reviewDecision")
    if d:
        return d
    return "APPROVED" if approvals(pr, me) else None


def answered_by_approval(comments, me, approved_at):
    """True when every ask in this thread has been cleared by its OWN author's
    approval.

    A reviewer who raises a point, hears the answer, and then clicks Approve has
    said the point is not blocking — the approval IS the resolution, and it is
    the strongest signal any comment surface can carry. The inline-surface case:
    a reviewer questioned a deleted filter, I explained it was intentional, the
    reviewer approved the current head 36 minutes later and never pressed Resolve. The board read `comments — 1 unresolved
    comment thread` and put an approved, green, mergeable PR in the "needs me"
    lane, hiding the one thing that was actually true about it: it was ready to
    merge. Same class of inversion as the Conversation-tab case, one surface over.

    SCOPED PER AUTHOR, AND EVERY ASK MUST BE COVERED. Someone else's approval
    says nothing about whether the first reviewer's question was answered, and a second
    commenter who has not approved keeps the whole thread open. A comment
    written AFTER that author's approval is a new ask and survives this too.

    THE RESOLVE BUTTON STAYS AUTHORITATIVE IN THE OTHER DIRECTION. Unlike the
    Conversation tab and the review body, an inline thread has a Resolve button
    — so "I replied last" is deliberately NOT a clearing rule here. A reply with
    no approval behind it leaves the thread open, because the reviewer may still
    come back. Only the approval clears it.
    """
    for c in comments:
        login = (c.get("author") or {}).get("login")
        if not login or login == me:
            continue
        ok = approved_at.get(login)
        if not ok or (c.get("createdAt") or "") > ok:
            return False
    return True


def open_threads(pr, me):
    """The review threads that are actually waiting on me, with their content.

    ONE definition, used by classify() and by the row. It was duplicated as two
    identical list comprehensions until the app needed the threads themselves
    rather than a count — and two copies of "which threads count" is exactly the
    drift that makes a badge disagree with the list under it.

    A thread I opened on my own PR is a note to the reviewer, not a question
    waiting on me. `isOutdated` threads are dropped: the line they anchored to is
    gone, so there is nothing to address at that location any more.

    THE BODY IS CARRIED, NOT JUST THE COUNT. "3 unresolved comment threads" tells
    you a PR needs work; it cannot tell you whether that work is a typo fix or a
    rearchitecture, and it certainly cannot be handed to an agent. The whole
    conversation is kept (up to 10 comments per thread) because a reply that
    narrows the ask — "actually just rename it" — is usually the last comment,
    not the first.

    THREE SOURCES, NOT ONE — see issue_comments() and review_bodies() below.
    GitHub splits PR comments across three unrelated objects and this reads all
    three. Each omission cost a real review: missing the Conversation tab lost
    one, missing the review submission body lost another.
    """
    out = []
    approved_at = approvals(pr, me)
    for t in pr["reviewThreads"]["nodes"]:
        if t["isResolved"] or t["isOutdated"]:
            continue
        comments = t["comments"]["nodes"] or []
        if not comments:
            continue
        first = comments[0]
        author = (first.get("author") or {}).get("login")
        if not author or author == me:
            continue
        # Everyone who asked something here has approved since. Nothing is
        # waiting, even though nobody pressed Resolve.
        if answered_by_approval(comments, me, approved_at):
            continue
        out.append({
            "id": t["id"],
            "kind": "review",
            "path": t.get("path"),
            "line": t.get("line") or t.get("originalLine"),
            "author": author,
            "url": first.get("url"),
            "created_at": first.get("createdAt"),
            "comments": [
                {
                    "author": (c.get("author") or {}).get("login"),
                    # Trimmed: the artifact is re-read on every app render and a
                    # long design debate in a thread would bloat every load. The
                    # resolver re-fetches full bodies from GitHub before it works.
                    "body": (c.get("bodyText") or "").strip()[:1200],
                }
                for c in comments
            ],
        })
    out.extend(issue_comments(pr, me))
    out.extend(review_bodies(pr, me))
    # Oldest first across both sources, so the list reads chronologically rather
    # than review-threads-then-conversation.
    out.sort(key=lambda t: t.get("created_at") or "")
    return out


def review_bodies(pr, me):
    """The REVIEW SUBMISSION body — the fourth surface, and the one this rail
    was blind to until 2026-08-18.

    When a reviewer clicks "Review changes" and types into the summary box, that
    prose is attached to the *review*, not to a thread and not to the
    Conversation tab. Nothing in `reviewThreads` or `comments` contains it. A
    reviewer who writes their entire review there — numbered findings, blocking
    or not — produces, from this script's old point of view, a PR with zero
    comments.

    The case that proved it: a reviewer submitted an 8,000-character
    COMMENTED review with a 🔴 blocking finding and two 🟡 ones, zero inline
    threads, zero Conversation-tab comments, and no re-request outstanding. The
    board read `no reviewer` — "nobody has been asked, this is not moving" —
    on a PR whose reviewer had just handed back the most detailed feedback of
    the week. The worst possible failure for this app: not a wrong label, an
    inverted one.

    WHY `reviewDecision` DOESN'T CATCH IT. A COMMENTED review leaves
    `reviewDecision` null — GitHub only sets it for APPROVED and
    CHANGES_REQUESTED. So the strongest "someone is engaged with this" signal on
    the PR is invisible to every scalar the API offers.

    RULES, same conservatism as issue_comments():
      * only CHANGES_REQUESTED and COMMENTED carry an ask. An APPROVED body is
        praise or a nit the approver already declared non-blocking — and
        surfacing it would flip ready-to-merge PRs into "needs me", the exact
        regression the approval rule in issue_comments() exists to prevent;
      * an empty body is the plain Approve/Comment click, not a comment;
      * a comment of mine posted after it counts as answered, same as the
        Conversation tab, since a review body has no Resolve button either;
      * `latestReviews` is one row per author, so a later review from the same
        person supersedes rather than stacks.
    """
    mine = [c.get("createdAt") or "" for c in (pr.get("comments") or {}).get("nodes") or []
            if (c.get("author") or {}).get("login") == me]
    last_mine = max(mine) if mine else ""
    out = []
    for r in (pr.get("latestReviews") or {}).get("nodes") or []:
        if r.get("state") not in ("CHANGES_REQUESTED", "COMMENTED"):
            continue
        login = (r.get("author") or {}).get("login")
        if not login or login == me:
            continue
        body = (r.get("bodyText") or "").strip()
        if not body:
            continue
        created = r.get("submittedAt") or ""
        if last_mine and created <= last_mine:
            continue
        out.append({
            "id": r.get("url") or f"review:{login}:{created}",
            "kind": "review_body",
            "path": None,
            "line": None,
            "author": login,
            "url": r.get("url") or pr["url"],
            "created_at": created,
            "comments": [{"author": login, "body": body[:1200]}],
        })
    return out


# Accounts whose PR comments are automation, not a person asking for something.
# CI summaries, coverage bots and dependency bots all post to the Conversation
# tab, which is exactly the surface issue_comments() reads — without this the
# state would flip to `comments` on every PR that has a bot.
#
# GraphQL's `__typename` catches an App-authored comment (`Bot`), which is most
# of them. The suffix rule catches the rest: a bot running under a normal user
# account, which `__typename` reports as `User`.
BOT_SUFFIXES = ("[bot]", "-bot", "_bot")


def is_bot(author):
    """True when a comment author is automation rather than a colleague."""
    if not author:
        return True
    if (author.get("__typename") or "") == "Bot":
        return True
    login = (author.get("login") or "").lower()
    return login.endswith(BOT_SUFFIXES)


def issue_comments(pr, me):
    """Conversation-tab comments — the THIRD comment surface, and the one this
    rail was blind to until 2026-08-13.

    GitHub splits PR comments across three unrelated objects:

      * `reviewThreads`  — inline, anchored to file:line, resolvable. Read above.
      * `latestReviews`  — the Approve / Request-changes / Comment submission.
      * `comments`       — the Conversation tab. Plain prose, no anchor, and
                           **no Resolve button anywhere in the GitHub UI**.

    A reviewer picks the third whenever the point does not belong on one line:
    a finding that spans files, an architectural objection, a "this is inherited
    from the previous PR but becomes visible here". Those are the *most*
    substantial comments, not the least — so treating "no review threads" as "no
    comments" was backwards. The case that proved it: a reviewer posted a
    cross-file correctness bug that made the feature fail silently, the PR read
    `waiting — waiting on jane-doe, sam-lee` with green CI, and nothing on the card
    hinted a comment existed.

    THERE IS NO RESOLVED FLAG, so unresolvedness cannot be read off the comment.
    Three rules stand in, and all are deliberately conservative:

      * a comment I posted after theirs counts as answered — I replied in the
        conversation, which is the only "resolve" this surface has;
      * an APPROVAL by the comment's own author, submitted at or after the
        comment, counts as answered — see below;
      * bots are dropped entirely (see is_bot).

    THE APPROVAL RULE. A reviewer who reads the PR, writes down two observations,
    and then clicks Approve has already told you those observations are not
    blocking — the approval IS the resolution, and it's the strongest signal this
    surface can carry. Without this rule one PR read `comments — 1 unresolved
    comment thread` and sat in the "needs me" lane while its only reviewer had
    approved it two minutes after writing the comment: the board said blocked, the
    PR was ready to merge.

    Scoped per author on purpose. Someone else's approval says nothing about
    whether another reviewer's question was answered, so only the commenter's own approval
    clears their own comment. And it's the LATEST review per author that counts
    (`latestReviews`), so approve-then-request-changes correctly stops clearing
    anything — the approval is no longer that person's position.

    Each surviving comment becomes its own one-comment thread with `path: None`,
    which the app already renders as "on the PR" and the prompt as
    "(no file — a general PR comment)". Neither needed changing: the
    unanchored case was already in both, it just never occurred.
    """
    nodes = (pr.get("comments") or {}).get("nodes") or []
    # Anything of mine is a reply, so everything before it has been answered by
    # definition. Only comments after my last word are still waiting.
    mine = [c.get("createdAt") or "" for c in nodes
            if (c.get("author") or {}).get("login") == me]
    last_mine = max(mine) if mine else ""
    # Per-author approval timestamps. See approvals() — shared with the inline
    # thread surface, which used to miss this rule because the loop lived here.
    approved_at = approvals(pr, me)
    out = []
    for c in nodes:
        author = c.get("author") or {}
        login = author.get("login")
        if login == me or is_bot(author):
            continue
        created = c.get("createdAt") or ""
        if last_mine and created <= last_mine:
            continue
        # They wrote it, then approved. Their own approval answers their own
        # comment; a later comment from them is a new ask and survives this.
        ok = approved_at.get(login)
        if ok and created <= ok:
            continue
        body = (c.get("bodyText") or "").strip()
        if not body:
            continue
        out.append({
            "id": c.get("url"),
            "kind": "issue",
            "path": None,
            "line": None,
            "author": login,
            "url": c.get("url"),
            "created_at": created,
            "comments": [{"author": login, "body": body[:1200]}],
        })
    return out


def classify(pr, me):
    """Return (state, reason). State is what the morning needs to know.

    Order matters — these are checked most-blocking-first, and the FIRST match
    wins. A PR can be both conflicted and approved; the conflict is what stops
    it landing, so that's what it reports.
    """
    if pr["isDraft"]:
        return "draft", "still being written"

    if pr["mergeable"] == "CONFLICTING":
        return "conflict", "conflicts with base — needs a rebase"

    unresolved = open_threads(pr, me)
    if unresolved:
        n = len(unresolved)
        return "comments", f"{n} unresolved comment thread{'s' if n > 1 else ''}"

    # Checked BEFORE `changes`: a CHANGES_REQUESTED review left on an older
    # commit means the ask was already answered by a later push. The action is
    # "re-request", not "address" — telling me to address it again is wrong.
    stale = stale_reviewers(pr, me)
    if stale:
        who = ", ".join(s["login"] for s in stale[:3])
        return "rerequest", (
            f"pushed since {who} reviewed — nobody is looking at this code"
        )

    if pr["reviewDecision"] == "CHANGES_REQUESTED" and not answered_changes(pr, me):
        return "changes", "changes requested"

    ci = ((pr["commits"]["nodes"] or [{}])[0].get("commit", {})
          .get("statusCheckRollup") or {}).get("state")
    if ci in ("FAILURE", "ERROR"):
        return "ci", "CI is red"

    if review_decision(pr, me) == "APPROVED":
        if ci == "PENDING":
            return "approved", "approved — CI still running"
        return "mergeable", "approved and green — ready to merge"

    # Nothing is blocked on me; I'm waiting on other people.
    reviewers = requested_reviewers(pr)
    if reviewers:
        return "waiting", f"waiting on {', '.join(reviewers[:3])}"
    return "waiting", "no reviewer assigned"


# Which states mean *I* have to do something, versus waiting on someone else.
# The cockpit sorts on this, so it lives here with the classifier that produces it.
ON_ME = {"conflict", "comments", "rerequest", "changes", "ci", "mergeable"}


def collect(ident):
    nodes = gh_graphql(ident, f"is:open is:pr author:@me archived:false {owner_scope(ident['owners'])}")
    if nodes is None:
        return None
    me = ident["login"]
    out = []
    for pr in nodes:
        state, reason = classify(pr, me)
        commit = (pr["commits"]["nodes"] or [{}])[0].get("commit", {})
        threads = open_threads(pr, me)
        out.append({
            "identity": ident["name"],
            "repo": pr["repository"]["nameWithOwner"],
            "number": pr["number"],
            "title": pr["title"],
            "url": pr["url"],
            "sha7": (pr["headRefOid"] or "")[:7],
            # Branch names, so a consumer can act on the PR without a second
            # GitHub round trip. The conflict resolver checks out `head_ref` and
            # rebases it onto `base_ref`; `cross_repo` tells it the head lives in
            # a fork it has no push rights to, which is a refuse-not-guess case.
            "head_ref": pr["headRefName"],
            "base_ref": pr["baseRefName"],
            "head_repo": (pr["headRepository"] or {}).get("nameWithOwner"),
            "cross_repo": pr["isCrossRepository"],
            "state": state,
            "reason": reason,
            # Who is actually on the hook. [] = nobody asked.
            "waiting_on": requested_reviewers(pr),
            "on_me": state in ON_ME,
            "draft": pr["isDraft"],
            "mergeable": pr["mergeable"],
            "review_decision": review_decision(pr, me),
            "ci": (commit.get("statusCheckRollup") or {}).get("state"),
            "unresolved_threads": len(threads),
            # The threads THEMSELVES, not just how many. Carried on every row
            # regardless of which state won classify(): a conflicted PR can also
            # have questions waiting, and after the rebase nothing would
            # re-surface them. The app renders them and the resolver reads them.
            "threads": threads,
            "approvals": [
                r["author"]["login"] for r in pr["latestReviews"]["nodes"]
                if r["state"] == "APPROVED"
            ],
            # Who reviewed an older commit and was never re-asked. Carried even
            # when another state won the classify() race, so the cockpit can
            # show "also needs a re-request" on a conflicted PR.
            "stale_reviewers": stale_reviewers(pr, me),
            "updated_at": pr["updatedAt"],
            "created_at": pr["createdAt"],
            "pushed_at": commit.get("committedDate"),
        })
    return out


def _sniff(b):
    """The real image type, from magic bytes.

    `github.com/<login>.png` serves JPEG. Trusting the URL would write JPEG
    bytes into a `.png`, which browsers forgive and nothing else does.
    """
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if b[:3] == b"\xff\xd8\xff":
        return "jpg"
    if b[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp"
    return None


def cache_avatars(logins):
    """Download each face once so the app can render it same-origin.

    WHY CACHE RATHER THAN LINK. An <img> pointed at githubusercontent is an
    external request per row from inside the app iframe — subject to whatever
    CSP the shell sets, dead when the network is, and a third party learning
    when I read my board. A file in the workspace is none of those.

    `github.com/<login>.png` is unauthenticated and 302s to the avatar CDN, so
    this needs no token and works for users in private orgs.

    BEST-EFFORT BY DESIGN. Every failure path leaves the login out of the index
    and the app falls back to the name in text, so a broken avatar can never
    break a sweep. That is why the whole body is wrapped rather than allowed to
    raise: this is decoration hanging off a job that reports PR status.
    """
    index = {}
    for login in sorted({str(x).strip() for x in logins if x}):
        key = login.lower()
        try:
            req = urllib.request.Request(
                f"https://github.com/{login}.png?size=80",
                headers={"User-Agent": "lucidos-pulls"},
            )
            with urllib.request.urlopen(req, timeout=20) as r:
                data = r.read(1_000_000)
            ext = _sniff(data)
            if not ext:
                print(f"avatar {login}: not an image, skipped", file=sys.stderr)
                continue
            tmp = f"/tmp/avatar-{key}.{ext}"
            with open(tmp, "wb") as f:
                f.write(data)
            w = subprocess.run(
                ["lucidos", "data", "write", f"{AVATAR_DIR}/{key}.{ext}", "--from", tmp],
                capture_output=True, text=True, timeout=60,
            )
            if w.returncode != 0:
                print(f"avatar {login}: write failed", file=sys.stderr)
                continue
            index[key] = f"{AVATAR_DIR}/{key}.{ext}"
        except Exception as e:
            print(f"avatar {login}: {type(e).__name__}", file=sys.stderr)

    if not index:
        return 0
    tmp = "/tmp/avatars-index.json"
    with open(tmp, "w") as f:
        json.dump({
            "schema": "review-cockpit/avatars/v1",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "note": ("login (lowercased) -> workspace path. Extension is sniffed "
                     "from magic bytes: the .png URL serves JPEG."),
            "avatars": index,
        }, f, indent=2)
    subprocess.run(["lucidos", "data", "write", AVATAR_INDEX, "--from", tmp],
                   capture_output=True, text=True, timeout=60)
    return len(index)


def main():
    if not IDENTITIES:
        # No usable config is not "no open PRs": write nothing, say why.
        print("no Pulls config to sweep; nothing written", file=sys.stderr)
        return 1
    prs, failed = [], []
    ships, ships_failed = [], []
    for ident in IDENTITIES:
        got = collect(ident)
        if got is None:
            # A failed identity is NOT zero PRs. Recording it lets the cockpit
            # say "<identity> is unreachable" instead of silently showing an empty
            # section that looks identical to "you have no work PRs".
            failed.append(ident["name"])
            continue
        prs.extend(got)

        # Shipped-by-me, same trip — but only for an identity with a group that
        # turns the lane on. A skipped identity is silent: it is not a failure,
        # and putting it in ships_failed would raise an outage panel for a lane
        # that was never meant to cover that group.
        if not ident["shipped_owners"]:
            continue
        sh = shipped(ident, SHIPPED_WINDOW_DAYS)
        if sh is None:
            ships_failed.append(ident["name"])
        else:
            ships.extend(sh)
    ships.sort(key=lambda p: p["merged_at"] or "", reverse=True)

    # Most-blocking first, then oldest — a conflict from last week outranks one
    # from this morning, because it has had longer to rot.
    order = {"conflict": 0, "comments": 1, "rerequest": 2, "changes": 3,
             "ci": 4, "mergeable": 5, "approved": 6, "waiting": 7, "draft": 8}
    prs.sort(key=lambda p: (order.get(p["state"], 9), p["created_at"]))

    doc = {
        "schema": "review-cockpit/my-prs/v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "identities_failed": failed,
        "counts": {
            "total": len(prs),
            "on_me": sum(1 for p in prs if p["on_me"]),
            "conflict": sum(1 for p in prs if p["state"] == "conflict"),
            "rerequest": sum(1 for p in prs if p["stale_reviewers"]),
            "comments": sum(1 for p in prs if p["unresolved_threads"]),
            "mergeable": sum(1 for p in prs if p["state"] == "mergeable"),
        },
        "prs": prs,
    }

    tmp = "/tmp/my-prs.json"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=2)
    r = subprocess.run(["lucidos", "data", "write", OUT, "--from", tmp],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        print(f"write failed: {r.stderr[:300]}", file=sys.stderr)
        return 1

    # SEPARATE ARTIFACT, not a key inside my-prs.json. That file is a snapshot of
    # what is OPEN and is overwritten wholesale every sweep; this is a window
    # over what is MERGED. Folding them together would mean a failed shipped
    # query either blanks the board or forces the open-PR write to wait on it.
    # Written after, and its failure is reported without failing the sweep.
    ship_doc = {
        "schema": "review-cockpit/shipped/v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_days": SHIPPED_WINDOW_DAYS,
        "identities_failed": ships_failed,
        "counts": {
            "total": len(ships),
            "unreviewed": sum(1 for p in ships if not p["reviewed_by"]),
            "additions": sum(p["additions"] for p in ships),
            "deletions": sum(p["deletions"] for p in ships),
        },
        "shipped": ships,
    }
    tmp_s = "/tmp/shipped.json"
    with open(tmp_s, "w") as f:
        json.dump(ship_doc, f, indent=2)
    rs = subprocess.run(["lucidos", "data", "write", SHIPPED_OUT, "--from", tmp_s],
                        capture_output=True, text=True, timeout=60)
    if rs.returncode != 0:
        print(f"shipped write failed: {rs.stderr[:300]}", file=sys.stderr)

    # One event per sweep, not per PR: the artifact is the state, the event is
    # only the "something changed, re-read it" signal the cockpit listens for.
    subprocess.run(
        ["lucidos", "events", "emit", "MyPrStatusSnapshotted", "--payload", json.dumps({
            "summary": f"{len(prs)} open PRs — {doc['counts']['on_me']} need me"
                       + (f", {len(ships)} shipped in {SHIPPED_WINDOW_DAYS}d" if ships else "")
                       + (f" ({', '.join(failed)} unreachable)" if failed else ""),
            **doc["counts"], "identities_failed": failed,
            "shipped": len(ships), "shipped_failed": ships_failed,
        })],
        capture_output=True, text=True, timeout=60,
    )

    # Faces for the board, AFTER the artifact is safely written and announced.
    # Decoration must never sit between the sweep and its result: if this hangs
    # or throws, the PR status is already on disk and the event already fired.
    faces = set()
    for p in prs:
        faces.update(p.get("waiting_on") or [])
        faces.update(p.get("approvals") or [])
    # The other two rails' authors, so a review row and a brief row get a face
    # too. Read from the artifacts rather than re-queried — this is a cache
    # refresh, not a source of truth.
    #
    # Path comes from `lucidos data path`, not from splicing $LUCIDOS_WORKSPACE
    # + "/data/" by hand: the CLI owns where data/ lives. Only FileNotFoundError
    # is swallowed, because "that rail has not swept yet" is the one expected
    # miss. A malformed JSON or a permission error used to vanish into a bare
    # `except` and read as the same thing, so a path change looked exactly like
    # an empty queue and went unnoticed.
    for path, pick in (("review-queue.json", lambda d: [x.get("author") for x in d.get("prs", [])]),
                       ("briefs.json", lambda d: [x.get("author") for x in d.get("briefs", [])])):
        rel = f"artifacts/review-cockpit/{path}"
        try:
            abs_path = subprocess.run(
                ["lucidos", "data", "path", rel],
                capture_output=True, text=True, check=True,
            ).stdout.strip()
            with open(abs_path) as f:
                faces.update(x for x in pick(json.load(f)) if x)
        except FileNotFoundError:
            pass   # rail not swept yet; its authors get a face next time
        except Exception as e:   # noqa: BLE001 — avatars are decoration, but say why
            print(f"avatars: could not read {rel}: {e}", file=sys.stderr)
    n = cache_avatars(faces)

    print(f"{len(prs)} PRs, {doc['counts']['on_me']} on me"
          + (f", {len(ships)} shipped/{SHIPPED_WINDOW_DAYS}d" if ships else "")
          + (f" (shipped failed: {ships_failed})" if ships_failed else "")
          + (f", {n} avatars" if n else "")
          + (f", failed: {failed}" if failed else ""))

    # Auto-start the conflict resolver on my own conflicted PRs, on repos that opt in.
    # Same request the Rebase button emits; see auto_conflicts.py for the gate.
    try:
        subprocess.run([sys.executable,
                        os.path.join(os.path.dirname(os.path.abspath(__file__)), "auto_conflicts.py")],
                       timeout=120)
    except Exception as e:  # noqa: BLE001
        print(f"auto_conflicts failed to run: {e}", file=sys.stderr)

    # Queue the lanes-driven pr-* pass for my own PRs off the snapshot just written.
    # Separate process so a failure there can never fail this sweep.
    try:
        subprocess.run([sys.executable,
                        os.path.join(os.path.dirname(os.path.abspath(__file__)), "own_prep.py")],
                       timeout=240)
    except Exception as e:  # noqa: BLE001
        print(f"own_prep failed to run: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
