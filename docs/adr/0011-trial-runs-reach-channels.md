---
status: accepted
amends: ADR 0010's consequence that a Trial Run sends no Notifications
---

# Trial Runs reach Channels

A Trial Run is how an Agent is tried out before it is saved, but under ADR 0010 it belonged to no
Session and so could never notify: an Agent with `notify` could only be tested by saving and
scheduling it. A Trial Run whose Agent may notify now sends Notifications like a Reachable Session —
what it chooses to tell the user, and word that it paused or failed while not In View — and an
Answer to one runs as a Follow-up in that Trial Run's Harness Session. The channel message map
therefore records a Trial Run as an owner of its own beside Sessions. A reply to a Trial Run that
has been thrown away (the next Trial Run of the Agent started, or the app quit) is refused, as a
deleted Session's is. Answers that arrive while the run is busy queue per Trial Run and Channel.

A Trial Run stays out of everything a Channel addresses by Session: it is not listed by `/sessions`,
cannot be a Channel Session, and `/stop` cannot reach it. Its result is not sent when it ends,
matching Run Now; only Scheduled and Channel-started runs report their result.

## Considered Options

- **List Trial Runs in `/sessions`**: rejected; a Trial Run belongs to no Session (ADR 0007) and is
  thrown away by the next one, so a Channel pointed at it would lose its Channel Session.
- **Send Trial Run Notifications but refuse Answers**: rejected; a question asked with `ask_user`
  would then stall the run, and Answers are what a notifying Agent depends on once scheduled.
- **Route an Answer to a thrown-away Trial Run into the Agent's current one**: rejected; the new run
  has a different Draft and Harness Session and never asked the question.
