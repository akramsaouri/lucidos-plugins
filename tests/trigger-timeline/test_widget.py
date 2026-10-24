"""The Cadence widget: a Home widget the trigger-timeline plugin ships beside the Cadence app."""
import json
import os
import re
import tomllib
import unittest

PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "trigger-timeline")
WIDGET = os.path.join(PLUGIN, "apps", "trigger-timeline-widget")


def read(path):
    with open(path) as f:
        return f.read()


class ManifestTest(unittest.TestCase):
    def setUp(self):
        self.plugin = tomllib.loads(read(os.path.join(PLUGIN, "manifest.toml")))
        self.m = json.loads(read(os.path.join(WIDGET, "manifest.json")))

    def test_it_ships_as_this_plugins_reusable_widget(self):
        self.assertEqual((self.m["kind"], self.m["reusable"], self.m["origin_plugin_id"]), ("widget", True, self.plugin["id"]))
        self.assertNotIn("origin_thread_id", self.m)
        self.assertEqual(self.m["name"], "Cadence")
        self.assertTrue(os.path.exists(os.path.join(WIDGET, self.m["icon"])))

    def test_the_engine_floor_has_plugin_widgets(self):
        # 0.48.0 is the first release that installs a widget a plugin ships.
        floor = tuple(int(p) for p in re.fullmatch(r">=(\d+)\.(\d+)\.(\d+)", self.plugin["engine"]).groups())
        self.assertGreaterEqual(floor, (0, 48, 0))


class PageTest(unittest.TestCase):
    def setUp(self):
        self.page = read(os.path.join(WIDGET, "index.html"))

    def test_it_reads_triggers_over_the_sdk_and_writes_nothing(self):
        self.assertIn("lucidos.triggers.list()", self.page)
        self.assertNotIn("lucidos.data.write", self.page)
        self.assertNotRegex(self.page, r"fetch\(")

    def test_loop_threshold_matches_the_app(self):
        app = read(os.path.join(PLUGIN, "apps", "trigger-timeline", "index.html"))
        app_n = re.search(r"RHYTHM_PER_DAY\s*=\s*(\d+)", app).group(1)
        self.assertIn(f"LOOP_PER_DAY = {app_n}", self.page)

    def test_a_tap_opens_cadence_and_a_hidden_tile_stops_ticking(self):
        self.assertIn("const APP = 'trigger-timeline'", self.page)
        self.assertIn("lucidos.ui.navigate('app', { app_id: APP })", self.page)
        self.assertIn("lucidos.widget.onVisibility", self.page)
        self.assertIn("clearInterval(tick)", self.page)

    def test_it_has_a_layout_for_each_tile_size(self):
        for size in ("small", "medium", "large"):
            self.assertIn(f'html[data-widget-size="{size}"]', self.page)

    def test_every_hover_is_gated(self):
        for m in re.finditer(r":hover", self.page):
            before = self.page[:m.start()]
            self.assertGreater(before.rfind("@media (hover: hover)"), before.rfind("}\n"), "ungated :hover")


class PublicRepoTest(unittest.TestCase):
    def test_no_address_or_machine_path_ships(self):
        for root, _, files in os.walk(WIDGET):
            for name in files:
                text = read(os.path.join(root, name))
                self.assertNotRegex(text, r"[\w.+-]+@[\w-]+\.[a-z]{2,}", name)
                self.assertNotRegex(text, r"/Users/|/home/|[A-Z]:\\\\", name)


if __name__ == "__main__":
    unittest.main()
