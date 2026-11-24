---
status: accepted
---

# The Component Manager and the Setup Wizard share one panel

App Settings has a Component Manager tab that is still a placeholder, while the only way to install,
enable, repair or update a Component after first run is the Setup Wizard — reachable in a shipped
build only through App Settings → Advanced → Developer. Two implementations of the same list would
drift apart, so the wizard's components column is extracted into one shared panel: the wizard renders
it as a draft (choices install on "Install & Continue"), the Component Manager tab renders it live
(each action applies at once, with per-row install, update and repair). The shells stay separate
because their contracts differ: the wizard runs before the app can be used and cannot be a dialog,
while App Settings only exists once the app is running and must apply immediately.

## Considered Options

- **Embed the whole wizard as the tab**: rejected because its draft-and-apply footer is wrong for
  live settings, and the wizard's chrome (terms, language, first-run framing) does not belong in a
  settings tab.
- **Build a second implementation for the tab**: rejected because the two lists would drift.
- **Make App Settings the only manager and reduce the wizard to mode plus required installs**:
  rejected because optional Components are part of what first-run onboarding offers, and a new user
  should not have to reach running state to add them.

## Consequences

The tab becomes the home of Machine Settings the wizard used to own: Hardware Mode, the default GPU,
and every Component, with Channels and Hybrid Cloud setup embedded as sub-views rather than the app
being switched into the wizard. The header's setup button becomes a shortcut to the tab, the
Backend Status table in Advanced is retired, and the third-party terms notice moves with the panel
because installs can now start from Settings.
