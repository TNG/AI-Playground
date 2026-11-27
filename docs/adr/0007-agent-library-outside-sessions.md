---
status: accepted
supersedes: the Agents tab and in-Session editing in ADR 0005
---

# Agents are made, scheduled and tried in an Agent Library outside every Session

ADR 0005 made an Agent independent of the Session it was made in, but editing still happened
inside one: loading an Agent wrote its Steps and Settings Template into an Agent Maker Session, the
Inferencing tab then edited the Agent instead of the Session, and saving went back through the
Agents tab. Users could not tell which settings they were changing. Agents are now created,
edited, scheduled and tried out in the Agent Library, an overlay opened over whatever Session is
showing, which belongs to no Session and loses nothing when closed. Edits form a Draft that only
Trial Runs use until it is saved; a Trial Run belongs to no Session and is thrown away when the
next one starts. Inside a Session an Agent is picked from the prompt bar's agent list, beside but
apart from the Agent Presets, and its settings show read-only there. Sessions have no Agents tab:
a running Agent Run is stopped on its Turn, and Schedules are set in the Agent Library for an
existing Session.

## Considered Options

- **Keep editing inside the Session, add a global list**: rejected because it keeps the Session's
  settings tabs switching between the Session and the Agent, which was the confusion.
- **Every Agent saved as an Agent Preset**: rejected because a preset copy has to be kept in sync
  with its Agent, and because an Agent runs fixed Steps with no Session context while an Agent
  Preset is a conversation, so one list that hides the difference would confuse again.
- **Trial Runs as ordinary Sessions**: rejected because tuning produces many runs nobody wants in
  the sessions panel.

## Consequences

ADR 0005's rules that a Schedule belongs to one Agent and one Session and that a prompt waits
behind an Agent Run in flight still hold. A Trial Run is a real run: only its record and its
Artifacts are thrown away, so writes to a read-write Mounted Folder and tool side effects remain.
