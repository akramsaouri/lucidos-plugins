#!/usr/bin/env python3
"""Read the Appgate VPN session through the gatekeepr CLI (github.com/akramsaouri/gatekeepr, v0.3.0 or later).

Runs `gatekeepr --json` (or `gatekeepr history --json`), checks the output against the CLI's JSON contract
(schemaVersion 1, docs/JSON.md in the gatekeepr repo) and wraps it:

  {"ok": true,  "checked_at": "...", "binary": "/Users/me/go/bin/gatekeepr", "exit_code": 1,
   "status": {<the CLI's object, untouched>}}
  {"ok": false, "checked_at": "...", "binary": null, "error_kind": "not_installed", "tried": [...],
   "status": {"state": "error", "error": "..."}}

`status` always has a `state`, so a reader branches on that one field. With --history the key is `history`
instead: the CLI's object (with `sessions`) when ok, `{"state": "error", "error": "..."}` when not.

When gatekeepr itself reports an error (exit 3) the object is its own error object and `error_kind` is "cli".
Every other failure is this reader's, in the same shape:

  not_installed       no gatekeepr binary in any place looked (listed in `tried`)
  unsupported_schema  a schemaVersion this reader doesn't know, or none (v0.2.x): never guessed at
  bad_output          output that breaks the contract: not JSON, a missing field, an exit code that disagrees
  usage               exit 64: gatekeepr rejected the command line
  failed              any other exit code, a timeout, or a binary that couldn't be started

Exit 1 (expiringSoon) and exit 2 (expired, signedOut, noSession) are states, not failures. Nothing here
recomputes expiry: `expiresAt` and `secondsLeft` are read from the CLI as they are.

Binary lookup, first hit wins: `binary_path` in data/artifacts/gatekeepr/settings.json, then PATH, then
~/go/bin/gatekeepr, then /usr/local/bin/gatekeepr. Processes Lucidos spawns often lack ~/go/bin on PATH, which
is why the fixed fallbacks exist. A `binary_path` that isn't an executable file is skipped, with a `note`.

  python3 data/scripts/gatekeepr/reader.py             # the status wrapper, as JSON
  python3 data/scripts/gatekeepr/reader.py --history   # the history wrapper, as JSON
  python3 data/scripts/gatekeepr/reader.py --summary   # one line for people
"""
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

sys.dont_write_bytecode = True  # no __pycache__ beside the plugin's scripts

SCHEMA_VERSION = 1
TIMEOUT_SECONDS = 15
FALLBACK_PATHS = ("~/go/bin/gatekeepr", "/usr/local/bin/gatekeepr")

# docs/JSON.md § States and § Exit codes.
EXIT_FOR_STATE = {"active": 0, "expiringSoon": 1, "expired": 2, "signedOut": 2, "noSession": 2, "error": 3}
_LENGTH = ("sessionLengthSeconds", "sessionLengthSource", "sessionLengthLearnedFrom")
_SESSION = ("sessionStart", "sessionStartKind", "expiresAt", "expirySource", "secondsLeft", "timeLeft")
_BASE = ("now", "warnThresholdSeconds") + _LENGTH
REQUIRED = {
    "active": _BASE + _SESSION,
    "expiringSoon": _BASE + _SESSION,
    "expired": _BASE + _SESSION,
    "signedOut": _BASE + _SESSION,
    "noSession": _BASE,
    "error": ("error",),
}
INTEGER_FIELDS = ("secondsLeft", "sessionLengthSeconds", "sessionLengthLearnedFrom", "warnThresholdSeconds")
HISTORY_REQUIRED = ("now", "sessions") + _LENGTH
HISTORY_SESSION_REQUIRED = ("start", "startKind", "outcome", "expiresAt", "expirySource", "reconnects")


def workspace_root():
    return os.environ.get("LUCIDOS_WORKSPACE") or os.getcwd()


def state_dir():
    """data/artifacts/gatekeepr/: settings the app writes, and the snapshots and ledger check.py writes."""
    return os.path.join(workspace_root(), "data", "artifacts", "gatekeepr")


def load_settings():
    """-> (settings dict, problem or None). A missing file is no problem: every key has a default."""
    path = os.path.join(state_dir(), "settings.json")
    try:
        with open(path) as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}, None
    except (OSError, ValueError) as e:
        return {}, f"settings.json couldn't be read ({e}), so the defaults were used"
    if not isinstance(data, dict):
        return {}, "settings.json isn't a JSON object, so the defaults were used"
    return data, None


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _is_executable(path):
    return os.path.isfile(path) and os.access(path, os.X_OK)


def find_binary(configured=None):
    """-> (path or None, places tried, note or None)."""
    tried, note = [], None
    if configured:
        path = os.path.expanduser(str(configured))
        tried.append(path)
        if _is_executable(path):
            return path, tried, None
        note = f"binary_path {configured} in settings isn't an executable file, so it was skipped"
    tried.append("PATH")
    found = shutil.which("gatekeepr")
    if found:
        return found, tried, note
    for candidate in FALLBACK_PATHS:
        path = os.path.expanduser(candidate)
        tried.append(path)
        if _is_executable(path):
            return path, tried, note
    return None, tried, note


def _first_line(text):
    text = (text or "").strip()
    return text.splitlines()[0] if text else ""


def _check_schema(obj, what):
    """The contract says to check schemaVersion before anything else, and never to guess at an unknown one."""
    if not isinstance(obj, dict):
        return "bad_output", f"{what} printed JSON that isn't an object"
    version = obj.get("schemaVersion")
    if version is None:
        return "unsupported_schema", (f"{what} printed no schemaVersion, so it's older than v0.3.0. "
                                      "Update gatekeepr to v0.3.0 or later.")
    if type(version) is not int or version != SCHEMA_VERSION:
        return "unsupported_schema", (f"{what} printed schemaVersion {version!r}, and this plugin reads only "
                                      f"schemaVersion {SCHEMA_VERSION}. Update the Gatekeepr plugin.")
    return None, None


def _check_status(obj, exit_code):
    kind, problem = _check_schema(obj, "gatekeepr --json")
    if kind:
        return kind, problem
    state = obj.get("state")
    if state not in EXIT_FOR_STATE:
        return "bad_output", f"gatekeepr --json printed an unknown state {state!r} under schemaVersion 1"
    expected = EXIT_FOR_STATE[state]
    if obj.get("exitCode") != exit_code or exit_code != expected:
        return "bad_output", (f"gatekeepr exited {exit_code} with exitCode {obj.get('exitCode')!r} for state "
                              f"{state}, which the contract says exits {expected}")
    missing = [k for k in REQUIRED[state] if k not in obj]
    if missing:
        return "bad_output", f"gatekeepr --json said {state} but left out {', '.join(missing)}"
    wrong = [k for k in INTEGER_FIELDS if k in obj and type(obj[k]) is not int]
    if wrong:
        return "bad_output", f"gatekeepr --json printed a non-integer {', '.join(wrong)}"
    return None, None


def _check_history(obj, exit_code):
    kind, problem = _check_schema(obj, "gatekeepr history --json")
    if kind:
        return kind, problem
    if exit_code == 3:
        if obj.get("state") != "error" or "error" not in obj:
            return "bad_output", "gatekeepr history exited 3 without its error object"
        return None, None
    if exit_code != 0:
        return "bad_output", f"gatekeepr history exited {exit_code}, which the contract never does"
    missing = [k for k in HISTORY_REQUIRED if k not in obj]
    if missing:
        return "bad_output", f"gatekeepr history --json left out {', '.join(missing)}"
    if not isinstance(obj["sessions"], list):
        return "bad_output", "gatekeepr history --json printed sessions that aren't a list"
    for i, session in enumerate(obj["sessions"]):
        gone = [k for k in HISTORY_SESSION_REQUIRED if not isinstance(session, dict) or k not in session]
        if gone:
            return "bad_output", f"gatekeepr history --json session {i} left out {', '.join(gone)}"
    return None, None


def _read(args, key, check, binary=None):
    settings, settings_problem = load_settings()
    if binary:
        path, tried, note = binary, [binary], None
    else:
        path, tried, note = find_binary(settings.get("binary_path"))
    out = {"ok": False, "checked_at": now_iso(), "binary": path}
    for extra in (note, settings_problem):
        if extra:
            out.setdefault("notes", []).append(extra)

    def fail(kind, message, exit_code=None):
        out.update(error_kind=kind, **({"exit_code": exit_code} if exit_code is not None else {}))
        out[key] = {"state": "error", "error": message}
        return out

    if not path:
        out["tried"] = tried
        return fail("not_installed", "The gatekeepr CLI isn't installed, or isn't anywhere Gatekeepr looks: "
                    + ", ".join(tried) + ".")
    try:
        proc = subprocess.run([path] + args, capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return fail("failed", f"gatekeepr didn't answer within {TIMEOUT_SECONDS} seconds.")
    except OSError as e:
        return fail("failed", f"gatekeepr couldn't be started: {e}.")

    code = proc.returncode
    if code == 64:
        return fail("usage", "gatekeepr rejected the command line: "
                    + (_first_line(proc.stderr) or "no message") + ". Is it v0.3.0 or later?", code)
    try:
        obj = json.loads(proc.stdout)
    except ValueError:
        reason = _first_line(proc.stderr) or "no JSON on stdout"
        return fail("failed" if code not in (0, 1, 2, 3) else "bad_output",
                    f"gatekeepr exited {code} without the JSON it promises: {reason}", code)
    kind, problem = check(obj, code)
    if kind:
        return fail(kind, problem, code)
    out.update(exit_code=code)
    out[key] = obj
    if obj.get("state") == "error":
        out["error_kind"] = "cli"
        return out
    out["ok"] = True
    return out


def read_status(binary=None):
    """`gatekeepr --json`, checked against the contract. See the module docstring for the shape."""
    return _read(["--json"], "status", _check_status, binary)


def read_history(binary=None):
    """`gatekeepr history --json`, checked against the contract."""
    return _read(["history", "--json"], "history", _check_history, binary)


def parse_time(iso):
    """A contract time: ISO 8601 to the second with the local offset, or Z (which Python < 3.11 can't parse)."""
    return datetime.fromisoformat(iso[:-1] + "+00:00" if iso.endswith("Z") else iso)


def clock(iso):
    """HH:MM in the offset the CLI printed, which is the Mac's local time."""
    return parse_time(iso).strftime("%H:%M")


def day_clock(iso):
    return parse_time(iso).strftime("%a %d %b %H:%M")


def summarize(wrapper):
    """One line for people, from a read_status() wrapper."""
    status = wrapper.get("status") or {}
    state = status.get("state")
    if state in ("active", "expiringSoon"):
        lead = "Appgate VPN active" if state == "active" else "Appgate VPN expiring soon"
        return (f"{lead}: {status['timeLeft']} left, expires {clock(status['expiresAt'])} "
                f"(signed in {day_clock(status['sessionStart'])}).")
    if state == "expired":
        line = f"Appgate VPN session expired at {clock(status['expiresAt'])}."
        if status.get("sessionEnd"):
            line += f" The client closed it at {clock(status['sessionEnd'])}."
        return line
    if state == "signedOut":
        ended = status.get("sessionEnd")
        return "Appgate VPN signed out" + (f" since {day_clock(ended)}." if ended else ".")
    if state == "noSession":
        return "No Appgate session anywhere in the logs."
    return f"Gatekeepr couldn't read the Appgate session ({wrapper.get('error_kind') or 'error'}): " \
           f"{status.get('error') or 'no reason given'}"


def main(argv):
    if "--history" in argv:
        print(json.dumps(read_history(), indent=2))
    elif "--summary" in argv:
        print(summarize(read_status()))
    else:
        print(json.dumps(read_status(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
