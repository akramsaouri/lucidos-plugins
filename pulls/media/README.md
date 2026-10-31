# Pulls

Every pull request that's on you, in one place. Pulls answers the two morning questions side by side:
what's blocking my own PRs, and who is waiting on my review. For each PR you're asked to review, a
read-only multi-agent review has usually already run, so the findings are waiting when you open it.

## What you get

- **Mine**: your open PRs, most blocked first, each with the one reason it's stuck: a merge conflict,
  unanswered review comments (read across all three of GitHub's comment surfaces), failing CI, a reviewer
  to re-request after you pushed, or ready to merge.
- **Reviews**: the PRs someone actually asked you to review (a named request, an @-mention, or a PR you
  already reviewed that got a new push), not every open PR and not CODEOWNERS team noise. Once you've had
  your say on a head it moves to "answered" until the author pushes again.
- **Review prep**: a deep, read-only review of each requested PR at its exact head: parallel finders, one
  adversarial verifier per location, the repo's own CI checks, and refuted findings kept with their
  evidence. Pick findings and Pulls composes one submitted review for you to paste. It never posts for you.
- **Quick reads**: a lanes triage of each PR, and the skills it recommends (why, story, behaviour, a quiz),
  on your own PRs too.
- **Buttons**: resolve a conflict with a coding agent (rebase or merge, per repo), ask a coding agent a
  question about a finding or a whole PR, get quizzed or drilled on a PR, refresh status, open the PR in
  the browser you choose, and optionally merge from the row after a live pre-flight.
- **Recall cards**: when a PR you reviewed merges, a few one-line cards on how the code works now, flagged
  the next time a PR touches the same code.
- **One tab per GitHub owner**, each read as the login that can see it, and a Home widget counting what's
  on you.

## What it needs

- The `gh` CLI, logged in as each GitHub account you use.
- Local clones of the repos you watch. Setup registers them as Lucidos repositories.
- Claude Code with the pr-understanding skills from the skillz marketplace (pr-lanes, pr-summary,
  pr-intent, pr-story, pr-behaviour, pr-check, pr-recall). Setup checks for them and says what's missing.
- Lucidos 0.52.1 or later.

Setup asks for your GitHub login and the repos to watch, writes them to one config file, and offers the
schedules (the PR watch and the status, queue and recall sweeps) on your own cadence. Plugins can't ship
schedules, so without them Pulls only updates when you press Refresh.

## Try first

Open Pulls after setup and press **Refresh**. Then press **Prep** on a review card to queue its review now
instead of waiting for the next watch.
