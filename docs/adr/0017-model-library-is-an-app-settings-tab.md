---
status: proposed
---

# The Model Library is a tab of App Settings, not a Library over the Session

The Model Library was a full-screen overlay opened over whatever Session was showing, a sibling of
the Agent Library, because its nine-column table did not fit anywhere smaller. App Settings already
had a placeholder Model Library tab, and two homes for one thing drift apart, so the overlay is
retired and the tab becomes its only home: App Settings grows for every tab, and models are shown
as rows of a list whose second line carries what the table spread over columns. The title-bar
model button stays as a shortcut that opens App Settings on that tab. While App Settings is open,
on any tab, the Session behind it is not In View, as it was not behind the overlay.

## Considered Options

- **Keep the overlay and mirror it in the tab**: rejected because two views of the same library
  would drift apart.
- **Keep the table inside the tab**: rejected after a prototype; it needs most of the screen and
  reads unlike every other settings tab.
- **Only the Model Library tab hides the Session**: rejected for one rule that holds on every tab
  of a dialog that now covers most of the window.

## Consequences

"Library" now means only the Agent Library, and at most one Library being open is no longer a rule
across two views. App Settings opens over the Agent Library and returns to it on close, as it
already did.
