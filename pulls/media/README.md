# Pulls

A Home widget for the Pulls app: the number of pull requests on you right now, counted the way Pulls counts
them, so the tile matches its badge.

## What you get

- **The number on you**, split three ways, most urgent first: your own PRs blocked on you (unresolved comments,
  merge conflicts, failing CI, a review to re-request), other people's PRs waiting on your review, and your PRs
  ready to merge. Your other open PRs show as waiting on someone else.
- **A tile for each Home board size**: small shows the number and the most urgent bucket, medium adds the
  breakdown, large adds the top PRs. Inline in a thread it shows everything.
- **Live**: it re-reads when a Pulls sweep writes, and a tap opens the Pulls app.

## What it needs

- **The Pulls app (`review-cockpit`)**, installed in the same workspace. This plugin ships only the widget, not
  the app. The widget reads what the app's sweeps write, `artifacts/review-cockpit/my-prs.json` and
  `review-queue.json`, and has nothing to show without them. Without the app it says "Pulls app not
  installed", and before the first sweep it says "Pulls has no data yet".
- Lucidos 0.48.0 or later.

## Try first

Pin **Pulls** to Home from the board's Add, then tap it to open the Pulls app.
