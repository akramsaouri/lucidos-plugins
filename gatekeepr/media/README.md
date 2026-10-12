# Gatekeepr

Appgate SDP doesn't tell you when your VPN session ends. You get a 5-minute warning, then everything behind the
VPN stops. Gatekeepr shows you the expiry ahead of time and nudges you before it happens.

## What you get

- **VPN expiry widget**: a countdown timer whose hand sweeps back to 12 as the session runs out, with the time left
  and the local expiry time under it. It turns yellow when the session is about to expire and red once it has.
  Pin it to Home or show it in any thread.
- **Gatekeepr app**: the same timer plus the session's details (when you signed in, when it expires, whether it
  started with a sign-in or a renewal, how the session length was learned) and every past session in the logs,
  with its outcome and reconnects.
- **Expiry alerts**: notifications at 30 minutes left, 5 minutes left and on expiry, each sent once per session
  and re-armed when you sign in again or renew. Switch each one off, or change the two thresholds, in the app.
- **Ask in any thread**: "when does my VPN expire?" gets a straight answer from the CLI.

## What it needs

- macOS, with the Appgate SDP client.
- The [gatekeepr](https://github.com/akramsaouri/gatekeepr) CLI, v0.3.0 or later. It reads the Appgate driver
  logs in `/var/log/appgate`, needs no root and makes no network calls. Setup checks for it and walks you
  through installing it if it's missing: a release download verified against its checksum, or `go install`.
- Lucidos 0.48.0 or later.

gatekeepr is unofficial and not affiliated with Appgate. It works from observed log behaviour, so a future
Appgate release can break it. When that happens it says so rather than guessing, and Gatekeepr tells you the
check can't read your session.

## How it works

Setup creates one script trigger, the background check, that runs every 5 minutes. Each run calls the CLI (a few
milliseconds), no LLM involved, and sends an alert only when a threshold is newly crossed. An alert can land up to
one interval after its threshold: at 5 minutes, the 30-minute alert arrives with 25 to 30 minutes left. Switch the
check off, or run it every 1 to 30 minutes, in the app's Background check section. Nothing runs while your Mac is
asleep. After a wake you get only the most urgent alert that's due.

Uninstalling removes everything the plugin shipped, but not that trigger, since setup created it. Delete
"Gatekeepr — expiry check" from your triggers afterwards.

## Try first

Open the Gatekeepr app and press **Refresh**, or ask Lucidos "when does my VPN expire?".
