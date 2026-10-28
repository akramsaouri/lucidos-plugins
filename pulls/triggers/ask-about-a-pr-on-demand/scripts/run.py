#!/usr/bin/env python3
# lucidos-credentials: CRED_GITHUB
"""Spawn a Claude Code session to answer a question asked from the Pulls app.

WHY THIS EXISTS
---------------
The three Ask buttons — inside a finding, beside a map section, and "Ask about
this PR" — used to call `lucidos.ui.startThread()`, which prefills a *chat*
compose box. That put a Lucidos Agent on the question: an agent with no repo,
no worktree, and no git. Every question about a PR is a question about code, so
the first thing that thread had to do was find the clone and read files through
generic tooling — and it could not run anything at all.

A coding agent starts where those questions already live: in a fresh worktree of
the registered repo, with git, the toolchain, and the head's blobs local. So the
Ask button now spawns one.

An iframe cannot spawn a process, so the click emits `ReviewQuestionAsked` and
this script — running natively — starts the session. Same emit -> SSE ->
scheduler -> exec round trip as the conflict resolver and the Open PR trigger,
for the same reason.

THE PROMPT IS COMPOSED BY THE APP, NOT HERE
-------------------------------------------
Unlike the two writing rails, this script does not build the prompt. It can't:
the anchor is the *content* the user pointed at — one finding with its evidence
and the user's own triage, or one map section verbatim — and that lives in artifacts
the app has already loaded and parsed. Re-deriving it here would mean a second
parser for the findings schema and the map render, kept in step by hope.

So the app ships the composed prompt and this script owns the two things the app
cannot know: which registered repo the session runs in, and which `gh` identity
can see the org. Both come from the Pulls config, through the conflict
resolver's REPOS, not from the payload — an app-supplied repo name is a request, not an authority.

READ-ONLY IS INSTRUCTION, NOT ENFORCEMENT
-----------------------------------------
The session is spawned `--relation top`, so it is NOT in this trigger's privilege
tree: it stays interactive, and anything reaching outside its worktree raises a
permission card the user answers. That is deliberate. A question must never turn into
a review, and the prompt says so in words — but the card is the backstop.
"""
import importlib.util
import json
import os
import re
import subprocess
import sys

# ---------------------------------------------------------------------------
# The repo table is IMPORTED, not copied. `REPOS` maps a repo full name to its
# registered clone name and `gh` identity (read from the Pulls config), and
# `engine_spawn_flags()` resolves the live engine's port and scheme. A second
# copy of either is the drift that makes one rail refuse what another offers.
#
# Loaded by path with an explicit module name because several trigger scripts are
# called `run.py` — a plain `import run` would be ambiguous about which it got.
# ---------------------------------------------------------------------------
_CONFLICTS = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "..", "resolve-pr-conflicts", "scripts", "run.py"))

SHA_OK = re.compile(r"^[0-9a-f]{7,40}$")
NAME_OK = re.compile(r"^[\w.\-]+$")
ANCHORS = ("finding", "section", "pr")


def die(msg):
    print(f"ask-about-pr: {msg}", file=sys.stderr)
    sys.exit(1)


def load_conflicts():
    spec = importlib.util.spec_from_file_location("pr_conflict_resolver", _CONFLICTS)
    if not spec or not spec.loader:
        return None
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception:  # noqa: BLE001 - any failure here is the same failure
        return None
    return mod


def title_for(repo_full, pr, anchor, ref, question):
    """A thread title that says which PR and what about it.

    The question's own first words beat any label: the thread list is where the
    user finds this again, and "Ask: storefront#715" three times over is a list
    nobody can read. Truncated on a word boundary — a hard slice mid-word reads as
    corruption rather than as brevity.
    """
    where = f"{repo_full.split('/')[-1]}#{pr}"
    if anchor == "section" and ref:
        where += f" · {ref}"
    q = " ".join((question or "").split())
    if len(q) > 60:
        q = q[:60].rsplit(" ", 1)[0] + "…"
    return f"Ask {where}: {q}" if q else f"Ask {where}"


def main():
    prepare = "--prepare" in sys.argv
    payload = json.loads(os.environ.get("TRIGGER_EVENT_PAYLOAD", "{}"))

    conflicts = load_conflicts()
    if not conflicts:
        die(f"could not load the shared repo table from {_CONFLICTS}")

    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        die("no prompt in the payload — the app composes it, so this is a bug "
            "in the Ask button, not a stale click")

    repo_full = (payload.get("repo") or "").strip()
    if "/" not in repo_full:
        die(f"bad repo {repo_full!r} — expected owner/name")
    try:
        pr = int(payload.get("number"))
    except (TypeError, ValueError):
        die(f"bad pr number: {payload.get('number')!r}")

    sha7 = (payload.get("sha7") or "").strip()
    if not SHA_OK.match(sha7):
        die(f"{sha7!r} is not a sha")

    anchor = (payload.get("anchor") or "pr").strip()
    if anchor not in ANCHORS:
        die(f"unknown anchor {anchor!r} — expected one of {', '.join(ANCHORS)}")

    # The registered repo: the shared table first, the payload only as a
    # fallback for a repo the writing rails have no entry for (findings can
    # exist for a repo nobody has ever asked an agent to push to). Either way it
    # is name-checked before it reaches a command line.
    cfg = conflicts.REPOS.get(repo_full)
    repo_name = (cfg or {}).get("repo") or (payload.get("folder") or "").strip()
    if not repo_name or not NAME_OK.match(repo_name):
        die(f"no registered repo for {repo_full!r} — register the clone in "
            f"Settings → Coding Agents, and list it in artifacts/review-cockpit/config.json")

    title = title_for(repo_full, pr, anchor, payload.get("ref"),
                      payload.get("question"))

    # The app is waiting on this to swap its spinner for the thread. `client_ref`
    # is echoed back untouched: it is how the tab that asked recognises its OWN
    # question and opens it, while every other open tab (and every other device)
    # stays where it is.
    started_payload = {
        "summary": f"Coding agent started on a {anchor} question about "
                   f"{repo_full}#{pr}",
        "repo": repo_full, "number": pr, "sha7": sha7,
        "pr": payload.get("pr"), "anchor": anchor,
        "ref": payload.get("ref") or "",
        "cc_repo": repo_name,
        "client_ref": payload.get("client_ref") or "",
    }

    # --prepare: build everything, spawn nothing. See knowhow/pr-button-rails.md.
    if prepare:
        print(json.dumps({
            "action": "spawn",
            "repo": repo_name,
            "title": title,
            "prompt": prompt,
            "started_payload": started_payload,
            "started_event": "ReviewQuestionThreadStarted",
        }))
        return 0

    r = subprocess.run(
        ["lucidos", "spawn-thread",
         *conflicts.engine_spawn_flags(),
         "--cc",
         "--repo", repo_name,
         "--relation", "top",
         "--title", title,
         "--message", prompt],
        capture_output=True, text=True, timeout=120,
    )
    if r.returncode != 0:
        die(f"spawn failed: {r.stderr[:500]}")

    link = r.stdout.strip()
    m = re.search(r"thread:[^/]+/([0-9a-f-]{36})", link)
    thread_id = m.group(1) if m else None

    subprocess.run(
        ["lucidos", "events", "emit", "ReviewQuestionThreadStarted", "--payload",
         json.dumps({**started_payload, "thread_id": thread_id})],
        capture_output=True, text=True, timeout=60,
    )
    print(f"spawned {link} for a {anchor} question about {repo_full}#{pr} @ {sha7}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
