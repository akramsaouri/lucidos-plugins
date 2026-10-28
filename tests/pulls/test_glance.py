"""The Pulls widget: a Home widget for the Pulls app (review-cockpit), which ships beside it."""
import json
import os
import re
import tomllib
import unittest

PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "pulls")
WIDGET = os.path.join(PLUGIN, "apps", "pulls-glance")


def read(path):
    with open(path) as f:
        return f.read()


class ManifestTest(unittest.TestCase):
    def setUp(self):
        self.plugin = tomllib.loads(read(os.path.join(PLUGIN, "manifest.toml")))

    def test_it_ships_as_this_plugins_reusable_widget(self):
        m = json.loads(read(os.path.join(WIDGET, "manifest.json")))
        self.assertEqual((m["kind"], m["reusable"], m["origin_plugin_id"]), ("widget", True, self.plugin["id"]))
        self.assertNotIn("origin_thread_id", m)
        self.assertTrue(os.path.exists(os.path.join(WIDGET, m["icon"])))

    def test_the_plugin_manifest(self):
        self.assertEqual(self.plugin["source"], "https://github.com/akramsaouri/lucidos-plugins/tree/main/pulls")
        self.assertTrue(os.path.exists(os.path.join(PLUGIN, self.plugin["icon"])))
        self.assertTrue(os.path.exists(os.path.join(PLUGIN, "media", "README.md")))
        # The Pulls app ships beside the widget now.
        self.assertTrue(os.path.exists(os.path.join(PLUGIN, "apps", "review-cockpit", "index.html")))
        # 0.48.0 is the first release that installs a widget a plugin ships.
        floor = tuple(int(p) for p in re.fullmatch(r">=(\d+)\.(\d+)\.(\d+)", self.plugin["engine"]).groups())
        self.assertGreaterEqual(floor, (0, 48, 0))


class WithoutPullsTest(unittest.TestCase):
    """Everything the widget reads belongs to the Pulls app, so it must cope with that app and its files missing."""

    def setUp(self):
        self.page = read(os.path.join(WIDGET, "index.html"))

    def test_it_reads_only_the_pulls_apps_files(self):
        for path in re.findall(r"'(artifacts/[^']+)'", self.page):
            self.assertTrue(path.startswith("artifacts/review-cockpit/"), path)
        self.assertNotRegex(self.page, r"lucidos\.data\.read\('apps/")

    def test_a_missing_app_says_so_and_a_tap_goes_nowhere(self):
        self.assertIn("lucidos.apps.get(APP)", self.page)
        self.assertIn("'Pulls app not installed'", self.page)
        self.assertIn("if (present) lucidos.ui.navigate('app', { app_id: APP })", self.page)

    def test_a_missing_file_is_no_data_not_a_failure(self):
        self.assertIn("e.httpCode === 404", self.page)
        self.assertIn("'Pulls has no data yet'", self.page)


class PublicRepoTest(unittest.TestCase):
    def test_no_address_or_machine_path_ships(self):
        for root, _, files in os.walk(PLUGIN):
            for name in files:
                text = read(os.path.join(root, name))
                self.assertNotRegex(text, r"[\w.+-]+@[\w-]+\.[a-z]{2,}", name)
                self.assertNotRegex(text, r"/Users/|/home/|[A-Z]:\\", name)


if __name__ == "__main__":
    unittest.main()
