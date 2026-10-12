"""reader.py: binary lookup, the JSON contract, and the one-line summary."""
import os
import shutil
import unittest
from unittest import mock

from support import FIXTURES, Sandbox, fixture
import reader as R

STATES = {
    "status-active.json": 0,
    "status-expiring-soon.json": 1,
    "status-renewal-countdown.json": 1,
    "status-expired.json": 2,
    "status-expired-closed.json": 2,
    "status-signed-out.json": 2,
    "status-no-session.json": 2,
}


class ReaderTest(Sandbox):
    def read(self, **kw):
        with mock.patch.dict(os.environ, self.env, clear=True):
            return R.read_status(**kw)

    def read_history(self):
        with mock.patch.dict(os.environ, self.env, clear=True):
            return R.read_history()

    # -- every state the contract defines --------------------------------------------------------------------

    def test_every_state_is_read_as_is(self):
        for name, code in STATES.items():
            with self.subTest(name):
                self.status(name)
                out = self.read()
                self.assertTrue(out["ok"], out)
                self.assertEqual(out["exit_code"], code)
                self.assertEqual(out["status"], fixture(name))
                self.assertEqual(out["binary"], self.fake)
                self.assertNotIn("error_kind", out)

    def test_exit_1_and_2_are_states_not_failures(self):
        for name in ("status-expiring-soon.json", "status-expired.json", "status-signed-out.json"):
            with self.subTest(name):
                self.status(name)
                self.assertTrue(self.read()["ok"])

    def test_cli_error_object_is_passed_through(self):
        self.status("status-error.json")
        out = self.read()
        self.assertFalse(out["ok"])
        self.assertEqual(out["error_kind"], "cli")
        self.assertEqual(out["exit_code"], 3)
        self.assertEqual(out["status"], fixture("status-error.json"))

    # -- what the reader refuses rather than guess at --------------------------------------------------------

    def test_unknown_schema_version_is_an_error(self):
        self.status("status-schema-2.json")
        out = self.read()
        self.assertFalse(out["ok"])
        self.assertEqual(out["error_kind"], "unsupported_schema")
        self.assertEqual(out["status"]["state"], "error")
        self.assertIn("schemaVersion 2", out["status"]["error"])

    def test_missing_schema_version_is_an_error(self):
        self.status("status-v0.2.json")
        out = self.read()
        self.assertEqual(out["error_kind"], "unsupported_schema")
        self.assertIn("v0.3.0", out["status"]["error"])

    def test_schema_version_must_be_the_integer_1(self):
        for bad in ("1", 1.0, True):
            with self.subTest(bad=bad):
                self.status("status-active.json", schemaVersion=bad)
                self.assertEqual(self.read()["error_kind"], "unsupported_schema")

    def test_schema_is_checked_before_state(self):
        self.status("status-active.json", schemaVersion=2, state="somethingNew")
        self.assertEqual(self.read()["error_kind"], "unsupported_schema")

    def test_unknown_state_under_schema_1_is_bad_output(self):
        self.status("status-active.json", state="paused")
        self.assertEqual(self.read()["error_kind"], "bad_output")

    def test_exit_code_that_disagrees_is_bad_output(self):
        self.status("status-active.json")
        self.env["FAKE_GATEKEEPR_EXIT"] = "2"
        out = self.read()
        self.assertEqual(out["error_kind"], "bad_output")
        self.assertIn("exited 2", out["status"]["error"])

    def test_exit_code_field_that_disagrees_with_state_is_bad_output(self):
        self.status("status-expiring-soon.json", exitCode=0)
        self.env["FAKE_GATEKEEPR_EXIT"] = "0"
        self.assertEqual(self.read()["error_kind"], "bad_output")

    def test_missing_field_is_bad_output(self):
        self.status("status-active.json", expiresAt=None)
        out = self.read()
        self.assertEqual(out["error_kind"], "bad_output")
        self.assertIn("expiresAt", out["status"]["error"])

    def test_non_integer_seconds_left_is_bad_output(self):
        self.status("status-active.json", secondsLeft="13745")
        self.assertEqual(self.read()["error_kind"], "bad_output")

    def test_not_json_is_bad_output(self):
        self.status("status-garbage.txt")
        self.assertEqual(self.read()["error_kind"], "bad_output")

    def test_exit_64_is_a_usage_error(self):
        self.status("status-active.json")
        self.env["FAKE_GATEKEEPR_EXIT"] = "64"
        out = self.read()
        self.assertEqual(out["error_kind"], "usage")
        self.assertEqual(out["exit_code"], 64)
        self.assertIn("unknown option", out["status"]["error"])

    def test_timeout_is_a_failure(self):
        self.status("status-active.json")
        self.env["FAKE_GATEKEEPR_SLEEP"] = "3"
        with mock.patch.object(R, "TIMEOUT_SECONDS", 0.5):
            out = self.read()
        self.assertEqual(out["error_kind"], "failed")

    # -- binary lookup ---------------------------------------------------------------------------------------

    def put(self, directory, name="gatekeepr"):
        os.makedirs(directory, exist_ok=True)
        path = os.path.join(directory, name)
        os.symlink(os.path.join(os.path.dirname(FIXTURES), "fake_gatekeepr.py"), path)
        return path

    def test_lookup_prefers_settings_over_path(self):
        self.status("status-active.json")
        self.put(self.bin)
        self.assertEqual(self.read()["binary"], self.fake)

    def test_lookup_uses_path_without_settings(self):
        self.status("status-active.json")
        self.settings({})
        on_path = self.put(self.bin)
        self.assertEqual(self.read()["binary"], on_path)

    def test_lookup_falls_back_to_go_bin(self):
        self.status("status-active.json")
        self.settings({})
        go_bin = self.put(os.path.join(self.home, "go", "bin"))
        out = self.read()
        self.assertTrue(out["ok"])
        self.assertEqual(out["binary"], go_bin)

    def test_lookup_falls_back_to_usr_local_bin_last(self):
        self.status("status-active.json")
        self.settings({})
        usr_local = self.put(os.path.join(self.root, "usr-local-bin"))
        with mock.patch.object(R, "FALLBACK_PATHS", ("~/go/bin/gatekeepr", usr_local)):
            self.assertEqual(self.read()["binary"], usr_local)
            go_bin = self.put(os.path.join(self.home, "go", "bin"))
            self.assertEqual(self.read()["binary"], go_bin)

    def test_configured_path_that_is_not_executable_is_skipped_with_a_note(self):
        self.status("status-active.json")
        self.settings({"binary_path": os.path.join(self.root, "nope", "gatekeepr")})
        go_bin = self.put(os.path.join(self.home, "go", "bin"))
        out = self.read()
        self.assertEqual(out["binary"], go_bin)
        self.assertIn("isn't an executable file", out["notes"][0])

    def test_configured_path_expands_tilde(self):
        self.status("status-active.json")
        self.put(os.path.join(self.home, "tools"))
        self.settings({"binary_path": "~/tools/gatekeepr"})
        self.assertEqual(self.read()["binary"], os.path.join(self.home, "tools", "gatekeepr"))

    def test_not_installed_lists_every_place_tried(self):
        self.settings({})
        with mock.patch.object(R, "FALLBACK_PATHS", ("~/go/bin/gatekeepr", os.path.join(self.root, "none"))):
            out = self.read()
        self.assertFalse(out["ok"])
        self.assertEqual(out["error_kind"], "not_installed")
        self.assertIsNone(out["binary"])
        self.assertEqual(out["tried"], ["PATH", os.path.join(self.home, "go/bin/gatekeepr"), os.path.join(self.root, "none")])
        self.assertEqual(out["status"]["state"], "error")

    def test_malformed_settings_fall_back_with_a_note(self):
        self.status("status-active.json")
        self.settings("{not json")
        go_bin = self.put(os.path.join(self.home, "go", "bin"))
        out = self.read()
        self.assertEqual(out["binary"], go_bin)
        self.assertTrue(any("settings.json" in n for n in out["notes"]))

    # -- history ---------------------------------------------------------------------------------------------

    def test_history(self):
        out = self.read_history()
        self.assertTrue(out["ok"], out)
        self.assertEqual(len(out["history"]["sessions"]), 5)
        self.assertEqual(out["history"], fixture("history.json"))

    def test_empty_history(self):
        self.history("history-empty.json")
        out = self.read_history()
        self.assertTrue(out["ok"])
        self.assertEqual(out["history"]["sessions"], [])

    def test_history_error(self):
        self.history("history-error.json")
        out = self.read_history()
        self.assertFalse(out["ok"])
        self.assertEqual(out["error_kind"], "cli")

    def test_history_unknown_schema(self):
        self.history("status-schema-2.json")
        self.assertEqual(self.read_history()["error_kind"], "unsupported_schema")

    # -- summary ---------------------------------------------------------------------------------------------

    def test_summaries(self):
        expected = {
            "status-active.json": "Appgate VPN active: 3h49m left, expires 23:18 (signed in Sun 11 Oct 23:18).",
            "status-expiring-soon.json": "Appgate VPN expiring soon: 25m left, expires 23:18 (signed in Sun 11 Oct 23:18).",
            "status-expired.json": "Appgate VPN session expired at 23:18.",
            "status-expired-closed.json": "Appgate VPN session expired at 23:18. The client closed it at 23:18.",
            "status-signed-out.json": "Appgate VPN signed out since Mon 12 Oct 17:42.",
            "status-no-session.json": "No Appgate session anywhere in the logs.",
        }
        for name, line in expected.items():
            with self.subTest(name):
                self.status(name)
                self.assertEqual(R.summarize(self.read()), line)
        self.status("status-schema-2.json")
        self.assertTrue(R.summarize(self.read()).startswith("Gatekeepr couldn't read the Appgate session (unsupported_schema)"))

    def test_z_offset_parses(self):
        self.assertEqual(R.clock("2026-10-12T21:18:16Z"), "21:18")


REAL = shutil.which("gatekeepr") or next(
    (p for p in map(os.path.expanduser, R.FALLBACK_PATHS) if os.access(p, os.X_OK)), None)


@unittest.skipUnless(REAL, "the gatekeepr CLI isn't installed on this machine")
class RealCliTest(unittest.TestCase):
    """Against the installed CLI and the real /var/log/appgate. Asserts only what holds in any state."""

    def test_real_status_meets_the_contract(self):
        out = R.read_status(binary=REAL)
        self.assertIn(out.get("error_kind"), (None, "cli"), out)
        self.assertEqual(out["status"]["schemaVersion"], 1)
        self.assertIn(out["status"]["state"], R.EXIT_FOR_STATE)

    def test_real_history_meets_the_contract(self):
        out = R.read_history(binary=REAL)
        self.assertIn(out.get("error_kind"), (None, "cli"), out)

    @unittest.skipUnless(any(os.access(os.path.expanduser(p), os.X_OK) for p in R.FALLBACK_PATHS),
                         "gatekeepr is installed outside the fixed fallbacks")
    def test_real_lookup_without_go_bin_on_path(self):
        """The bug that motivated the fallbacks: a Lucidos-spawned process without ~/go/bin on PATH."""
        env = {"PATH": "/usr/bin:/bin", "HOME": os.path.expanduser("~"), "LUCIDOS_WORKSPACE": "/nonexistent"}
        with mock.patch.dict(os.environ, env, clear=True):
            out = R.read_status()
        self.assertIsNotNone(out["binary"], out)
        self.assertIn(out.get("error_kind"), (None, "cli"), out)


if __name__ == "__main__":
    unittest.main()
