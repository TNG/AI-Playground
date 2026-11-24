---
status: accepted
---

# An Overview is a file in the Workspace, not a surface in the app

The user wanted to see what happened across Sessions in a time range, and had already got it
working by hand: every interested Session wrote a log line and its newest result into a mounted
folder, and a second Session turned that folder into an HTML dashboard. The obvious build is the
other half of that workaround — a Journal view over the ledger. We chose instead an agent preset
whose turn writes one self-contained HTML file into its own Workspace, and whose answer links to
it, so the browser the link opens in is the only reader. The ledger already holds what the
workaround was reconstructing, and a file is what the user actually wanted to keep and share.

The report is produced by code, not by the model: the `overview` capability's tool resolves the
range, reads the History Entries of the Sessions included in Overviews (see ADR-0019), and renders
a fixed template, escaping what it interpolates. The agent supplies only the opening paragraph and
which picture represents each Session, both of which are judgement rather than layout. Nothing is
stored but the file, so an Overview cannot go stale and re-asking is the refresh.

## Considered Options

- **A Journal surface in the app** — rejected. It needs navigation, tabs, a range picker, filters
  and localized chrome, and the result still has to leave the app to be shared, so the file would
  be built twice and drift.
- **The app generating the file with no agent** — rejected. "What happened since Monday" is a
  natural-language range, and follow-ups ("only the games, add the failures") are the feature.
- **The model writing the markup** — rejected. A template enforced by a prompt drifts with the next
  model, and the report interpolates prompt text from many Sessions, so the agent would be the
  escaper: one pasted email becomes a script in a page served from the same origin as every other
  Workspace file.

## Consequences

The app window never renders an Overview; it opens in the system browser through the existing
`will-navigate` handling, so `aipg-media://` does not resolve inside it and pictures have to be
inlined rather than referenced. An Overview is not an Artifact — it is a file an agent's turn
wrote — so it does not appear in the gallery, and the Artifact definition keeps its narrow
image/video/3D/audio meaning. Discoverability is the preset's name and description; scheduled
Overviews, which the same tool makes a one-line Schedule, are the intended answer to that gap.
