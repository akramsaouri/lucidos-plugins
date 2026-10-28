#!/usr/bin/env python3
# lucidos-credentials: CRED_GITHUB
"""The one place Pulls learns who you are and which repos it watches.

Every Pulls script reads `data/artifacts/review-cockpit/config.json` through
this module, and the Pulls app reads the same file through `lucidos.data`. A
second copy of "which repos, which login" drifts from the first, and a rail
that disagrees with the app about identity either 404s or offers a button the
trigger then refuses. The schema is in `knowhow/pulls-config.md`.

Import it from a trigger script with:

    sys.path.insert(0, os.path.join(os.environ.get("LUCIDOS_WORKSPACE", ""),
                                    "data", "scripts", "pulls"))
    import pulls_config

THE IDENTITY RULE. A `gh` call is pinned to a named login by passing that
login's token as `GH_TOKEN`, which outranks the active-account pointer in the
gh config dir's `hosts.yml`. A config dir picks an account LIST; only the token
picks the account. Anything that flips the pointer (`gh auth switch`, a fresh
`gh auth login`) would otherwise silently re-point every rail sharing the dir,
and GitHub answers a private repo the token can't see with 404, which reads as
"repo deleted" rather than "wrong identity". So a missing token is a hard,
named error here; it never falls back to the ambient account.

The token comes from, in order:
  1. the Lucidos credential `github.credential` names, when it is set and the
     engine injected it. The engine hands a script a `CRED_*` only when the
     script's own file names it, so every Pulls entry script declares
     `# lucidos-credentials: CRED_GITHUB`: the credential must be called
     `github` to reach them;
  2. `gh auth token --user <login>` in the group's or global `gh_config_dir`.
"""
import json
import os
import re
import subprocess

SCHEMA = "pulls/config/v1"
REL_DIR = "artifacts/review-cockpit"
REL_CONFIG = REL_DIR + "/config.json"
DEFAULT_GH_CONFIG_DIR = "~/.config/gh"
CONFLICT_STYLES = ("rebase", "merge")


class ConfigError(Exception):
    """config.json is missing or malformed. The message says what to fix."""


def workspace():
    ws = os.environ.get("LUCIDOS_WORKSPACE", "").rstrip("/")
    if not ws:
        raise ConfigError("$LUCIDOS_WORKSPACE is unset, so the Pulls config can't be found")
    return ws


def state_dir():
    """`data/artifacts/review-cockpit/`, where every piece of Pulls state lives."""
    return os.path.join(workspace(), "data", REL_DIR)


def config_path():
    return os.path.join(workspace(), "data", REL_CONFIG)


_CACHE = {}


def load(path=None):
    """The parsed, normalised config. Raises ConfigError with a fix-it message."""
    path = path or config_path()
    if path in _CACHE:
        return _CACHE[path]
    try:
        with open(path) as f:
            raw = json.load(f)
    except FileNotFoundError:
        raise ConfigError(f"{REL_CONFIG} doesn't exist yet: run the Pulls plugin setup to write it")
    except (OSError, ValueError) as e:
        raise ConfigError(f"{REL_CONFIG} can't be read: {e}")
    cfg = normalise(raw)
    _CACHE[path] = cfg
    return cfg


def _slug(s):
    return re.sub(r"[^a-z0-9-]+", "-", str(s).lower()).strip("-")


def normalise(raw):
    """Fill defaults and check the shape, so callers never test for a missing key."""
    if not isinstance(raw, dict):
        raise ConfigError(f"{REL_CONFIG} must hold a JSON object")
    me = raw.get("me") or []
    if isinstance(me, str):
        me = [me]
    if not me:
        raise ConfigError(f"{REL_CONFIG} names no GitHub login in `me`")
    gh = raw.get("github") or {}
    github = {
        "proxy": gh.get("proxy") or None,
        "credential": gh.get("credential") or None,
        "gh_config_dir": gh.get("gh_config_dir") or DEFAULT_GH_CONFIG_DIR,
    }
    groups = []
    for g in raw.get("groups") or []:
        owner = g.get("owner")
        if not owner:
            raise ConfigError(f"a group in {REL_CONFIG} has no `owner`")
        gid = _slug(g.get("id") or owner)
        login = g.get("login") or me[0]
        repos = []
        for r in g.get("repos") or []:
            if isinstance(r, str):
                r = {"name": r}
            name = r.get("name")
            if not name:
                raise ConfigError(f"a repo in group {gid} has no `name`")
            name = name.split("/")[-1]
            style = r.get("conflict_style") or "rebase"
            if style not in CONFLICT_STYLES:
                raise ConfigError(f"{owner}/{name}: conflict_style must be rebase or merge, not {style!r}")
            repos.append({
                "name": name,
                "full": f"{owner}/{name}",
                "registered_repo": r.get("registered_repo") or name,
                "slug": _slug(r.get("slug") or name),
                "local_path": r.get("local_path") or None,
                "conflict_style": style,
                "auto_resolve_conflicts": bool(r.get("auto_resolve_conflicts", False)),
            })
        discovery = g.get("discovery") or "search"
        if discovery not in ("search", "list"):
            raise ConfigError(f"group {gid}: discovery must be search or list, not {discovery!r}")
        groups.append({
            "id": gid,
            "label": g.get("label") or owner,
            "owner": owner,
            "login": login,
            "credential": github["credential"],
            "gh_config_dir": g.get("gh_config_dir") or github["gh_config_dir"],
            "repos": repos,
            "any_repo": bool(g.get("any_repo", False)),
            "discovery": discovery,
            "prep": bool(g.get("prep", True)),
            "in_app_merge": bool(g.get("in_app_merge", False)) and bool(github["proxy"]),
            "shipped_lane": bool(g.get("shipped_lane", False)),
            "app_tagged": bool(g.get("app_tagged", False)),
        })
    if not groups:
        raise ConfigError(f"{REL_CONFIG} watches no repos: add a group with at least one repo")
    team = raw.get("team") or {}
    browser = raw.get("browser") or {}
    default_tab = raw.get("default_tab") or groups[0]["id"]
    return {
        "schema": raw.get("schema") or SCHEMA,
        "me": list(me),
        "github": github,
        "groups": groups,
        "team": {
            "reviewers": list(team.get("reviewers") or []),
            "teams_that_ask_me": list(team.get("teams_that_ask_me") or []),
        },
        "browser": {"app": browser.get("app") or None, "profile": browser.get("profile") or None},
        "default_tab": default_tab,
    }


# ---------- lookups ----------

def me(cfg=None):
    """Every login that is me, lowercased, for author and reviewer comparisons."""
    cfg = cfg or load()
    return {m.lower() for m in cfg["me"]}


def is_me(login, cfg=None):
    return bool(login) and login.lower() in me(cfg)


def groups(cfg=None):
    return (cfg or load())["groups"]


def group(gid, cfg=None):
    return next((g for g in groups(cfg) if g["id"] == gid), None)


def group_for_repo(full, cfg=None):
    """The group an `owner/repo` belongs to: listed in its repos, or under an any_repo owner."""
    if not full or "/" not in full:
        return None
    owner, name = full.split("/", 1)
    gs = groups(cfg)
    for g in gs:
        if any(r["full"].lower() == full.lower() for r in g["repos"]):
            return g
    for g in gs:
        if g["any_repo"] and g["owner"].lower() == owner.lower():
            return g
    return None


def repo(full, cfg=None):
    """Everything a rail needs about one `owner/repo`, or None when Pulls doesn't watch it.

    An any_repo owner's unlisted repo gets defaults: registered under its own
    name, slug = its name, rebase style, never auto-resolved.
    """
    g = group_for_repo(full, cfg)
    if not g:
        return None
    hit = next((r for r in g["repos"] if r["full"].lower() == full.lower()), None)
    if hit is None:
        name = full.split("/", 1)[1]
        hit = {"name": name, "full": f"{g['owner']}/{name}", "registered_repo": name,
               "slug": _slug(name), "local_path": None, "conflict_style": "rebase",
               "auto_resolve_conflicts": False, "listed": False}
    else:
        hit = {**hit, "listed": True}
    return {**hit, "group": g["id"], "login": g["login"], "credential": g["credential"],
            "gh_config_dir": g["gh_config_dir"], "prep": g["prep"] and hit["listed"]}


def repo_by_registered_name(name, cfg=None):
    """Reverse of the registered-repo mapping, for payloads that only carry it."""
    for g in groups(cfg):
        for r in g["repos"]:
            if r["registered_repo"] == name or r["name"] == name:
                return repo(r["full"], cfg)
    return None


def repo_by_slug(slug, cfg=None):
    for g in groups(cfg):
        for r in g["repos"]:
            if r["slug"] == slug:
                return repo(r["full"], cfg)
    return None


def identities(cfg=None):
    """Each distinct (login, gh_config_dir, credential) the groups use, with the owners it sees."""
    out = {}
    for g in groups(cfg):
        k = (g["login"], g["gh_config_dir"], g["credential"])
        ident = out.setdefault(k, {"name": g["login"], "login": g["login"],
                                   "gh_config_dir": g["gh_config_dir"],
                                   "credential": g["credential"], "owners": [], "groups": []})
        if g["owner"] not in ident["owners"]:
            ident["owners"].append(g["owner"])
        ident["groups"].append(g["id"])
    return list(out.values())


def rails(cfg=None):
    """The detector's view of each group: the shape detect.py and queue.py iterate.

    `repos` maps a GitHub repo name to (registered repo, artifact slug).
    `queries` is None for list discovery, or the search qualifiers scoped to
    the owner for search discovery: discovery only, never the gate.
    """
    cfg = cfg or load()
    out = []
    for g in groups(cfg):
        if g["discovery"] == "search" or g["any_repo"]:
            scope = f"org:{g['owner']}" if g["any_repo"] else " ".join(f"repo:{r['full']}" for r in g["repos"])
            queries = [f"is:open is:pr {scope} review-requested:@me", f"is:open is:pr {scope} mentions:@me"]
        else:
            queries = None
        out.append({
            "name": g["id"],
            "label": g["label"],
            "org": g["owner"],
            "repos": {r["name"]: (r["registered_repo"], r["slug"]) for r in g["repos"]},
            "any_repo": g["any_repo"],
            "prep": g["prep"],
            "gh_config_dir": g["gh_config_dir"],
            "credential": g["credential"],
            "queries": queries,
            "require_request": True,
            "me": g["login"],
            "exclude_authors": list(cfg["me"]),
        })
    return out


def browser(cfg=None):
    return (cfg or load())["browser"]


# ---------- identity ----------

def credential_env(name):
    """The env var the engine injects a Lucidos credential as: `CRED_<NAME>`."""
    return "CRED_" + re.sub(r"[^A-Z0-9]", "_", name.upper()) if name else None


_TOKENS = {}


def token_for(login, gh_config_dir=None, credential=None):
    """The token that acts as `login`, or None. Never the ambient account."""
    if credential:
        tok = os.environ.get(credential_env(credential), "").strip()
        if tok:
            return tok
    config_dir = gh_config_dir or DEFAULT_GH_CONFIG_DIR
    key = (config_dir, login)
    if key in _TOKENS:
        return _TOKENS[key]
    env = {**os.environ, "GH_CONFIG_DIR": os.path.expanduser(config_dir)}
    env.pop("GH_TOKEN", None)
    env.pop("GITHUB_TOKEN", None)
    try:
        r = subprocess.run(
            ["gh", "auth", "token", "--hostname", "github.com", "--user", login],
            env=env, capture_output=True, text=True, timeout=30,
        )
        tok = r.stdout.strip() if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        tok = None
    _TOKENS[key] = tok or None
    return _TOKENS[key]


def gh_env(login, gh_config_dir=None, credential=None):
    """Environment for a `gh` call pinned to `login`, or None if it can't be."""
    tok = token_for(login, gh_config_dir, credential)
    if not tok:
        return None
    return {**os.environ,
            "GH_CONFIG_DIR": os.path.expanduser(gh_config_dir or DEFAULT_GH_CONFIG_DIR),
            "GH_TOKEN": tok}


def gh_env_for(entry):
    """gh_env for anything carrying login / gh_config_dir / credential: a repo, group or identity."""
    return gh_env(entry["login"], entry.get("gh_config_dir"), entry.get("credential"))


def shell_identity(entry):
    """Prompt lines that pin a coding agent's `gh` to the entry's login.

    No `$(...)`: an unattended, trigger-rooted session has every command with a
    command substitution refused, so `GH_TOKEN=$(gh auth token ...)` can never
    run there. And `export` may not persist between the agent's shell calls, so
    each `gh` call carries the config dir as a prefix. The check makes a flipped
    active-account pointer a stop, never a silent wrong identity.
    """
    d = os.path.expanduser(entry.get("gh_config_dir") or DEFAULT_GH_CONFIG_DIR)
    login = entry["login"]
    return (f"Prefix EVERY gh call with GH_CONFIG_DIR={d} (an export may not persist between "
            f"your shell calls), and check it once first:\n"
            f"GH_CONFIG_DIR={d} gh api user --jq .login    # must print {login}\n"
            f"If it prints anything else, stop and report \"identity unpinned\". "
            f"Never run gh auth switch to fix it.")


def registered_path(name):
    """The local path of a registered repository, from `lucidos repositories list`, or None."""
    try:
        r = subprocess.run(["lucidos", "repositories", "list"], capture_output=True, text=True, timeout=30)
        for row in json.loads(r.stdout or "[]"):
            if row.get("name") == name and row.get("path"):
                return row["path"]
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return None


def missing_token_msg(login, gh_config_dir=None, credential=None):
    """What to print when gh_env returns None. Names the account, not the dir."""
    where = (f"the {credential} credential ({credential_env(credential)}) or " if credential else "")
    return (f"no GitHub token for {login}: checked {where}gh in "
            f"{gh_config_dir or DEFAULT_GH_CONFIG_DIR}. Is that account still logged in? "
            f"Check `gh auth status`, or re-run the Pulls setup")


if __name__ == "__main__":
    # `python pulls_config.py` checks the config and every identity, read-only.
    import sys
    try:
        c = load()
    except ConfigError as e:
        print(e, file=sys.stderr)
        sys.exit(1)
    bad = 0
    for ident in identities(c):
        ok = token_for(ident["login"], ident["gh_config_dir"], ident["credential"])
        print(f"{ident['login']}: {'token ok' if ok else 'NO TOKEN'} for {', '.join(ident['owners'])}")
        bad += not ok
    for g in c["groups"]:
        names = ", ".join(r["full"] for r in g["repos"]) or "(none listed)"
        print(f"[{g['id']}] {names}{' + any repo of ' + g['owner'] if g['any_repo'] else ''}")
    sys.exit(1 if bad else 0)
