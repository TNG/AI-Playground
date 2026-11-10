---
status: accepted
amends: the Agent Run Harness Session in ADR 0003, the Trial Run in ADR 0007
---

# Follow-ups continue the Agent Run's Harness Session

A prompt sent to a picked Agent used to go to a separate per-Agent chat Harness Session, which
learned about the Agent's runs only from the Session Update's one-line digest, so "why did step 2
do that?" was asked of a conversation that never saw step 2. A Follow-up now continues the
Harness Session of the Agent's latest Agent Run, in a Session and in a Trial Run alike; only
running the Steps again starts a fresh one. An Agent that has not run yet takes no Follow-up, so
the per-Agent chat Harness Session is gone. In the prompt bar the button Enter triggers is the
primary one: Send while the last thing that ran is this Agent's Harness Session (its last Step or
a Follow-up, stopped or failed included), Run once anything else has run since — another preset
or Agent, or an edit to the Agent or its Draft.

## Considered Options

- **Keep the chat Harness Session and enrich the Session Update**: rejected because any digest
  thin enough to prepend to every prompt still loses the run's tool calls and reasoning.
- **Continue the run in Trial Runs only**: rejected because a Trial Run must preview how the
  Agent behaves in a Session, not answer better than it.
- **A fixed keyboard split (Enter = Send, Cmd/Ctrl+Enter = Run)**: rejected in favour of a
  visible, state-dependent primary button; the same key always does what the filled button says.

## Consequences

A Follow-up sent after other turns gets a Session Update for them, as any Harness Session does.
The prompt bar stays blocked while an Agent Run is in flight, and so does the Trial Run's.
Chat Harness Sessions from before this change stay on disk unused; their turns remain in the
Session History.
