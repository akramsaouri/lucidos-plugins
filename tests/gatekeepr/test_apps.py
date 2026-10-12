"""The two app frames: the sand timer they share, and the event names they emit."""
import json
import os
import shutil
import subprocess
import unittest

PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "gatekeepr")
APP = os.path.join(PLUGIN, "apps", "gatekeepr")
WIDGET = os.path.join(PLUGIN, "apps", "gatekeepr-widget")

# Draws the timer on a stub DOM and reports, for a few fractions, the top sand's surface, whether any sand has
# fallen, and where the falling stream meets the pile.
PROBE = r"""
const attrs = {};
const node = (name) => ({ setAttribute: (k, v) => { attrs[name + '.' + k] = v; }, style: {},
                          querySelectorAll: () => [node('line'), node('line')] });
const el = { set innerHTML(_) {}, querySelector: (sel) => node(sel.slice(1)) };
global.window = global;
global.document = { createElement: () => ({}), head: { appendChild() {} } };
require(process.argv[1]);
const timer = Hourglass.mount(el);
const out = {};
for (const f of [0, 0.001, 0.25, 0.5, 0.75, 1]) {
  timer.draw(f, true);
  const top = attrs['hg-top.d'];
  out[f] = { surface: top ? Number(top.split(' ')[1]) : null, fallen: !!attrs['hg-bottom.d'],
             streamEnd: Number(attrs['line.y2']) };
}
console.log(JSON.stringify(out));
"""


def read(path):
    with open(path) as f:
        return f.read()


class SandTimerTest(unittest.TestCase):
    def test_both_frames_ship_the_same_drawing(self):
        self.assertEqual(read(os.path.join(APP, "hourglass.js")), read(os.path.join(WIDGET, "hourglass.js")))
        for page in (os.path.join(APP, "index.html"), os.path.join(WIDGET, "index.html")):
            self.assertIn('<script src="hourglass.js"></script>', read(page))

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_sand_level_tracks_the_fraction_by_area(self):
        out = subprocess.run(["node", "-e", PROBE, os.path.join(APP, "hourglass.js")],
                             capture_output=True, text=True, check=True).stdout
        at = {float(k): v for k, v in json.loads(out).items()}
        top, neck = 22, 85
        self.assertAlmostEqual(at[1]["surface"], top, places=3)        # a full bulb at sign-in
        self.assertFalse(at[1]["fallen"])                              # with nothing fallen yet
        self.assertIsNone(at[0]["surface"])                            # nothing left at expiry
        self.assertLess(at[0]["streamEnd"], neck)                      # and the heap has risen to the neck
        self.assertGreater(neck - at[0.001]["surface"], 1)             # a sliver stays while time is left
        surfaces = [at[f]["surface"] for f in (0.25, 0.5, 0.75)]
        self.assertEqual(surfaces, sorted(surfaces, reverse=True))     # more time, higher sand
        # The sand rests in the narrow end by the neck, so half of it stands taller than half the bulb (a smaller y).
        self.assertLess(at[0.5]["surface"], (top + neck) / 2)


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
