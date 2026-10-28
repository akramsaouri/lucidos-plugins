#!/usr/bin/env python3
"""Open a PR URL in the browser the Pulls config names, on behalf of an app that can't.

WHY THIS EXISTS
---------------
A link clicked inside an app iframe opens in whatever browser is already showing
Lucidos. That is the wrong answer often enough to be worth fixing: a PR in a
private or SAML-gated org that only one of your logins can see, opened in a
browser signed in as the other, renders a 404 that looks like a deleted PR rather
than a permission error.

A web page cannot reach LaunchServices, and the SDK's `openExternal` routes
through the Lucidos webview rather than the OS. So the app emits
`PrOpenRequested` and this script, running natively on the same Mac, performs
the launch. Round trip is emit -> SSE -> scheduler -> exec, which is why the app
shows an "Opening…" toast rather than pretending the click was instant.

WHICH BROWSER
-------------
`browser` in artifacts/review-cockpit/config.json (knowhow/pulls-config.md):

    neither set        `open <url>`: the Mac's default https handler. Best when a
                       link router (one that picks the browser and profile by URL
                       pattern for every link on the machine) already owns https.
    app only           `open -a <app> <url>`
    app and profile    `open -na <app> --args --profile-directory=<profile> <url>`
                       (Chromium browsers). `open -na` returns 0 even when the
                       window it raises is wrong, so a bad profile name fails
                       silently: check it once by hand at setup.

A `profile` key in an incoming payload is IGNORED rather than trusted: the
browser is the config's decision, not the app's.

PAYLOAD CONTRACT
----------------
    url  required. Must be https://github.com/... — this script hands a string
         to `open(1)`, so the scheme is allowlisted rather than trusted.
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.join(os.environ.get("LUCIDOS_WORKSPACE", ""), "data", "scripts", "pulls"))
import pulls_config  # noqa: E402

URL_OK = re.compile(r"^https://github\.com/[\w.\-/#?=&%]+$")


def die(msg):
    print(f"open-pr: {msg}", file=sys.stderr)
    sys.exit(1)


def browser():
    """(app, profile) from the config. A missing config means the default browser."""
    try:
        b = pulls_config.browser()
    except pulls_config.ConfigError:
        return None, None
    return b["app"], b["profile"]


def command(url, app, profile):
    if app and profile:
        return ["open", "-na", app, "--args", f"--profile-directory={profile}", url]
    if app:
        return ["open", "-a", app, url]
    # No -a and no -n: plain `open <url>` is the one form that consults the
    # default handler.
    return ["open", url]


def main():
    payload = json.loads(os.environ.get("TRIGGER_EVENT_PAYLOAD", "{}"))
    url = (payload.get("url") or "").strip()

    if not URL_OK.match(url):
        die(f"refusing to open {url!r} — only https://github.com/... is allowed")

    app, profile = browser()
    subprocess.run(command(url, app, profile), check=True)
    via = f"{app}" + (f" ({profile})" if profile else "") if app else "the default https handler"
    print(f"opened {url} via {via}")


if __name__ == "__main__":
    main()
