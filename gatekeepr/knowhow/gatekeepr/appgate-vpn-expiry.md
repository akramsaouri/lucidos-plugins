---
name: Appgate VPN session expiry (gatekeepr)
description: How to answer "when does my VPN expire?", "how long until Appgate logs me out?", "is my Appgate session still active?" or "when did I sign in to the VPN?" by running the gatekeepr CLI, what its JSON states mean (active, expiringSoon, expired, signedOut, noSession, error), where the binary is found, and how to install it. Load for any question about Appgate, Appgate SDP, the VPN session, VPN expiry or sign-in time, or the gatekeepr command.
---

# Appgate VPN session expiry

Appgate SDP doesn't say when a session ends: it shows a 5-minute warning, then everything behind the VPN stops.
The **gatekeepr** CLI (github.com/akramsaouri/gatekeepr, v0.3.0 or later) works it out from the driver logs in
`/var/log/appgate`, which any user can read. It needs no root, makes no network calls, and runs on macOS only.
It's unofficial, built from observed log behaviour rather than an Appgate API.

## Answering "when does my VPN expire?"

Run the plugin's reader. It finds the binary, checks the output against the JSON contract and prints one line:

```bash
python3 data/scripts/gatekeepr/reader.py --summary
# Appgate VPN active: 3h49m left, expires 23:18 (signed in Sun 11 Oct 23:18).
```

The working directory of `run_bash` / `run_python` is the workspace root. Drop `--summary` for the full JSON
wrapper (below), or add `--history` for past sessions. Answer from what it prints:

- Quote `timeLeft` and the expiry clock time as the CLI gives them. **Never recompute expiry** from
  `sessionStart` plus 24 hours: the session length is learned (`sessionLengthSeconds`, 86399 s on the median so
  far), and once Appgate's own 5-minute countdown starts, `expiresAt` follows it instead (`expirySource:
  "renewalNotification"`).
- Times carry the Mac's UTC offset, so the clock time in `expiresAt` is already local.
- For "how long have I been signed in", use `sessionStart` and `sessionStartKind` (`signIn`, or `renewal` when
  the user renewed from Appgate's warning, which starts a full new session).
- On `error`, say what the message says and suggest the fix (see "When it fails").

The status file `data/artifacts/gatekeepr/status.json` holds the last scheduled check's wrapper, at most about 5
minutes old when the expiry check trigger runs. Prefer a fresh run for a direct question: it takes milliseconds.

## The JSON contract, in short

`gatekeepr --json` prints one object; the contract is `docs/JSON.md` in the gatekeepr repo. **Check
`schemaVersion` first and treat any value other than `1` as an error: never guess.** gatekeepr v0.2.x printed no
`schemaVersion` at all. The reader enforces both.

| `state` | exit | Meaning | Fields |
|---|---|---|---|
| `active` | 0 | Signed in, more than `warnThresholdSeconds` (default 1800) left | all but `sessionEnd` |
| `expiringSoon` | 1 | Signed in, within the warn threshold | all but `sessionEnd` |
| `expired` | 2 | The session ran out. `sessionEnd` appears once the client closes it | all |
| `signedOut` | 2 | Signed out early, or Appgate restarted mid-session. `expiresAt`/`secondsLeft`/`timeLeft` describe when the last session *would* have expired, so check `state` first | all |
| `noSession` | 2 | No session anywhere in the logs | `schemaVersion`, `state`, `exitCode`, `now`, `warnThresholdSeconds`, `sessionLength*` |
| `error` | 3 | Logs unreadable, or in a format gatekeepr doesn't recognise. `error` says why (wording isn't contract) | `schemaVersion`, `state`, `exitCode`, `error` |

Exit 1 and 2 are ordinary states, not failures. Exit 64 means a bad command line (nothing on stdout).

Fields: `now`, `sessionStart`, `sessionStartKind` (`signIn`/`renewal`), `sessionEnd`, `expiresAt`,
`expirySource` (`sessionLength`/`renewalNotification`), `secondsLeft` (negative once expired), `timeLeft`
(`6h08m`, `25m`, `<1m`, `0m` once expired), `sessionLengthSeconds`, `sessionLengthSource` (`median` of
`sessionLengthLearnedFrom` measured sessions, or `default` 24 h when none was measured), `warnThresholdSeconds`.
Missing fields are left out, never `null`.

`gatekeepr history --json` lists every session in the logs, oldest first, under `sessions`: `start`,
`startKind`, `end`, `endKind` (`clientClosed`, `clientRestarted`, `driverRestarted`, `renewed`), `outcome`
(`active`, `expired`, `signedOut`, `renewed`, `interrupted`), `expiresAt`, `expirySource`,
`measuredLengthSeconds` (when Appgate's warning was seen) and `reconnects` (gateway reconnects, which don't
restart a session). It exits 0, or 3 with the error object.

### The reader's wrapper

`reader.py` (and the `status.json` / `history.json` files) wrap the CLI's object:

```json
{"ok": true, "checked_at": "2026-10-12T19:35:02+02:00", "binary": "/Users/me/go/bin/gatekeepr", "exit_code": 0,
 "status": {"schemaVersion": 1, "state": "active", "timeLeft": "3h43m", "expiresAt": "...", "...": "..."}}
```

`ok` is false for an `error` state and for the reader's own failures, which carry `error_kind`:
`not_installed` (with `tried`), `unsupported_schema`, `bad_output` (output that breaks the contract, such as an
exit code that disagrees with the state), `usage` (exit 64), `failed` (a timeout or another exit code), or
`cli` (gatekeepr's own exit-3 error object). In every case `status.state` is set, `"error"` with an `error`
message on failure. History uses the key `history` instead of `status`.

## Where the binary is found

First hit wins:

1. `binary_path` in `data/artifacts/gatekeepr/settings.json` (the Gatekeepr app's "Binary path" field). A path
   that isn't an executable file is skipped, with a note in the wrapper's `notes`.
2. `PATH`.
3. `~/go/bin/gatekeepr`, where `go install` puts it.
4. `/usr/local/bin/gatekeepr`, where the release instructions put it.

Processes Lucidos spawns (triggers, `run_bash`) often don't have `~/go/bin` on `PATH` even when the user's shell
does. That is why the fixed fallbacks exist, and why `which gatekeepr` can say "not found" while the reader
still works. Running the binary by hand, use the full path the wrapper reports as `binary`.

## Installing gatekeepr

macOS 13 or later, Apple silicon or Intel. Two ways; offer the release first.

**From the release (no Go needed).** Verify the checksum before running anything:

```bash
version=0.3.0
base=https://github.com/akramsaouri/gatekeepr/releases/download/v$version
curl -fLO "$base/gatekeepr-$version-macos-universal.tar.gz"
curl -fLO "$base/SHA256SUMS"
shasum -a 256 -c --ignore-missing SHA256SUMS      # must print "...tar.gz: OK"
tar -xzf "gatekeepr-$version-macos-universal.tar.gz"
sudo install "gatekeepr-$version-macos-universal/gatekeepr" /usr/local/bin/
gatekeepr --version
```

Anything but `OK` from `shasum` means a corrupted or tampered download: delete it and don't run it. `sudo`
needs the user's password, so hand them the commands rather than running `sudo` yourself. Without sudo, install
it anywhere and set that path in the app's "Binary path" field. A tarball downloaded in a browser is
quarantined; clear it with `xattr -d com.apple.quarantine <path-to-binary>`. `curl` and `gh` downloads aren't.

**With Go (1.26 or later):**

```bash
go install github.com/akramsaouri/gatekeepr@latest
```

That puts it in `$(go env GOPATH)/bin`, usually `~/go/bin`, which the reader checks anyway. For the user's own
shell, add `export PATH="$PATH:$(go env GOPATH)/bin"` to `~/.zshrc` if `gatekeepr` reports "command not found".

Check it with `python3 data/scripts/gatekeepr/reader.py --summary`; then ask for a check from the app (or emit
`GatekeeprRefreshRequested`) so the widget and app pick it up.

## When it fails

| `error_kind` | What to tell the user |
|---|---|
| `not_installed` | Install it (above), or set its path in the Gatekeepr app. `tried` lists where the reader looked. |
| `unsupported_schema` | The CLI and the plugin read different JSON versions. No `schemaVersion` means gatekeepr is older than v0.3.0: update it. A higher number means the plugin is older: update the Gatekeepr plugin. |
| `usage` | gatekeepr rejected `--json`, which means a version before v0.3.0. Update it. |
| `cli` | gatekeepr couldn't read the logs, or met a line it doesn't recognise (a new Appgate version). The message names the file and line. The gatekeepr README's "Reporting a parse failure" section explains how to send a sanitized excerpt. Never paste raw Appgate logs anywhere: they hold gateway hosts, addresses, device ids and the user's e-mail. |
| `bad_output`, `failed` | Run `<binary> --json` by hand and read its stderr. |

Expiry alerts and the background check are in `gatekeepr/expiry-alerts`.
