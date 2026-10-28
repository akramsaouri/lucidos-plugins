---
name: Pulls config (artifacts/review-cockpit/config.json)
description: The one config file every Pulls rail and the Pulls app (review-cockpit) read — your GitHub login(s), the repos and owners to watch with their registered repo names, the GitHub credential, gh config dir and proxy, teammates, and the browser for Open PR. Covers the schema, defaults, how a token is picked per group, and how to check it. Load when writing or changing the Pulls config, when a Pulls sweep reports a missing token or an unwatched repo, or when adding a repo to Pulls.
---

# Pulls config

Pulls keeps everything that differs from one person to the next in one file,
`data/artifacts/review-cockpit/config.json`. The plugin's setup writes it. Every
script reads it through `data/scripts/pulls/pulls_config.py`, and the Pulls app reads
the same file with `lucidos.data.read('artifacts/review-cockpit/config.json')`. Nothing
else holds a repo, a login or a path: change a repo here and every rail and the app
follow on their next run.

All other Pulls state (findings, sweeps, lanes, drafts, avatars) lives beside it under
`data/artifacts/review-cockpit/`, never inside the plugin's own folders.

## Schema (`pulls/config/v1`)

```json
{
  "schema": "pulls/config/v1",
  "me": ["octo-dev"],
  "github": {
    "credential": "github",
    "gh_config_dir": "~/.config/gh",
    "proxy": "github"
  },
  "groups": [
    {
      "id": "acme",
      "label": "Acme",
      "owner": "acme-corp",
      "login": "octo-dev",
      "repos": [
        {
          "name": "storefront",
          "registered_repo": "storefront",
          "slug": "store",
          "local_path": "~/code/storefront",
          "conflict_style": "rebase",
          "auto_resolve_conflicts": false
        }
      ],
      "any_repo": false,
      "discovery": "search",
      "prep": true,
      "in_app_merge": false,
      "shipped_lane": false,
      "app_tagged": false
    }
  ],
  "team": {
    "reviewers": ["jane-doe", "sam-lee"],
    "teams_that_ask_me": []
  },
  "browser": { "app": null, "profile": null },
  "default_tab": "acme"
}
```

| Key | Meaning | Default |
|---|---|---|
| `me` | Every GitHub login that is you. A PR authored by any of them is yours (own-PR lane, never review-prepped); a review by any of them is your review. | required |
| `github.credential` | Name of a Lucidos credential holding a GitHub token (`api.github.com`). Scripts pass it to `gh` as `GH_TOKEN`. The engine gives a script a `CRED_*` only when the script's file names it, and the Pulls scripts declare `CRED_GITHUB`, so **name the credential `github`** or the scripts won't see it and fall back to `gh`. | none: use `gh` |
| `github.gh_config_dir` | The `gh` CLI config dir to resolve a login's token from when no credential is set: `gh auth token --user <login>`. | `~/.config/gh` |
| `github.proxy` | Name of a `data/config/apis.json` proxy for `https://api.github.com`. Only in-app Merge uses it. | none: Merge links to GitHub |
| `groups[]` | One per GitHub owner (org or user) and identity. Each group is one tab in Pulls and one review rail. | at least one |
| `groups[].id` / `label` | Tab id (`[a-z0-9-]`) and the label shown on it. | owner |
| `groups[].owner` | The GitHub org or user. | required |
| `groups[].login` | Which of `me` can see this owner. | first of `me` |
| `groups[].gh_config_dir` | Per-group override, for an org only a second account can see (say, a SAML-gated work org): that login's `gh` config dir. A group whose login differs from the credential's account should leave `github.credential` unset and rely on `gh`. | `github.gh_config_dir` |
| `groups[].repos[].name` | GitHub repo name, without the owner. | required |
| `groups[].repos[].registered_repo` | The repo's name in Lucidos' registered repositories (`lucidos repositories list`), the name a coding agent spawns into. | `name` |
| `groups[].repos[].slug` | Short artifact slug, used in file names such as `findings/<slug>-<pr>-<sha7>.json`. | `name` |
| `groups[].repos[].local_path` | The local clone, when the registered repository can't say. The conflict resolver checks it for stranded worktrees. | registered repo path |
| `groups[].repos[].conflict_style` | `rebase` (rebase + force-push-with-lease) or `merge` (merge the base in + plain push). Use `merge` on a repo whose settings deny force-push. | `rebase` |
| `groups[].repos[].auto_resolve_conflicts` | Start the conflict resolver on your own PRs here as soon as GitHub reports a conflict. | `false` |
| `groups[].any_repo` | Also show review requests from any other repo of this owner. Those PRs show in Pulls but are never review-prepped. | `false` |
| `groups[].discovery` | `search`: find PRs with `review-requested:@me` / `mentions:@me` (scales to big repos). `list`: list each repo's open PRs (no search-index lag; best for small, fast repos). Either way the per-PR request check is the gate. | `search` |
| `groups[].prep` | Run the deep review prep on PRs here that you are asked to review. | `true` |
| `groups[].in_app_merge` | Merge from inside Pulls through `github.proxy`, after a live pre-flight (open, not draft, same head, clean, checks green, approved on this head). Needs `github.proxy`. | `false` |
| `groups[].shipped_lane` | Show a "Shipped by me" lane (your merges in the last 7 days) on this tab. | `false` |
| `groups[].app_tagged` | Tag each row with its repo name, for an owner whose repos are separate apps. | `false` |
| `team.reviewers` | Teammates' logins. Pulls shows them by name in "waiting on" and in the merged-without-you lane. | `[]` |
| `team.teams_that_ask_me` | GitHub team slugs whose review request counts as asking you. By default a team request is the unassigned pool, not an ask, since CODEOWNERS catch-alls put one on every PR. | `[]` |
| `browser.app` / `browser.profile` | Open PR uses `open -na "<app>" --args --profile-directory="<profile>"` when both are set, `open -a "<app>"` with just the app, and the system default browser otherwise. | default browser |
| `default_tab` | The tab Pulls opens on a device that never picked one. `all` is the union. | first group |

## Rules

- **The token decides the identity.** A gh config dir holds an account list and a
  pointer to the active one, which `gh auth switch` flips. Scripts therefore pass the
  named login's token as `GH_TOKEN`, from the `github` credential or from
  `gh auth token --user <login>`. The credential holds ONE account's token, so set it
  only when every group's login is that account. A login with no token is a hard, named error; nothing
  falls back to whatever account happens to be active. GitHub answers a private repo
  the token can't see with 404, so a wrong identity otherwise looks like a deleted repo.
- **A repo Pulls doesn't list gets no write button.** Prep, Resolve conflicts and Ask
  read the same lists the app does, so the app never offers a button the trigger then
  refuses. An `any_repo` repo shows, read-only.
- **Keep every key you don't change** when you edit the file.

## Checking it

```sh
python3 "$LUCIDOS_WORKSPACE/data/scripts/pulls/pulls_config.py"
```

It is read-only. It prints each identity with `token ok` or `NO TOKEN` and the repos
each group watches, and exits non-zero when the config is missing or a token is.
