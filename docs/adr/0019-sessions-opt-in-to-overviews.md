---
status: accepted
---

# Sessions are opted in to Overviews, and off by default

An Overview collects the prompts and results of many Sessions into one file the user may send to
someone else, which is a wider disclosure than anything else in the app. Reachable Session defaults
on because it opens one Session to the user's own Channels; this defaults off because it opens the
whole set to a document that travels. The switch is a standing property of the Session, set where
the other per-Session switches are, and the Overview reads only Sessions that have it: the flag is
the boundary, not an instruction the agent is asked to respect.

Choosing it is consent to three things: the Session keeps an Overview Summary, a local model reads
its History Entries to write that summary, and the summary with one picture may appear in a file
the user shares. Enabling therefore does work. It starts the first Overview Summary update, shown
by the chip, which summarises the existing history (in chunks when it does not fit one prompt); a
Session with no History Entries writes nothing until its first turn. Every later turn updates the
summary before it finishes, locally, in its own context. Nothing is summarised for a Session that
is not included. Turning the switch off cancels a running update and deletes the summary;
re-enabling computes it again from the Session's history. An Overview already written keeps its
copy, because that file is the user's.

## Considered Options

- **On by default, matching Reachable Session** — rejected. The two are not the same disclosure, and
  a user who never opens the feature would still have every Session exposed to it.
- **An instruction in the preset telling the agent which Sessions to include** — rejected. It holds
  until a model decides otherwise, and it puts the consent boundary somewhere the user cannot see.
- **Opting in per Overview rather than per Session** — rejected. It re-asks a question whose answer
  does not change, and it would leave no place in a Session's own settings to see the answer.
- **Keeping the summary after opt-out** — rejected. That would leave a hidden copy of the Session's
  prompts behind after the consent that allowed it ended; the Overview files the user chose to keep
  are the only copies that outlive the switch.

## Consequences

Enabling an old Session can take a while and cost tokens, because the first summary reads the whole
history; the chip's spinner is the honest sign of that, and no work happens for Sessions that are
not included. Summaries are local-only: in Cloud Mode, or after a turn that ran on a cloud model,
the summary stays behind until a local turn updates it, and the Overview footnotes it. A panel media
or audio turn pays a model load to update its summary. The summary is sensitive derived text: it
lives on the Session record, is read-only, is never a History Entry or an Artifact, and never enters
a conversation. Reading only included Sessions also bounds the query, so an Overview stays fast on
an install with hundreds of Sessions. "No Sessions are included" and "none of your included Sessions
were active in that range" remain distinct, ordinary states rather than errors. Turning the switch
off later does not retract an Overview already written: it is a snapshot, and its copy is the user's
file.
