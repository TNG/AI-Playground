---
status: accepted
amends: the Agent Run folders and the rejected "Letting an Agent override the Workspace" in ADR-0013
---

# An Agent overrides its Session's folders instead of adding to them

An Agent Run used to work in its Session's Workspace with the Agent's own Mounted Folders mounted
beside it. The model works in its working directory, so folders it was not pointed at went mostly
unused, and an Agent built around a project folder still wrote into whatever the Session had
starred. An Agent now inherits its Session's folders and may override either part: its Workspace
(the working directory and where its Artifacts land) and its other folders (which then replace the
Session's). An override applies only while that Agent is active in that Session; the Session's own
list and star are left untouched underneath.

ADR-0013 rejected an Agent-owned Workspace because a run's output would land somewhere other than
the folder the user was looking at. That is answered by the chip: while an Agent is active it shows
only what is in effect, so an overridden Workspace is the one the chip names.

## Considered Options

- **Keep additional folders, add a Workspace override on top**: rejected because the additive list
  is what made Agent folders go unused, and two ways of giving an Agent a folder are one too many.
- **One override for everything (Agent's own starred list)**: rejected because the common case is
  "work in this project folder" while still reaching what the Session was given, which needs the
  two parts to be independent.
- **Mark overridden folders in the chip ("Agent" badge) next to the Session's**: rejected; the chip
  shows what the turn will actually use, nothing else.

## Consequences

An Agent's Workspace override is registered in the Session as an entry owned by that Agent, so
Artifacts made in it keep a folder reference and stay in the History when the Agent is not active. A
Workspace override that inherits the Session's other folders also mounts the Session's own
Workspace read-write, so History paths into it keep working. A Trial Run with a Workspace override
writes into that real folder; only the scratch folder is thrown away. Existing Agents' additional
folders are dropped on upgrade, and every Agent starts inheriting both parts.
