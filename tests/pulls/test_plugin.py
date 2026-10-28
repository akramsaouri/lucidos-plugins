"""The Pulls plugin: the app, its rails and one config file instead of anyone's repos, logins or paths."""
import hashlib
import importlib.util
import json
import os
import py_compile
import re
import subprocess
import sys
import tempfile
import tomllib
import unittest

# Importing the plugin's scripts must not leave __pycache__ in the plugin tree.
sys.dont_write_bytecode = True

PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "pulls")
TRIGGERS = os.path.join(PLUGIN, "triggers")


def read(path):
    with open(path) as f:
        return f.read()


def plugin_files():
    for root, dirs, files in os.walk(PLUGIN):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for name in files:
            yield os.path.join(root, name)


class ManifestTest(unittest.TestCase):
    def setUp(self):
        self.m = tomllib.loads(read(os.path.join(PLUGIN, "manifest.toml")))
        self.setup = re.sub(r"\s+", " ", self.m["setup"])

    def test_the_manifest(self):
        self.assertEqual((self.m["id"], self.m["name"]), ("pulls", "Pulls"))
        self.assertEqual(self.m["source"], "https://github.com/akramsaouri/lucidos-plugins/tree/main/pulls")
        self.assertEqual(self.m["engine"], ">=0.52.1")
        self.assertEqual(self.m["categories"], ["developer-tools", "productivity"])
        # Past the widget-only 0.1.x, so installed copies receive the app.
        self.assertGreater(tuple(int(p) for p in self.m["version"].split(".")), (0, 1, 1))

    def test_it_says_schedules_are_offered_at_setup(self):
        self.assertRegex(self.m["description"], r"offers the cron schedules")

    def test_setup_offers_every_sweep_on_a_shipped_script(self):
        for script in ("triggers/review-prep-work-prs/scripts/detect.py", "triggers/review-prep-work-prs/scripts/queue.py",
                       "triggers/review-prep-work-prs/scripts/mine.py", "triggers/pr-recall-merge-watch/scripts/detect.py"):
            self.assertIn(script, self.setup)
            self.assertTrue(os.path.exists(os.path.join(PLUGIN, script)), script)

    def test_setup_covers_identity_repos_skills_grants_and_proof(self):
        for must in ("request_credential", "manage_repositories", "artifacts/review-cockpit/config.json",
                     "pr-lanes", "pr-check", "pr-recall", "~/.claude/workflows/review-prep.js",
                     "Use cloud CLIs", "PrStatusRefreshRequested", "review-cockpit"):
            self.assertIn(must, self.setup)


class TriggersTest(unittest.TestCase):
    def test_every_trigger_is_event_driven_and_runs_a_shipped_file(self):
        found = 0
        for slug in sorted(os.listdir(TRIGGERS)):
            path = os.path.join(TRIGGERS, slug, "trigger.toml")
            if not os.path.exists(path):
                continue
            found += 1
            t = tomllib.loads(read(path))
            self.assertEqual(t["slug"], slug)
            self.assertNotIn("schedule", t, slug)
            self.assertNotIn("group_id", t, slug)
            self.assertTrue(t["on"], slug)
            if t["run"]["type"] == "script":
                self.assertTrue(os.path.exists(os.path.join(PLUGIN, t["run"]["path"])), slug)
        self.assertEqual(found, 11)

    def test_every_script_compiles(self):
        for path in plugin_files():
            if path.endswith(".py"):
                with tempfile.TemporaryDirectory() as tmp:
                    py_compile.compile(path, cfile=os.path.join(tmp, "x.pyc"), doraise=True)

    def test_each_entry_script_declares_the_github_credential(self):
        # The engine hands a script a CRED_* only when the script's own file names it.
        for rel in ("review-prep-work-prs/scripts/detect.py", "review-prep-work-prs/scripts/queue.py",
                    "review-prep-work-prs/scripts/mine.py", "refresh-pr-status-on-demand/scripts/run.py",
                    "prep-a-pr-for-review-on-demand/scripts/run.py", "ask-about-a-pr-on-demand/scripts/run.py",
                    "resolve-pr-conflicts/scripts/run.py", "resolve-pr-conflicts/scripts/check_worktree.py",
                    "pr-recall-merge-watch/scripts/detect.py"):
            self.assertIn("# lucidos-credentials: CRED_GITHUB", read(os.path.join(TRIGGERS, rel)), rel)


class NothingPersonalTest(unittest.TestCase):
    # The author's own orgs, repos, people and tools, as hashed tokens so this public test names none of
    # them: sha256(token)[:16], tokens split both on [a-z0-9]+ and on [a-z0-9_-]+.
    BANNED = {
        "066be4e8c3cc1006", "38f95d245052d370", "3b0b7dc732a58099", "64256dca84b0825c", "6b7db3c2d08a5a0b",
        "8cb1deaa7eec3a65", "bad5b17ee1186864", "be6ca9cca98cd32d", "c7cd08b58c0d73a4", "d4c16184e6ee6688",
        "da351c381199cd5d", "f8d593fbe57b4730", "fa948e3350fed16b", "faadc7625be7e89d",
    }
    MACHINE = re.compile(r"/Users/|/home/|super\.engineering")

    def banned_in(self, line):
        low = line.lower()
        tokens = set(re.findall(r"[a-z0-9]+", low)) | set(re.findall(r"[a-z0-9_-]+", low))
        return sorted(t for t in tokens if hashlib.sha256(t.encode()).hexdigest()[:16] in self.BANNED)

    def test_no_owner_login_person_or_machine_path_ships(self):
        for path in plugin_files():
            for n, line in enumerate(read(path).splitlines(), 1):
                if path.endswith("manifest.toml") and line.startswith("source = "):
                    continue
                where = f"{os.path.relpath(path, PLUGIN)}:{n}"
                self.assertEqual(self.banned_in(line), [], where)
                self.assertNotRegex(line, self.MACHINE, where)

    def test_no_avatar_or_findings_ship(self):
        for path in plugin_files():
            rel = os.path.relpath(path, PLUGIN)
            self.assertFalse(rel.startswith(("artifacts", "apps/review-cockpit/avatars")), rel)


def load_config_module(workspace):
    os.environ["LUCIDOS_WORKSPACE"] = workspace
    spec = importlib.util.spec_from_file_location(
        "pulls_config_under_test", os.path.join(PLUGIN, "scripts", "pulls", "pulls_config.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


DEMO = {
    "me": ["octo-dev"],
    "github": {"credential": "github", "proxy": "github"},
    "groups": [
        {"id": "acme", "owner": "acme-corp", "discovery": "list", "in_app_merge": True,
         "repos": [{"name": "storefront", "slug": "store", "conflict_style": "merge"}, "api"]},
        {"id": "labs", "owner": "octo-labs", "login": "octo-dev", "any_repo": True, "prep": False,
         "gh_config_dir": "~/.config/gh-labs"},
    ],
}


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "data", "artifacts", "review-cockpit")
        os.makedirs(self.state)
        self.saved = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.saved)
        self.tmp.cleanup()

    def write(self, cfg):
        with open(os.path.join(self.state, "config.json"), "w") as f:
            json.dump(cfg, f)
        return load_config_module(self.tmp.name)

    def test_a_missing_config_names_the_fix(self):
        c = load_config_module(self.tmp.name)
        with self.assertRaisesRegex(c.ConfigError, "setup"):
            c.load()

    def test_state_lives_under_artifacts_review_cockpit(self):
        c = self.write(DEMO)
        self.assertEqual(c.state_dir(), self.state)

    def test_rails_mirror_the_groups(self):
        c = self.write(DEMO)
        acme, labs = c.rails()
        self.assertEqual(acme["repos"], {"storefront": ("storefront", "store"), "api": ("api", "api")})
        self.assertIsNone(acme["queries"])  # list discovery
        self.assertEqual(acme["exclude_authors"], ["octo-dev"])
        self.assertFalse(labs["prep"])
        self.assertIn("org:octo-labs", labs["queries"][0])
        self.assertEqual(labs["gh_config_dir"], "~/.config/gh-labs")

    def test_repo_lookup(self):
        c = self.write(DEMO)
        r = c.repo("acme-corp/storefront")
        self.assertEqual((r["registered_repo"], r["slug"], r["conflict_style"], r["prep"]),
                         ("storefront", "store", "merge", True))
        # An any_repo owner's unlisted repo shows, but never gets a write rail.
        r = c.repo("octo-labs/thing")
        self.assertEqual((r["listed"], r["prep"]), (False, False))
        self.assertIsNone(c.repo("someone/else"))

    def test_the_credential_wins_and_the_ambient_account_never_does(self):
        c = self.write(DEMO)
        os.environ["CRED_GITHUB"] = "demo-token"
        self.assertEqual(c.token_for("octo-dev", None, "github"), "demo-token")
        os.environ.pop("CRED_GITHUB")
        os.environ["GH_TOKEN"] = "ambient"
        os.environ["PATH"] = self.tmp.name  # no gh on PATH
        self.assertIsNone(c.token_for("octo-dev", "~/.config/none", "github"))

    def test_agent_identity_lines_use_no_command_substitution(self):
        c = self.write(DEMO)
        lines = c.shell_identity(c.repo("acme-corp/storefront"))
        self.assertNotIn("$(", lines)
        self.assertIn("gh api user --jq .login", lines)


class OpenPrTest(unittest.TestCase):
    def test_the_browser_comes_from_the_config(self):
        sys.path.insert(0, os.path.join(PLUGIN, "scripts", "pulls"))
        spec = importlib.util.spec_from_file_location(
            "open_pr_under_test", os.path.join(TRIGGERS, "open-pr-in-browser", "scripts", "run.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        url = "https://github.com/acme-corp/storefront/pull/1"
        self.assertEqual(mod.command(url, None, None), ["open", url])
        self.assertEqual(mod.command(url, "Firefox", None), ["open", "-a", "Firefox", url])
        self.assertEqual(mod.command(url, "Google Chrome", "Profile 1"),
                         ["open", "-na", "Google Chrome", "--args", "--profile-directory=Profile 1", url])


class AppTest(unittest.TestCase):
    def setUp(self):
        self.page = read(os.path.join(PLUGIN, "apps", "review-cockpit", "index.html"))

    def test_it_reads_the_shared_config(self):
        self.assertIn("const CONFIG_PATH = 'artifacts/review-cockpit/config.json';", self.page)
        self.assertIn("await loadConfig();", self.page)

    def test_no_button_emits_into_a_rail_that_does_not_ship(self):
        # Address comments' rail isn't in this plugin: the button needs a live trigger.
        self.assertRegex(self.page, r"LISTENED\.has\('PrCommentResolutionRequested'\)")
        for ev in ("PrConflictResolutionRequested", "ReviewPrepManualRequested"):
            self.assertIn(f"listens('{ev}')", self.page)

    def test_the_script_parses(self):
        js = "\n;\n".join(re.findall(r"<script(?![^>]*src)[^>]*>(.*?)</script>", self.page, re.S))
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
            f.write(js)
        try:
            r = subprocess.run(["node", "--check", f.name], capture_output=True, text=True)
        except FileNotFoundError:
            self.skipTest("node is not installed")
        finally:
            os.unlink(f.name)
        self.assertEqual(r.returncode, 0, r.stderr[:500])


if __name__ == "__main__":
    unittest.main()
