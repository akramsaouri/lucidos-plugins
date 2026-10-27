"""The Triage pane: the triage controls, which live in the Inbox app since inbox 0.2.0."""
import os
import re
import shutil
import subprocess
import tomllib
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.join(HERE, "..", "..", "inbox")
APP = os.path.join(PLUGIN, "apps", "inbox")
TRIAGE_TESTS = os.path.join(HERE, "triage")


def read(path):
    with open(path) as f:
        return f.read()


class WiringTest(unittest.TestCase):
    def setUp(self):
        self.page = read(os.path.join(APP, "index.html"))
        self.triage = read(os.path.join(APP, "triage.js"))
        self.mail = read(os.path.join(APP, "mail.js"))

    def test_triage_js_loads_between_mail_js_and_app_js(self):
        scripts = re.findall(r'<script src="([^"]+)"></script>', self.page)
        self.assertLess(scripts.index("mail.js"), scripts.index("triage.js"))
        self.assertLess(scripts.index("triage.js"), scripts.index("app.js"))
        self.assertIn('id="triage"', self.page)

    def test_it_calls_only_what_mail_js_exports(self):
        exports = re.search(r"window\.Mail = \{(.*?)\};", self.mail, re.S).group(1)
        names = set(re.findall(r"(\w+)\s*(?=[,:]|\s*$)", exports))
        calls = set(re.findall(r"\bM\.(\w+)", self.triage))
        self.assertTrue(calls)
        self.assertLessEqual(calls, names)

    def test_triggers_are_found_by_name_not_by_a_hardcoded_field(self):
        # Accounts come from whoever installs the plugin, so no account record carries a trigger name or id.
        self.assertIn("M.triggerFor(", self.triage)
        self.assertNotRegex(self.triage, r"\bA\[\w+\]\.trigger\b")

    def test_triage_now_sends_what_the_on_demand_trigger_answers(self):
        trig = tomllib.loads(read(os.path.join(PLUGIN, "triggers", "inbox-triage-on-demand", "trigger.toml")))
        self.assertEqual([o["event_type"] for o in trig["on"]], ["EmailTriageRequested"])
        self.assertIn("lucidos.events.emit('EmailTriageRequested'", self.triage)
        self.assertIn("source: 'email-triage-app'", self.triage)

    def test_nothing_says_inbox_needs_email_triage(self):
        inbox = tomllib.loads(read(os.path.join(PLUGIN, "manifest.toml")))
        self.assertNotIn("Email Triage", inbox["description"])
        self.assertNotIn("installed at 0.7.0 or later", inbox["setup"])


class PublicRepoTest(unittest.TestCase):
    def test_no_personal_address_or_machine_path_ships(self):
        for name in ("triage.js", os.path.join("knowhow", "triage.md")):
            text = read(os.path.join(APP, name))
            addrs = re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", text)
            self.assertEqual([a for a in addrs if not re.search(r"@(github\.com|[\w.-]*example\.\w+)$", a)], [], name)
            self.assertNotRegex(text, r"/Users/|/home/|[A-Z]:\\", name)


class PaneTest(unittest.TestCase):
    """Runs triage.test.js: the whole app under jsdom against fixtures/. Needs node and `npm install` in triage/."""

    def test_the_pane_under_jsdom(self):
        if not shutil.which("node"):
            self.skipTest("node is not installed")
        if not os.path.isdir(os.path.join(TRIAGE_TESTS, "node_modules", "jsdom")):
            self.skipTest("run `npm install` in tests/inbox/triage first")
        proc = subprocess.run(["node", "--test"], cwd=TRIAGE_TESTS, capture_output=True, text=True, timeout=180)
        self.assertEqual(proc.returncode, 0, proc.stdout[-4000:] + proc.stderr[-2000:])


if __name__ == "__main__":
    unittest.main()
