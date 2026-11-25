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

The page is built from stored per-Session accounts, not written in the Overview turn. While a
Session is Included in Overviews (ADR-0019) it keeps one **Overview Summary** of its whole work,
written by the model already serving that Session's turn — the Assistant preset's model when the
turn had no local text model — in a hidden **Overview Summary update** with its own context, no
tools, no chat message and no Session of its own. The update runs at the end of every turn, before
the turn finishes, so a finished turn has a current summary; the user waits for it as they would for
the turn's answer. The Overview agent's only judgement is translating the user's natural-language time
range into the range the app resolves. The app then takes every Included Session active in that
window, excludes the Session asking, and renders the fixed template from the stored summaries and
each Session's newest visual Artifact when the update judged that it still matches the summary. The
model supplies no summary and no markup for the page.

The window selects **which Sessions appear**, not what a card says: a card is the Session's own
account of itself, so it may describe work from outside the window, and the chrome says "Sessions
active …" rather than claiming what happened in the range. The file is a snapshot of those
summaries at ask time, not a view that stays current; re-asking rebuilds it from whatever summaries
exist then. A Session with no usable summary is omitted, and one whose summary is behind its last
turn is included with a footnote, so the page never silently invents or hides.

## Considered Options

- **A Journal surface in the app** — rejected. It needs navigation, tabs, a range picker, filters
  and localized chrome, and the result still has to leave the app to be shared, so the file would
  be built twice and drift.
- **The Overview agent writing the summaries per request** — rejected. Every ask paid for the same
  prose again, overlapping ranges never shared work, and the same Session read differently from one
  report to the next. A Session's account of itself belongs to the Session, not to a request.
- **A summary per time range inside each Session** — rejected. A Session would keep one account per
  window, and the Overview would still have to choose between them. One whole-Session account is
  what a card wants, and what makes the window a filter rather than a subject.
- **The model choosing which Sessions appear** — rejected. The opt-in and the window are the app's
  boundaries; a model that can omit an Included Session can silently hide work the user asked to
  see.
- **The model writing the markup** — rejected. A template enforced by a prompt drifts with the next
  model, and the report interpolates prompt-derived text from many Sessions, so the agent would be
  the escaper: one pasted email becomes a script in a page served from the same origin as every
  other Workspace file.

## Consequences

The app window never renders an Overview; it opens in the system browser through the existing
`will-navigate` handling, so `aipg-media://` does not resolve inside it and pictures have to be
inlined rather than referenced. An Overview is not an Artifact — it is a file an agent's turn
wrote — so it does not appear in the gallery, and the Artifact definition keeps its narrow
image/video/3D/audio meaning. Discoverability is the preset's name and description; scheduled
Overviews, which the same tool makes a one-line Schedule, are the intended answer to that gap.

The page's cards are in each Session's own response language while the page's chrome follows the
reader, so a mixed-language page is expected. Summaries are local-model work: a panel media or
audio turn pays a model load to update one, and a cloud turn leaves the summary behind rather than
sending the Session's History Entries to a provider. Follow-ups that reshape prose — "make it
terser", "only the games", "add the failures" — are gone; the agent's only decision is the range.
The summary lives on the Session and is kept when the Session is opted out (ADR-0019); it is unused
while the switch is off and reused when the Session is included again, updated only for turns that
happened meanwhile. An Overview file already written keeps the copy the user chose to keep.
