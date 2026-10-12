"""Shared test scaffolding: a throwaway workspace with a fake gatekeepr and a fake `lucidos`.

Every fixture is synthetic: no Appgate log, gateway host or address ever goes into this directory.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
SCRIPTS = os.path.normpath(os.path.join(HERE, "..", "..", "gatekeepr", "scripts", "gatekeepr"))
sys.path.insert(0, SCRIPTS)


def fixture(name):
    with open(os.path.join(FIXTURES, name)) as f:
        return json.load(f)


class Sandbox(unittest.TestCase):
    """Each test gets its own workspace, HOME and PATH. The fake gatekeepr is configured through settings.json's
    `binary_path` unless a test says otherwise, and nothing real is on PATH: no gatekeepr, and a `lucidos` that
    only records its calls."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="gk-test-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.bin = self._dir("bin")
        self.home = self._dir("home")
        self.workspace = self._dir("ws")
        self.state_dir = os.path.join(self.workspace, "data", "artifacts", "gatekeepr")
        os.makedirs(self.state_dir)
        self.fake = os.path.join(self.root, "fake-gatekeepr")
        os.symlink(os.path.join(HERE, "fake_gatekeepr.py"), self.fake)
        os.symlink(os.path.join(HERE, "fake_lucidos.py"), os.path.join(self.bin, "lucidos"))
        self.lucidos_log = os.path.join(self.root, "lucidos.log")
        self.gatekeepr_log = os.path.join(self.root, "gatekeepr.log")
        self.env = {
            # The interpreter's own directory, so the fakes' `#!/usr/bin/env python3` resolves.
            "PATH": os.pathsep.join([self.bin, os.path.dirname(sys.executable), "/usr/bin", "/bin"]),
            "HOME": self.home,
            "LUCIDOS_WORKSPACE": self.workspace,
            "FAKE_LUCIDOS_LOG": self.lucidos_log,
            "FAKE_GATEKEEPR_LOG": self.gatekeepr_log,
            "FAKE_GATEKEEPR_HISTORY": os.path.join(FIXTURES, "history.json"),
        }
        self.settings({"binary_path": self.fake})

    def _dir(self, name):
        path = os.path.join(self.root, name)
        os.makedirs(path)
        return path

    def settings(self, data):
        with open(os.path.join(self.state_dir, "settings.json"), "w") as f:
            json.dump(data, f) if isinstance(data, dict) else f.write(data)

    def status(self, name, **overrides):
        """Serve fixture `name` for `gatekeepr --json`, with fields replaced (None removes one)."""
        if name.endswith(".txt") or not overrides:
            self.env["FAKE_GATEKEEPR_STATUS"] = os.path.join(FIXTURES, name)
            return
        data = fixture(name)
        for key, value in overrides.items():
            if value is None:
                data.pop(key, None)
            else:
                data[key] = value
        path = os.path.join(self.root, "status-override.json")
        with open(path, "w") as f:
            json.dump(data, f)
        self.env["FAKE_GATEKEEPR_STATUS"] = path

    def history(self, name):
        self.env["FAKE_GATEKEEPR_HISTORY"] = os.path.join(FIXTURES, name)

    def read_state_file(self, name):
        with open(os.path.join(self.state_dir, name)) as f:
            return json.load(f)

    def lucidos_calls(self, since=0):
        if not os.path.exists(self.lucidos_log):
            return []
        with open(self.lucidos_log) as f:
            return [json.loads(line) for line in f.readlines()[since:]]

    def gatekeepr_calls(self):
        if not os.path.exists(self.gatekeepr_log):
            return []
        with open(self.gatekeepr_log) as f:
            return [line.strip() for line in f]

    def run_check(self, request=None, wrap=False, extra_env=None):
        """Run check.py as a trigger would. -> (lucidos calls made by this run, stdout)."""
        before = len(self.lucidos_calls())
        env = dict(self.env, **(extra_env or {}))
        if request is not None:
            env["TRIGGER_EVENT_TYPE"] = "GatekeeprRefreshRequested"
            env["TRIGGER_EVENT_PAYLOAD"] = json.dumps({"payload": request} if wrap else request)
        proc = subprocess.run([sys.executable, os.path.join(SCRIPTS, "check.py")], env=env,
                              capture_output=True, text=True, timeout=60, cwd=self.workspace)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return self.lucidos_calls(before), proc.stdout

    @staticmethod
    def notifications(calls):
        return [c for c in calls if c[:1] == ["notify"]]

    @staticmethod
    def events(calls):
        return [json.loads(c[c.index("--payload") + 1]) for c in calls if c[:2] == ["events", "emit"]]
