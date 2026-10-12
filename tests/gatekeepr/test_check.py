"""check.py: alerts, dedup per session, the problem alert, snapshots and the domain event."""
import os
import unittest

from support import Sandbox

SESSION = "2026-10-11T23:18:18+02:00"
RENEWED = "2026-10-12T23:17:40+02:00"


def soon(seconds, time_left, session=SESSION):
    """An expiringSoon (or, past 30 minutes, active) reading with `seconds` left."""
    state, code = ("expiringSoon", 1) if seconds <= 1800 else ("active", 0)
    return dict(secondsLeft=seconds, timeLeft=time_left, sessionStart=session, state=state, exitCode=code)


class CheckTest(Sandbox):
    def alert_ids(self, calls):
        return [c[c.index("--title") + 1] for c in self.notifications(calls)]

    # -- snapshots, history and the event ---------------------------------------------------------------------

    def test_first_run_writes_the_snapshot_and_history_and_emits(self):
        self.status("status-active.json")
        calls, out = self.run_check()
        status = self.read_state_file("status.json")
        self.assertTrue(status["ok"])
        self.assertEqual(status["status"]["secondsLeft"], 13745)
        self.assertEqual(len(self.read_state_file("history.json")["history"]["sessions"]), 5)
        [event] = self.events(calls)
        self.assertEqual(event["state"], "active")
        self.assertTrue(event["changed"])
        self.assertIsNone(event["previous_state"])
        self.assertEqual(event["expires_at"], "2026-10-12T23:18:16+02:00")
        self.assertTrue(event["summary"].startswith("Appgate VPN active: 3h49m left"))
        self.assertEqual(self.notifications(calls), [])
        self.assertIn("3h49m left", out)

    def test_a_quiet_run_makes_one_cli_call_and_no_event(self):
        self.status("status-active.json")
        self.run_check()
        before = len(self.gatekeepr_calls())
        self.status("status-active.json", secondsLeft=13445, timeLeft="3h44m")
        calls, _ = self.run_check()
        self.assertEqual(calls, [])
        self.assertEqual(self.gatekeepr_calls()[before:], ["--json"])
        self.assertEqual(self.read_state_file("status.json")["status"]["secondsLeft"], 13445)

    def test_a_state_change_emits_and_refreshes_history(self):
        self.status("status-active.json")
        self.run_check()
        self.status("status-expiring-soon.json")
        calls, _ = self.run_check()
        [event] = self.events(calls)
        self.assertEqual((event["previous_state"], event["state"]), ("active", "expiringSoon"))
        self.assertEqual(self.gatekeepr_calls()[-2:], ["--json", "history --json"])

    def test_a_requested_check_always_answers(self):
        self.status("status-active.json")
        self.run_check()
        for wrap in (False, True):
            with self.subTest(wrapped=wrap):
                calls, _ = self.run_check(request={"summary": "Check now", "request_id": "r-1"}, wrap=wrap)
                [event] = self.events(calls)
                self.assertFalse(event["changed"])
                self.assertEqual(event["request_id"], "r-1")
                self.assertEqual(self.gatekeepr_calls()[-1], "history --json")
                self.assertEqual(self.read_state_file("status.json")["request_id"], "r-1")

    def test_runtime_state_is_gitignored_but_settings_are_not(self):
        self.status("status-active.json")
        self.run_check()
        with open(os.path.join(self.state_dir, ".gitignore")) as f:
            ignored = [line.strip() for line in f if line.strip() and not line.startswith("#")]
        for name in ("status.json", "history.json", "state.json"):
            self.assertIn(name, ignored)
        self.assertNotIn("settings.json", ignored)

    # -- alerts ------------------------------------------------------------------------------------------------

    def test_warn_alert_fires_once_per_session(self):
        self.status("status-active.json")
        self.run_check()
        self.status("status-expiring-soon.json", **soon(1534, "25m"))
        calls, _ = self.run_check()
        [notify] = self.notifications(calls)
        self.assertEqual(notify[notify.index("--title") + 1], "Appgate VPN: 25m left")
        self.assertIn("ends at 23:18", notify[notify.index("--message") + 1])
        self.assertEqual(notify[notify.index("--app-id") + 1], "gatekeepr")
        self.assertEqual(self.events(calls)[0]["alerts_sent"], ["warn"])
        self.status("status-expiring-soon.json", **soon(1234, "20m"))
        calls, _ = self.run_check()
        self.assertEqual(self.notifications(calls), [])

    def test_final_alert_after_warn(self):
        self.status("status-expiring-soon.json", **soon(1534, "25m"))
        self.run_check()
        self.status("status-renewal-countdown.json")
        calls, _ = self.run_check()
        self.assertEqual(self.alert_ids(calls), ["Appgate VPN: 3m left"])
        self.assertEqual(self.read_state_file("state.json")["fired"][SESSION].keys(), {"warn", "final"})

    def test_sleeping_through_thresholds_sends_only_the_most_urgent(self):
        self.status("status-renewal-countdown.json")
        calls, _ = self.run_check()
        self.assertEqual(self.alert_ids(calls), ["Appgate VPN: 3m left"])
        self.assertEqual(self.read_state_file("state.json")["fired"][SESSION].keys(), {"warn", "final"})
        self.status("status-expiring-soon.json", **soon(120, "2m"))
        calls, _ = self.run_check()
        self.assertEqual(self.notifications(calls), [])

    def test_a_renewal_starts_the_alerts_afresh(self):
        self.status("status-expiring-soon.json", **soon(1534, "25m"))
        self.run_check()
        self.status("status-expiring-soon.json", **soon(1500, "25m", session=RENEWED), sessionStartKind="renewal")
        calls, _ = self.run_check()
        self.assertEqual(self.alert_ids(calls), ["Appgate VPN: 25m left"])

    def test_recent_expiry_alerts_once(self):
        self.status("status-expiring-soon.json", **soon(1534, "25m"))
        self.run_check()
        self.status("status-expired.json")
        calls, _ = self.run_check()
        [notify] = self.notifications(calls)
        self.assertEqual(notify[notify.index("--title") + 1], "Appgate VPN session expired")
        self.assertIn("ran out at 23:18", notify[notify.index("--message") + 1])
        calls, _ = self.run_check()
        self.assertEqual(self.notifications(calls), [])

    def test_an_old_expiry_is_settled_without_a_notification(self):
        self.status("status-expired-closed.json")
        calls, _ = self.run_check()
        self.assertEqual(self.notifications(calls), [])
        self.assertIn("expired", self.read_state_file("state.json")["fired"][SESSION])

    def test_signed_out_and_no_session_send_nothing(self):
        for name in ("status-signed-out.json", "status-no-session.json"):
            with self.subTest(name):
                self.status(name)
                calls, _ = self.run_check()
                self.assertEqual(self.notifications(calls), [])

    def test_disabled_alerts_stay_quiet_and_thresholds_are_editable(self):
        self.settings({"binary_path": self.fake, "alerts": [
            {"id": "warn", "kind": "before", "minutes": 45, "enabled": True},
            {"id": "final", "kind": "before", "minutes": 5, "enabled": False},
            {"id": "expired", "kind": "expired", "enabled": False},
        ]})
        self.status("status-active.json", **soon(2400, "40m"))
        calls, _ = self.run_check()
        self.assertEqual(self.alert_ids(calls), ["Appgate VPN: 40m left"])
        self.status("status-renewal-countdown.json")
        calls, _ = self.run_check()
        self.assertEqual(self.notifications(calls), [])
        self.status("status-expired.json")
        calls, _ = self.run_check()
        self.assertEqual(self.notifications(calls), [])

    def test_unreadable_alert_entries_are_skipped_with_a_note(self):
        self.settings({"binary_path": self.fake, "alerts": [
            {"id": "warn", "kind": "before", "minutes": "thirty"},
            {"id": "final", "kind": "before", "minutes": 5},
        ]})
        self.status("status-expiring-soon.json", **soon(1534, "25m"))
        calls, _ = self.run_check()
        self.assertEqual(self.notifications(calls), [])
        self.assertIn("can't read", self.read_state_file("status.json")["notes"][0])

    def test_an_undelivered_alert_is_retried_on_the_next_check(self):
        self.status("status-expiring-soon.json", **soon(1534, "25m"))
        calls, _ = self.run_check(extra_env={"FAKE_LUCIDOS_FAIL": "notify"})
        self.assertEqual(len(self.notifications(calls)), 1)
        self.assertNotIn(SESSION, self.read_state_file("state.json")["fired"])
        calls, _ = self.run_check()
        self.assertEqual(self.alert_ids(calls), ["Appgate VPN: 25m left"])

    # -- problems ----------------------------------------------------------------------------------------------

    def test_a_problem_alerts_once_until_it_clears(self):
        self.status("status-error.json")
        calls, _ = self.run_check()
        [notify] = self.notifications(calls)
        self.assertEqual(notify[notify.index("--title") + 1], "Gatekeepr can't read your VPN session")
        self.assertIn("driver.log:1:", notify[notify.index("--message") + 1])
        self.assertEqual(self.events(calls)[0]["error_kind"], "cli")
        calls, _ = self.run_check()
        self.assertEqual(calls, [])
        self.status("status-active.json")
        self.run_check()
        self.status("status-error.json")
        calls, _ = self.run_check()
        self.assertEqual(len(self.notifications(calls)), 1)

    def test_an_unknown_schema_is_a_problem_not_a_guess(self):
        self.status("status-schema-2.json")
        self.history("status-schema-2.json")
        calls, _ = self.run_check()
        status = self.read_state_file("status.json")
        self.assertFalse(status["ok"])
        self.assertEqual(status["error_kind"], "unsupported_schema")
        self.assertEqual(len(self.notifications(calls)), 1)
        self.assertEqual(self.read_state_file("history.json")["error_kind"], "unsupported_schema")

    def test_the_problem_alert_can_be_turned_off(self):
        self.settings({"binary_path": self.fake, "alerts": [{"id": "problem", "kind": "problem", "enabled": False}]})
        self.status("status-error.json")
        calls, _ = self.run_check()
        self.assertEqual(self.notifications(calls), [])
        self.assertEqual(len(self.events(calls)), 1)

    @unittest.skipIf(os.path.exists("/usr/local/bin/gatekeepr"), "a real gatekeepr sits in /usr/local/bin")
    def test_not_installed(self):
        self.settings({})
        calls, _ = self.run_check()
        status = self.read_state_file("status.json")
        self.assertEqual(status["error_kind"], "not_installed")
        [notify] = self.notifications(calls)
        self.assertEqual(notify[notify.index("--title") + 1], "Gatekeepr CLI not found")
        self.assertFalse(os.path.exists(os.path.join(self.state_dir, "history.json")))


if __name__ == "__main__":
    unittest.main()
