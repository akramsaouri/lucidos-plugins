#!/usr/bin/env python3
# lucidos-credentials: CRED_GITHUB
"""Run the my-PRs status sweep on demand, from a button in the Pulls app.

WHY THIS EXISTS. An iframe can't run `gh`. The Pulls app emits
`PrStatusRefreshRequested` and this trigger runs the sweep natively — the same
mechanism the Open PR trigger uses, for the same reason.

WHY IT SHELLS OUT INSTEAD OF REIMPLEMENTING. The scheduled sweeps run these
same scripts. If this did its own GitHub queries, the manual and scheduled paths
would be two implementations of the same question that drift apart — the classic
bug where the button gives a different answer than the schedule. One script per
question, two callers each.

Each sweep emits its own completion event (`MyPrStatusSnapshotted`,
`ReviewQueueSnapshotted`), which is what the app listens for to clear its spinner.
So this script emits nothing itself on success: a third completion event would
double-fire the UI.

SCOPE. Status only. This does NOT touch the review-prep rail or the map rail —
those are ~40-minute multi-agent jobs keyed on the head SHA, and they re-fire on
their own when a PR actually moves.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# The sweep scripts live with the rail that owns the GitHub identities, not here.
RAIL = os.path.join(HERE, "..", "..", "review-prep-work-prs", "scripts")

# BOTH live readings, because the button says "Refresh status" and the user means
# the whole board. mine.py answers "what's blocking my PRs"; queue.py answers
# "who is waiting on me". Refreshing only the first would leave a merged PR or a
# revoked review request sitting in the review lane after an explicit refresh —
# the exact staleness the button exists to clear.
SWEEPS = ["mine.py", "queue.py"]


def main():
    rc = 0
    for name in SWEEPS:
        path = os.path.normpath(os.path.join(RAIL, name))
        if not os.path.exists(path):
            print(f"sweep script missing: {path}", file=sys.stderr)
            rc = rc or 1
            continue

        r = subprocess.run([sys.executable, path], capture_output=True, text=True,
                           timeout=300)
        if r.stdout:
            print(f"[{name}] {r.stdout.strip()}")
        if r.returncode != 0:
            # Fail loudly, but run the other sweep anyway: a broken queue sweep
            # should not also cost the user their PR status. The app has its own
            # 2-minute timeout, so the button un-sticks either way — but a silent
            # success would leave them believing a sweep happened when none did.
            print(f"[{name}] {r.stderr.strip()[:800]}", file=sys.stderr)
            rc = rc or r.returncode
    return rc


if __name__ == "__main__":
    sys.exit(main())
