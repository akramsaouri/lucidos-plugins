"""The two app frames: the countdown timer they share, and the event names they emit."""
import json
import os
import shutil
import subprocess
import unittest

PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "gatekeepr")
APP = os.path.join(PLUGIN, "apps", "gatekeepr")
WIDGET = os.path.join(PLUGIN, "apps", "gatekeepr-widget")

# Draws the timer on a stub DOM and reports, for a few fractions and session lengths, the hand's angle, whether a
# wedge is drawn, whether the second hand shows, and the dial's labels.
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
for (const [f, running, length] of [[1, true, 86399], [0.25, true, 86399], [0.001, true, 86399], [0, false, 86399],
                                    [0.5, true, 28800], [0.5, true, 36000], [0.5, false, undefined]]) {
  timer.draw(f, running, length);
  out.push({ f, length, angle: Number(nodes['tm-hand-group'].attrs.transform.match(/rotate\(([\d.]+)/)[1]),
             wedge: !!nodes['tm-wedge'].attrs.d, second: nodes['tm-sec'].style.display !== 'none',
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
    def test_the_hand_and_wedge_track_the_time_left(self):
        out = subprocess.run(["node", "-e", PROBE, os.path.join(APP, "timer.js")],
                             capture_output=True, text=True, check=True).stdout
        full, quarter, sliver, gone, eight, ten, unknown = json.loads(out)
        self.assertEqual((full["angle"], full["wedge"]), (360, True))      # a full turn at sign-in
        self.assertEqual(quarter["angle"], 90)                             # a quarter left points at 3 o'clock
        self.assertGreater(sliver["angle"], 5)                             # a sliver stays while time is left
        self.assertEqual((gone["angle"], gone["wedge"]), (0, False))       # back at 12, no wedge, at expiry
        self.assertTrue(quarter["second"])                                 # the second hand ticks while it runs
        self.assertFalse(gone["second"])
        self.assertEqual(full["labels"], ["6h", "12h", "18h"])            # quarters of a 24-hour session
        self.assertEqual(eight["labels"], ["2h", "4h", "6h"])             # follow the learned length
        self.assertEqual(ten["labels"], [])                                # and stay off when they aren't whole hours
        self.assertEqual(unknown["labels"], ["6h", "12h", "18h"])         # no length means 24 hours


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
