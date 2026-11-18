---
status: accepted
amends: the one-block Agent Run in ADR 0005, the "last Step" wording in ADR 0008
---

# An Agent Run gets all its Steps at once

An Agent Run used to send its Steps one turn at a time ("do only the current one, then stop"), so
a Step could not branch, loop or ask the user anything: "ask me about x" was sent, answered by the
model guessing, and followed by the next Step regardless. An Agent Run now sends every Step, with
the Start Prompt, in one prompt, and the agent decides how to carry them out. To ask the user it
ends its reply with the question; the answer is a Follow-up (or, from a Channel, an Answer) that
continues the run's Harness Session. The Agent Run is that whole conversation, until the Agent is
run again, but its reported result and outcome are its first turn's.

The run is no longer one collapsed block in the timeline: its start is an ordinary user bubble
("Run Agent X", expandable to the full prompt) and every reply and Follow-up after it renders like
any other turn. Trial Runs run and render the same way.

## Considered Options

- **A workflow engine with conditions, loops and user-input Steps**: rejected as far more
  machinery than the problem needs; the model already reads instructions in order and can follow
  "if", "repeat" and "ask me" in plain words.
- **A blocking `ask_user` tool that pauses the run**: rejected; it needs new pause plumbing, a
  prompt bar that routes replies into a waiting tool, and Channel replies that reach a running
  run, while ending the turn reuses Follow-ups and Answers unchanged.
- **Keep today's look for runs saved before this change**: rejected to keep one renderer; old runs
  render flat, their later "Step i of N" prompts showing as the user bubbles they were sent as.

## Consequences

"Step x of y" progress is gone everywhere: the live timeline header, the Channel session label,
`/stop` and queue replies, the close dialog, failure toasts and the persisted run markers. Order
is a strong hint to the model, not a guarantee. A run is one History Entry, recorded as the
Agent's name and Start Prompt. A Scheduled run now reports every Artifact it made, not only its
last Step's. A question a Scheduled run ends on may go unanswered; the next slot starts a fresh
run regardless. Pi turns have no step cap, so a looping run is ended only by Stop.
