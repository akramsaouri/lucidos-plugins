#!/usr/bin/env python3
"""Checks a change to this marketplace before it merges.

1. A plugin whose files changed must bump the version in its manifest.toml.
   Without the bump, installed copies report "Already at latest" and never
   receive the change.
2. No build output is committed (__pycache__/, *.pyc, node_modules/, .venv/).
   The engine would install it into every workspace that installs the plugin.
3. Every manifest.toml parses as TOML. The engine refuses a plugin whose
   manifest does not parse, so it can be neither installed nor updated.

Usage: check_plugins.py <base-sha> <head-sha>
"""
import re
import subprocess
import sys
import tomllib

BUILD_OUTPUT = re.compile(r"(^|/)(__pycache__|node_modules|\.venv)(/|$)|\.py[co]$")
SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


class BadManifest(Exception):
    pass


def manifest_at(sha, plugin):
    try:
        text = git("show", f"{sha}:{plugin}/manifest.toml")
    except subprocess.CalledProcessError:
        return None
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        raise BadManifest(f"{plugin}/manifest.toml does not parse: {e}") from None


def semver_key(version):
    m = SEMVER.match(version or "")
    if not m:
        return None
    major, minor, patch, pre = m.groups()
    # A release sorts after any pre-release of the same version.
    pre_key = (1,) if pre is None else (0, *[(0, int(p)) if p.isdigit() else (1, p) for p in pre.split(".")])
    return (int(major), int(minor), int(patch), pre_key)


def main():
    base, head = sys.argv[1], sys.argv[2]
    if not base or set(base) == {"0"}:
        print("No base commit (new branch). Nothing to compare.")
        return 0

    errors = []
    changed = [p for p in git("diff", "--name-only", f"{base}...{head}").splitlines() if p]

    tree = git("ls-tree", "-r", "--name-only", head).splitlines()
    for path in tree:
        if BUILD_OUTPUT.search(path):
            errors.append(f"{path}: build output is committed. Remove it; .gitignore covers it.")

    # Every manifest must parse, changed or not: a broken one blocks install and update.
    broken = set()
    for path in tree:
        if path.count("/") == 1 and path.endswith("/manifest.toml"):
            plugin = path.split("/", 1)[0]
            try:
                manifest_at(head, plugin)
            except BadManifest as e:
                errors.append(str(e))
                broken.add(plugin)

    plugins = sorted({p.split("/", 1)[0] for p in changed if "/" in p})
    for plugin in plugins:
        if plugin in broken:
            continue  # already reported above
        new = manifest_at(head, plugin)
        if new is None:
            continue  # not a plugin directory (e.g. .github), or the plugin was removed
        try:
            old = manifest_at(base, plugin)
        except BadManifest:
            old = None  # the base was broken; any valid version now is a fix
        if old is None:
            print(f"{plugin}: new plugin at {new.get('version')}.")
            continue
        old_v, new_v = old.get("version"), new.get("version")
        new_key, old_key = semver_key(new_v), semver_key(old_v)
        if new_key is None:
            errors.append(f"{plugin}: version {new_v!r} in manifest.toml is not semver.")
        elif old_key is not None and new_key <= old_key:
            errors.append(
                f"{plugin}: files changed but manifest.toml version is {new_v} "
                f"(was {old_v}). Bump it, or installed copies never get the change."
            )
        else:
            print(f"{plugin}: {old_v} -> {new_v}")

    for e in errors:
        print(f"::error::{e}")
    if errors:
        return 1
    print("All plugin checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
