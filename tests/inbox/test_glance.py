"""The Inbox widget: a Home widget the plugin ships, reading the Inbox app's own data layer."""
import json
import os
import re
import tomllib
import unittest

PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "inbox")
WIDGET = os.path.join(PLUGIN, "apps", "inbox-glance")
MAIL = os.path.join(PLUGIN, "apps", "inbox", "mail.js")


def read(path):
    with open(path) as f:
        return f.read()


class ManifestTest(unittest.TestCase):
    def test_it_ships_as_this_plugins_reusable_widget(self):
        m = json.loads(read(os.path.join(WIDGET, "manifest.json")))
        self.assertEqual((m["kind"], m["reusable"], m["origin_plugin_id"]), ("widget", True, "inbox"))
        self.assertNotIn("origin_thread_id", m)
        self.assertTrue(os.path.exists(os.path.join(WIDGET, m["icon"])))

    def test_the_engine_floor_has_plugin_widgets(self):
        # 0.48.0 is the first release that installs a widget a plugin ships.
        engine = tomllib.loads(read(os.path.join(PLUGIN, "manifest.toml")))["engine"]
        floor = tuple(int(p) for p in re.fullmatch(r">=(\d+)\.(\d+)\.(\d+)", engine).groups())
        self.assertGreaterEqual(floor, (0, 48, 0))


class DataLayerTest(unittest.TestCase):
    """The widget runs the sibling app's mail.js, so it calls only what that exports and takes its accounts from it."""

    def setUp(self):
        self.page = read(os.path.join(WIDGET, "index.html"))
        self.mail = read(MAIL)

    def test_it_loads_the_inbox_apps_data_layer(self):
        self.assertIn("lucidos.data.read('apps/inbox/mail.js')", self.page)

    def test_it_calls_only_what_mail_js_exports(self):
        exports = re.search(r"window\.Mail = \{(.*?)\};", self.mail, re.S).group(1)
        names = set(re.findall(r"(\w+)\s*(?=[,:]|\s*$)", exports))
        calls = set(re.findall(r"\bM\.(\w+)", self.page))
        self.assertTrue(calls)
        self.assertLessEqual(calls, names)

    def test_the_accounts_come_from_the_data_layer(self):
        self.assertIn("M.snapshot()", self.page)
        record = re.search(r"out\.push\(\{(.*?)\}\);", self.mail, re.S).group(1)
        for field in ("key", "label", "kind", "problem"):
            self.assertRegex(record, rf"\b{field}\b")
            self.assertIn(f"{field}: a.{field}", self.page)


class PublicRepoTest(unittest.TestCase):
    def test_no_address_or_machine_path_ships(self):
        for root, _, files in os.walk(WIDGET):
            for name in files:
                text = read(os.path.join(root, name))
                self.assertNotRegex(text, r"[\w.+-]+@[\w-]+\.[a-z]{2,}", name)
                self.assertNotRegex(text, r"/Users/|/home/|[A-Z]:\\", name)


if __name__ == "__main__":
    unittest.main()
