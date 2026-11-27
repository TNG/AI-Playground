---
status: accepted
---

# Website screenshots split from Web debugging by power, not by page origin

Taking a screenshot of a page had become reliable, but only Web debugging could take one, and
Web debugging is opt-in for a reason: beside the harmless navigate-and-capture it also lets the
model run JavaScript on the page, read its console and drive a real browser. Turning it on by
default would hand every Session the dangerous parts to get at the safe one, so the safe part
is a capability of its own. **Website screenshots** is on by default like Files and shell,
Media generation, Document search and Web access, and contributes exactly one tool: give it a
URL — any http(s) page, or a page of the Session's own work in the Workspace — and it captures
the page, optionally at a chosen size or clipped to one element, saves the PNG into the
Workspace and shows it to the user as an Artifact. It can only navigate and capture; the split
is by that power, not by where the page lives. The user sees no difference: the flow that
shows a capture to the user is the one Web debugging already uses, shared so the two cannot
drift.

## Considered Options

- **Turn Web debugging on by default**: rejected because script execution and console reading
  are what its opt-in default is for; a Session should not get them just to show the user a
  pricing table.
- **Split by page origin** — public pages for everyone, Workspace pages kept behind Web
  debugging: rejected because the danger is what the model can do on the page, not which page
  it is; the same navigate-and-capture is safe for both, and a page the agent built is the one
  the user most wants to see.
- **A requirements edge from Web debugging to Website screenshots**: rejected because it would
  pull a second, redundant screenshot tool into every debugging session; the browser tool
  already captures.
- **Give Game Agent the new capability**: rejected for the same reason — it screenshots
  through its browser tool while play-testing, and a second tool beside it adds nothing.

## Consequences

A non-http(s) URL is refused by the tool, in code rather than by instruction: `file://` in the
hidden browser window would read local files outside the mounted-folder containment, so a
prompted model cannot render a file the Session never mounted. A Session with both
capabilities enabled has two ways to capture a page, and the overlap is accepted: the tool
descriptions disambiguate — debug the page, or show the user — and stripping one action
conditionally would couple the two. Both tools share the Harness Session's one hidden browser
window, which is no more interference than two open actions already produce. Games sessions
are unchanged: the checklist shows Website screenshots unticked there, honestly. Removing or
renaming the capability later strands nothing but an unticked checkbox in old session
records.
