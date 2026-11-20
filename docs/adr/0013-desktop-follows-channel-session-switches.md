---
status: proposed
amends: the Channel-never-moves-the-desktop rule in the channel-agents-new-session spec (story 30)
---

# The desktop follows a Channel's Session switches, not its traffic

A Channel used to change what the desktop shows only when it started an Agent. Feedback found that
inconsistent: `/load` on a Channel switched the Channel Session while the desktop stayed put and
only showed unread messages. The desktop now brings a Session into view whenever a Channel
deliberately switches to one — an Agent start, `/load`, `/new`, the `/agentsin` picker — and never
for plain messages or Answers.

## Considered Options

- **Follow every Channel message to its Session**: rejected; messages are frequent, and with both
  in use the desktop would be pulled away from whatever its user is doing on each one, including
  right after they navigated elsewhere.
- **Follow only Agent starts (the previous rule)**: rejected as inconsistent; `/load` and `/new`
  are the same kind of deliberate switch.
- **A "Go to Session" prompt instead of switching**: rejected for the same reason it was rejected
  for Agent starts — one more thing to dismiss for something the user just asked for.

## Consequences

Someone using the desktop while another person drives a Channel sees the open Session change on
every switch command; an open Library is never closed by it, and a half-typed prompt is kept. A
plain Channel message unpicks the Session's Agent, so the prompt bar shows the Assistant that
answered it.
