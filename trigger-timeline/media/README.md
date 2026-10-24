# Cadence

Once a workspace has a lot of scheduled triggers, an agenda of them turns to noise. An hourly job is thirty
entries a day, and the one trigger that fires at nine sits buried under it. Cadence is an agenda for your
triggers that stays readable at that size, by treating a job on a steady loop as one fact about the day rather
than a row per fire.

## What you get

- **Running on a loop**: any trigger that fires 8 or more times a day folds out of the agenda into one band, one
  row each with a 24-hour density sparkline. Click a row to see its next fire times. Only triggers with a real
  time of day get timeline entries.
- **An agenda you can read**: fires in the same minute stack into one row. Days fold to a named preview with a
  density strip. Switch the window between 24 hours, 48 hours and 7 days.
- **Failed runs on top**: an attention rail at the top names every trigger whose last run failed, and the
  trigger's row carries a warning too.
- **Event-driven and Paused**: triggers with no fixed time, which fire when their event does, get their own
  section with what they listen for and when they last ran. Paused triggers get one too.
- **Finding things**: filter by name, or by trigger group once your triggers sit in more than one. Which groups
  you've switched off stays switched off.
- **A Home widget**: the Cadence widget counts down to the next trigger with a real time of day, names it, and
  lists the fires after it. Triggers on a loop are counted rather than listed, and failed last runs are flagged. A
  tap opens Cadence.
- **Read-only**: Cadence projects your existing cron expressions forward and never creates, edits, pauses or runs
  a trigger.

## What it needs

- Lucidos 0.48.0 or later (the first release that installs a plugin's widget).
- Nothing else: no other plugin, no account, no CLI. It reads your workspace's triggers through Lucidos itself.
- Some triggers to look at. With none, it has nothing to show.

## What setup asks for

Nothing. Cadence needs no setup and creates no triggers, since it only observes yours. After install, Lucidos
mentions two things once and stops: where a trigger that fires every hour went (the loop band), and that your view
settings are kept in the workspace.

## How it works

Each trigger's cron expressions are projected forward across the window you picked. A trigger with its own time
zone is projected in that zone, and one without is projected in your device's. The view refreshes when triggers
change and when you come back to the tab.

The window you picked, which groups are switched off and which sections are folded are saved to
`artifacts/trigger-timeline/state.json` in your workspace, so they survive a reload and are the same on every
device. That file is all Cadence ever writes.

## Try first

Open Cadence. Look in *Running on a loop* for a trigger you expected in the agenda, then click its row to see its
next fire times. Then switch the window from 24h to 7d to see the week.
