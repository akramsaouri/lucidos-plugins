"""Browser Learning: knowhow only, and never a file that would clobber the workspace's learned site data."""
import os
import re
import tomllib
import unittest

PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "browser-learning")
KNOWHOW = os.path.join(PLUGIN, "knowhow", "browser-learning")


def read(path):
    with open(path) as f:
        return f.read()


def shipped():
    for root, dirs, files in os.walk(PLUGIN):
        for name in files:
            yield os.path.relpath(os.path.join(root, name), PLUGIN)


class ManifestTest(unittest.TestCase):
    def setUp(self):
        self.m = tomllib.loads(read(os.path.join(PLUGIN, "manifest.toml")))
        self.setup = re.sub(r"\s+", " ", self.m["setup"])

    def test_the_manifest(self):
        self.assertEqual((self.m["id"], self.m["name"]), ("browser-learning", "Browser Learning"))
        self.assertEqual(
            self.m["source"], "https://github.com/akramsaouri/lucidos-plugins/tree/main/browser-learning"
        )
        self.assertEqual(self.m["engine"], ">=0.9.5")

    def test_setup_reuses_an_existing_reflection_trigger(self):
        self.assertIn("lucidos triggers list", self.setup)
        self.assertIn("browser-knowhow-reflection", self.setup)
        self.assertIn("Don't create a second", self.setup)
        self.assertLess(self.setup.index("triggers list"), self.setup.index("Create the trigger"))


class ShippedFilesTest(unittest.TestCase):
    def test_ships_only_its_two_knowhow_files(self):
        # The install record of 0.3.1 holds exactly these, so an update from it removes nothing.
        self.assertEqual(
            sorted(shipped()),
            [
                "knowhow/browser-learning/observation.md",
                "knowhow/browser-learning/reflection.md",
                "manifest.toml",
            ],
        )

    def test_never_ships_site_files_or_the_index(self):
        # A shipped knowhow/sites/ path would overwrite the user's learned file on install
        # and delete it on uninstall.
        for path in shipped():
            self.assertFalse(path.startswith("knowhow/sites/"), path)

    def test_no_cron_trigger_shipped(self):
        self.assertFalse(os.path.exists(os.path.join(PLUGIN, "triggers")))


class KnowhowTest(unittest.TestCase):
    def test_frontmatter(self):
        for name in ("observation.md", "reflection.md"):
            text = read(os.path.join(KNOWHOW, name))
            self.assertTrue(text.startswith("---\nname: "), name)
            self.assertIn("\ndescription: ", text.split("\n---\n", 1)[0], name)

    def test_observation_loads_the_index(self):
        self.assertIn("sites/index", read(os.path.join(KNOWHOW, "observation.md")))

    def test_reflection_closes_its_window_every_pass(self):
        text = read(os.path.join(KNOWHOW, "reflection.md"))
        self.assertIn("BrowserReflectionCompleted", text)
        self.assertIn("--until <until>", text)
        self.assertIn("knowhow/sites/index.md", text)

    def test_no_workspace_specific_paths(self):
        for name in ("observation.md", "reflection.md"):
            text = read(os.path.join(KNOWHOW, name))
            self.assertNotIn("ab.sh", text, name)
            self.assertNotIn("Sat", text, name)


if __name__ == "__main__":
    unittest.main()
