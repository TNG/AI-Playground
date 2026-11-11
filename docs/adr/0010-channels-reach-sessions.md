---
status: accepted
supersedes: the Home Agent, its Notification Channel choice and its held-Answer journal
amends: ADR 0009's reason for keeping the chat turn engine
---

# Channels reach Sessions

Since a Session can hold any preset, the Home Agent had become a second, weaker kind of Session:
chat-engine threads pinned to one preset, without Assistant's files, memory or capabilities, absent
from the sessions panel and unable to run Agents. It is removed, and its transport stays as
**Channels** (Telegram, Slack, LAN chat) that reach ordinary Sessions. Reachability is a switch on
the Session, not on a preset or a Channel: a Reachable Session is reachable from every Channel that
is set up, its Notifications go to every Channel, and each Channel picks one Reachable Session as
its Channel Session for plain messages. An Answer still runs in the Harness Session that sent the
Notification.

Routing is by Session. The channel message map records each message a Session sends as
`{ sessionRef, harnessSessionId }`, so a reply can be refused or answered by what is true of its
Session (deleted, no longer reachable, using the real system shell) and still run in the exact
Harness Session that asked. The router that takes everything a Channel sends depends on a port
keyed by Session — list, create, send to `{ sessionRef }` or `{ sessionRef, harnessSessionId }`,
start an Agent, stop, report activity, attach — which the window implements over the existing
send-to-session path.

Messages sent while a Session is busy are queued in memory per Session and Channel, never
persisted: ADR 0002's one global Turn Queue holds for Channels too, and a request left over from
before a restart is stale. They are dropped with a reply on `/stop`, when the Session stops being
reachable, and on quit.

## Considered Options

- **Keep the Home Agent beside Reachable Sessions**: rejected because it keeps a second chat engine,
  a pass-through proxy and a command set alive for a Session that can do less than a real one.
- **One Notification Channel, chosen globally**: rejected in favour of every-Channel fan-out; with
  reachability per Session the only remaining choice would be which phone app rings, and a reply
  to something sent from a Channel already goes back to that Channel alone.
- **Per-Session choice of Channels**: rejected for now; one switch is the decision the user makes.
- **Persist queued messages, as the held-Answer journal did**: rejected; ADR 0002 keeps no queue
  across restarts, and Channels are told on quit what was dropped instead.
- **Keep routing by Harness Session**: rejected because reachability, deletion and the Channel
  Session are facts about a Session, and a plain message has no Harness Session until it runs.

## Consequences

Entries in the channel message map written before this change named only a Harness Session; they
are migrated by finding the Session that holds it, and become tombstones when none does. A Harness
Session that belongs to no Session (a Trial Run) records nothing, so a reply to it is not an
Answer. ADR 0009 kept the chat turn engine for Home Agent threads and for aiDAPTIV; with the Home
Agent gone it stays for aiDAPTIV alone. Home Agent threads become Reachable Sessions in a "Home
Agent" Session Group.
