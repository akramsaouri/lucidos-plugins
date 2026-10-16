"""The two app frames: the countdown timer they share, and the event names they emit."""
import json
import os
import re
import shutil
import subprocess
import unittest

PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "gatekeepr")
APP = os.path.join(PLUGIN, "apps", "gatekeepr")
WIDGET = os.path.join(PLUGIN, "apps", "gatekeepr-widget")

# Draws the timer on a stub DOM and reports, for a few fractions and session lengths, the angle of the disc's edge
# (where the knob's ridge points), whether a disc is drawn, and the dial's labels.
PROBE = r"""
const nodes = {};
const node = (name) => (nodes[name] = nodes[name] || { attrs: {}, style: {}, innerHTML: '',
  setAttribute(k, v) { this.attrs[k] = v; } });
const el = { set innerHTML(_) {}, querySelector: (sel) => node(sel.slice(1)) };
global.window = global;
global.document = { createElement: () => ({}), head: { appendChild() {} } };
require(process.argv[1]);
const timer = ExpiryTimer.mount(el);
const out = [];
for (const [f, length] of [[1, 86399], [0.25, 86399], [0.001, 86399], [0, 86399], [0.5, 28800], [0.5, 36000],
                           [0.5, undefined]]) {
  timer.draw(f, length);
  out.push({ f, length, angle: Number(nodes['tm-knob'].attrs.transform.match(/rotate\(([\d.]+)/)[1]),
             disc: !!nodes['tm-disc'].attrs.d,
             labels: [...nodes['tm-dial'].innerHTML.matchAll(/>(\d+h)</g)].map((m) => m[1]) });
}
console.log(JSON.stringify(out));
"""


def read(path):
    with open(path) as f:
        return f.read()


class CountdownTimerTest(unittest.TestCase):
    def test_both_frames_ship_the_same_drawing(self):
        self.assertEqual(read(os.path.join(APP, "timer.js")), read(os.path.join(WIDGET, "timer.js")))
        for page in (os.path.join(APP, "index.html"), os.path.join(WIDGET, "index.html")):
            self.assertIn('<script src="timer.js"></script>', read(page))

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_disc_tracks_the_time_left(self):
        out = subprocess.run(["node", "-e", PROBE, os.path.join(APP, "timer.js")],
                             capture_output=True, text=True, check=True).stdout
        full, quarter, sliver, gone, eight, ten, unknown = json.loads(out)
        self.assertEqual((full["angle"], full["disc"]), (360, True))       # a full disc at sign-in
        self.assertEqual(quarter["angle"], 90)                             # a quarter left reaches 3 o'clock
        self.assertGreater(sliver["angle"], 5)                             # a sliver stays while time is left
        self.assertEqual((gone["angle"], gone["disc"]), (0, False))        # no disc at expiry
        self.assertEqual(full["labels"], ["6h", "12h", "18h"])            # quarters of a 24-hour session
        self.assertEqual(eight["labels"], ["2h", "4h", "6h"])             # follow the learned length
        self.assertEqual(ten["labels"], [])                                # and stay off when they aren't whole hours
        self.assertEqual(unknown["labels"], ["6h", "12h", "18h"])         # no length means 24 hours


class WidgetTileTest(unittest.TestCase):
    """The widget on a Home board tile: it names itself top-left and has a layout for each tile size."""

    def setUp(self):
        self.page = read(os.path.join(WIDGET, "index.html"))
        self.css = re.search(r"<style>(.*?)</style>", self.page, re.S).group(1)

    def test_it_names_itself_with_its_icon(self):
        self.assertIn('<img src="assets/icon.svg" alt=""><span>Gatekeepr</span>', self.page)
        self.assertTrue(os.path.exists(os.path.join(WIDGET, "assets", "icon.svg")))
        # Only on a tile (the card draws the name everywhere else), and never on the right, where the tile's menu is.
        self.assertIn(".ident { display: none; }", self.css)
        self.assertRegex(self.css, r"html\[data-widget-size\] \.ident \{[^}]*align-self: flex-start")

    def test_each_tile_size_has_a_layout_and_nothing_scrolls(self):
        for size in ("small", "medium", "large"):
            self.assertIn(f'html[data-widget-size="{size}"]', self.css)
        self.assertRegex(self.css, r"html\[data-widget-size\], html\[data-widget-size\] body \{[^}]*overflow: hidden")

    def test_the_medium_timer_takes_its_width_from_the_stage_height(self):
        # aspect-ratio on a stretched flex item with only an absolute child: WebKit resolves its width to 0, so the
        # timer draws over the readout. The width comes from the stage's height in container query units instead.
        medium_timer = re.search(r'html\[data-widget-size="medium"\] \.timer \{([^}]*)\}', self.css).group(1)
        self.assertNotIn("aspect-ratio", medium_timer)
        self.assertRegex(medium_timer, r"width: calc\(100cqh \* 140 / 150\)")
        self.assertRegex(self.css, r'html\[data-widget-size="medium"\] \.stage \{[^}]*container-type: size')

    def test_the_style_uses_theme_tokens_and_rem_only(self):
        self.assertNotRegex(self.css, r"\d\s*px\b")
        self.assertNotRegex(self.css, r"#[0-9a-fA-F]{3,8}\b")
        self.assertNotRegex(self.css, r"\b(rgb|hsl)a?\(")


class EventNamesTest(unittest.TestCase):
    def test_refresh_is_the_only_request_event(self):
        for root, _, files in os.walk(PLUGIN):
            for name in files:
                if name.endswith((".js", ".html", ".py", ".toml", ".md")):
                    self.assertNotIn("GatekeeprCheckRequested", read(os.path.join(root, name)), name)
        trigger = read(os.path.join(PLUGIN, "triggers", "gatekeepr-refresh", "trigger.toml"))
        self.assertIn('event_type = "GatekeeprRefreshRequested"', trigger)
        for page in (os.path.join(APP, "app.js"), os.path.join(WIDGET, "index.html")):
            self.assertIn("lucidos.events.emit('GatekeeprRefreshRequested'", read(page))


if __name__ == "__main__":
    unittest.main()
