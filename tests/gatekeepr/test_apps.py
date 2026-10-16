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

# Runs the widget's own script on a stub page and SDK, then taps and presses keys on it the way a browser delivers
# them (bubbling to the document unless stopped) and reports what each one navigated to and emitted.
TAP_PROBE = r"""
(async () => {
  const html = require('fs').readFileSync(process.argv[1], 'utf8');
  const node = (tagName, parent) => ({ tagName, parent, on: {}, attrs: {}, style: {}, dataset: {},
    classList: { toggle() {} },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); },
    closest(sel) { for (let n = this; n && n.tagName; n = n.parent) if (n.tagName === sel.toUpperCase()) return n; return null; } });
  const doc = node(null, null);
  const body = node('BODY', doc);
  const els = { timer: node('DIV', body), left: node('DIV', body), when: node('DIV', body), problem: node('DIV', body),
                note: node('DIV', body), refresh: node('BUTTON', body) };
  els.icon = node('svg', els.refresh);  // what a tap on Refresh's icon lands on
  Object.assign(doc, { body, visibilityState: 'hidden', getElementById: (id) => els[id] });
  let log = [];
  Object.assign(global, {
    document: doc, setInterval: () => 0, setTimeout: () => 0,
    ExpiryTimer: { mount: () => ({ draw() {} }) },
    lucidos: {
      ui: { applyPreferences() {}, watchPreferences() {}, ready() {}, toast() {},
            navigate: (...args) => log.push(['navigate', ...args]) },
      data: { read: () => Promise.reject({ httpCode: 404 }) },
      triggers: { list: async () => [] },
      events: { emit: async (type) => log.push(['emit', type]) },
      sse: { connect() {}, on() {} },
      utils: { escapeHtml: (s) => s, timeAgo: () => '' },
    },
  });
  require('vm').runInThisContext(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  await new Promise((r) => setImmediate(r));
  const fire = (target, type, props) => {
    let stopped = false;
    const e = { type, target, ...props, stopPropagation() { stopped = true; }, preventDefault() {} };
    for (let n = target; n && !stopped; n = n.parent) (n.on[type] || []).forEach((fn) => fn(e));
  };
  const actions = {
    'tap the timer': () => fire(els.timer, 'click'),
    'tap the page': () => fire(body, 'click'),
    'tap Refresh': () => fire(els.refresh, 'click'),
    'tap the Refresh icon': () => fire(els.icon, 'click'),
    'Enter on the page': () => fire(body, 'keydown', { key: 'Enter' }),
    'Enter on Refresh': () => { fire(els.refresh, 'keydown', { key: 'Enter' }); fire(els.refresh, 'click'); },
    'Tab on the page': () => fire(body, 'keydown', { key: 'Tab' }),
  };
  const out = { tabIndex: body.tabIndex, cursor: body.style.cursor, actions: {} };
  for (const [name, act] of Object.entries(actions)) { log = []; act(); out.actions[name] = log; }
  console.log(JSON.stringify(out));
})();
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


@unittest.skipUnless(shutil.which("node"), "needs node")
class WidgetTapTest(unittest.TestCase):
    """A tap anywhere on the widget opens the Gatekeepr app, and so does Enter on the focused tile. Refresh only
    refreshes."""

    OPEN_APP = [["navigate", "app", {"app_id": "gatekeepr"}]]

    @classmethod
    def setUpClass(cls):
        cls.out = json.loads(subprocess.run(["node", "-e", TAP_PROBE, os.path.join(WIDGET, "index.html")],
                                            capture_output=True, text=True, check=True).stdout)
        cls.acts = cls.out["actions"]

    def test_a_tap_opens_the_app_and_refresh_does_not(self):
        # The app id is the app this plugin ships.
        self.assertTrue(os.path.exists(os.path.join(PLUGIN, "apps", "gatekeepr", "manifest.json")))
        self.assertEqual(self.acts["tap the timer"], self.OPEN_APP)
        self.assertEqual(self.acts["tap the page"], self.OPEN_APP)
        self.assertEqual(self.acts["tap Refresh"], [["emit", "GatekeeprRefreshRequested"]])
        self.assertNotIn("navigate", [a[0] for a in self.acts["tap the Refresh icon"]])
        self.assertEqual(self.out["cursor"], "pointer")

    def test_enter_on_the_focused_tile_opens_the_app(self):
        self.assertEqual(self.out.get("tabIndex"), 0)
        self.assertEqual(self.acts["Enter on the page"], self.OPEN_APP)
        self.assertNotIn("navigate", [a[0] for a in self.acts["Enter on Refresh"]])
        self.assertEqual(self.acts["Tab on the page"], [])
        # Its focus ring is drawn inside the page, since a tile clips anything outside it.
        css = re.search(r"<style>(.*?)</style>", read(os.path.join(WIDGET, "index.html")), re.S).group(1)
        self.assertRegex(css, r"body:focus-visible \{[^}]*box-shadow: inset var\(--focus-ring\)")


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
