---
status: accepted
---

# Sessions are opted in to Overviews, and off by default

An Overview aggregates the prompts and results of many Sessions into one file the user may send to
someone else, which is a wider disclosure than anything else in the app. Reachable Session defaults
on because it opens one Session to the user's own Channels; this defaults off because it opens the
whole set to a document that travels. The switch is a standing property of the Session, set where
the other per-Session switches are, and the Overview's query reads only Sessions that have it: the
flag is the boundary, not an instruction the agent is asked to respect.

Nothing is summarised or cached when a Session is switched on, so enabling it cannot start work and
cannot make an old Session expensive; the first Overview whose range touches it does the reading.

## Considered Options

- **On by default, matching Reachable Session** — rejected. The two are not the same disclosure, and
  a user who never opens the feature would still have every Session exposed to it.
- **An instruction in the preset telling the agent which Sessions to include** — rejected. It holds
  until a model decides otherwise, and it puts the consent boundary somewhere the user cannot see.
- **Opting in per Overview rather than per Session** — rejected. It re-asks a question whose answer
  does not change, and it would leave no place in a Session's own settings to see the answer.

## Consequences

"No Sessions are included" and "none of your included Sessions did anything in that range" are
distinct, ordinary states the agent explains rather than errors. Reading only included Sessions
also bounds the query to a small set of `session.json` files, so an Overview stays fast on an
install with hundreds of Sessions. Turning the switch off later does not retract an Overview already
written: it is a snapshot, and its copy of those prompts is the user's file.
