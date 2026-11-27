---
status: accepted
supersedes: the Agent ownership in ADR-0003
---

# Agents are available to every Session; runs and Schedules belong to one

ADR-0003 and the "Run Tasks inside their Session" change made an Agent belong to the Session it was created in: listed only there, deleted with it, always run there. That conflated the Agent with its runs. An Agent is a reusable definition like a tool, so it is listed in every Agent Maker Session and outlives the Session it was made in; what belongs to one Session is an Agent Run (in the Session where it was started or scheduled) and a Schedule (one per Agent and Session, removed with either). An Agent Preset runs its Agent in the current Session, not the one the Agent was made in.

## Consequences

A prompt sent in a Session with an Agent Run in flight waits until the run's last Step has finished, so the run stays one block in the timeline; turns from other Sessions still take the Turn Queue between Steps, as ADR-0002 allows.
