# AI Playground

A desktop app that runs chat, agent and media-generation models locally on Intel GPUs, organised
around the presets a user picks.

## Sessions

**Session**:
The unit of work the user sees in the sessions panel: one continuous history in which any mix of
presets can take turns. A new Session starts only when the user asks for one.
_Avoid_: user session, agent session, conversation, thread

**Title**:
What a Session is called in the sessions panel: its Name if it has one, otherwise its first prompt,
shortened.

**Name**:
A Title the user gave a Session explicitly. It changes what the Session is called, not where it is
listed.
_Avoid_: rename (as a noun), label

**Session Group**:
A named group of Sessions the user creates, listed in the sessions panel and expanded to show its
Sessions. A Session is in at most one Session Group; deleting a Session Group keeps its Sessions.
_Avoid_: folder, project, collection, category

**Pinned Session**:
A Session the user keeps at the top of the sessions panel, above Session Groups and Recent
Sessions, until unpinned. Pinning does not take a Session out of its Session Group.
_Avoid_: favourite, starred

**Recent Session**:
A Session that is neither pinned nor in a Session Group, listed by when it was last used.

**Harness Session**:
The agent harness's own conversation inside a Session: one per chat preset chatted with there,
carrying its full context across its turns, plus a fresh one for each Agent Run, which its
Follow-ups continue.
_Avoid_: Pi session, agent session

**Session History**:
The append-only record of everything that happened in a Session, in order — which preset ran, what
it was asked, and what it produced.
_Avoid_: transcript, log

**History Entry**:
One turn's record in the Session History.

**Session Folder**:
The directory that belongs to one Session, where the artifacts its turns produce are kept.
_Avoid_: media folder, output folder

**Artifact**:
A file a turn produced — an image, video, 3D model or audio clip — kept in its Session's Session
Folder.
_Avoid_: media item, output, generation

**Attached Document**:
A document the user attached in a Session for its turns to search. It belongs to that Session
alone and is kept in its Session Folder.
_Avoid_: RAG document, knowledge base

**Paused Session**:
A Session, or a Trial Run, whose turn is waiting on the user, for example to approve a model
download or a VRAM warning.
_Avoid_: blocked session, stuck session

**In View**:
A Session or Trial Run is In View when the user can see it: a Session when it is the one showing
and no Library is over it, a Trial Run when the Agent Library shows that Agent's Trial Run. What
a Paused Session asks waits until it is In View, and the user is alerted meanwhile.
_Avoid_: visible, active, focused, on screen

**Session Update**:
A short templated digest of the History Entries a chat preset missed since its own last turn in
the Session, handed to it with the next prompt. Never a model-written summary.
_Avoid_: session summary, recap

## Agents

**Agent**:
A named, repeatable piece of work, available to every Session: an ordered list of Steps run with
its own Settings Template, by hand or on a Schedule. It is made in the Agent Library and no Session
owns it.
_Avoid_: Task, job, automation

**Agent Library**:
The one place, opened over whatever Session is showing, where Agents are created, edited,
scheduled and tried out. It belongs to no Session, and leaving it loses nothing.
_Avoid_: Agent Maker, Agents view, agent manager

**Model Library**:
The one place, opened over whatever Session is showing, where models are browsed, downloaded and
deleted. It belongs to no Session.
_Avoid_: Model Manager, Models view

**Library**:
The Agent Library or the Model Library. At most one Library is open: opening one closes the other,
and closing it returns to the Session.
_Avoid_: overlay, modal, panel

**Step**:
One prompt of an Agent, sent as its own turn.

**Start Prompt**:
Text the user gives when starting an Agent, for that Agent Run only. It goes in with the first Step
and applies to every Step it is relevant to; starting without one runs the Steps as written.
_Avoid_: task, run instructions, input

**Settings Template**:
The settings an Agent's runs use, fixed on the Agent rather than taken from the Session.

**Schedule**:
The recurring interval at which an Agent runs by itself in one existing Session, set in the Agent
Library. An Agent can have Schedules in several Sessions but at most one per Session; a Schedule
ends with its Session or its Agent.

**Agent Run**:
One execution of an Agent's Steps inside the Session it was started or scheduled in, in a fresh
Harness Session that starts with no context from the Session. Prompts sent to the Agent afterwards
continue that Harness Session, until its Steps are run again. Its result is its final answer and
the Artifacts it produced.
_Avoid_: Task Run, Task Session, scheduled session

**Follow-up**:
A prompt sent to an Agent without running its Steps. It continues the Harness Session of the
Agent's latest Agent Run or Trial Run; an Agent that has not run yet takes none.
_Avoid_: Agent chat, chat with agent

**Draft**:
An Agent's unsaved edits, kept until they are saved or discarded. Only Trial Runs use it;
Schedules and every other run keep using the saved Agent until the Draft is saved.
_Avoid_: working copy, pending changes

**Trial Run**:
A run of an Agent's Draft started in the Agent Library, to try it out. It belongs to no Session;
it and its Follow-ups are thrown away, with their Artifacts, when the next Trial Run of that Agent
starts or the app quits.
_Avoid_: test run, try-out, throwaway session

**Mounted Folder**:
A folder on the user's machine that Assistant's turns or an Agent's runs can reach besides the
Session Folder, added by the user to the Session Settings or to the Agent's Settings Template, and
either read-only or read-write.
_Avoid_: extra folder, attached folder, workspace

## Channels

**Channel**:
A messaging app through which the user reaches the app from elsewhere: Telegram, Slack or LAN chat.
_Avoid_: Home Agent, bot, integration

**Reachable Session**:
A Session that can be reached from Channels — from every Channel that is set up. Every new Session
starts reachable; the user can turn it off per Session. Of Sessions, only a Reachable Session sends
Notifications or takes Answers.
_Avoid_: remote session, Home Agent thread

**Channel Session**:
The Reachable Session that a Channel's messages go to unless they answer a Notification. Each
Channel has its own; the Session open on the desktop never changes it.
_Avoid_: current session, active thread, focused session

**Notification**:
A message a turn in a Reachable Session, or in a Trial Run whose Agent may notify, sends to
Channels: something it chose to tell the user, its reply to an Answer, or word that it paused or
failed. A reply to something sent from a Channel goes
to that Channel alone; every other Notification goes to every Channel.
_Avoid_: push, alert

**Answer**:
A reply to a Notification, sent from a Channel. It runs as a turn in the Harness Session that sent
the Notification, so answering an Agent Run's or a Trial Run's Notification is a Follow-up.
_Avoid_: reply (as a noun), response

**Start Prompt Request**:
A message asking the user, in a Channel, for the Start Prompt of one Agent in one Reachable Session.
The first reply to it starts that Agent Run there with the reply as its Start Prompt; it is not an
Answer, and it is forgotten when the app quits.
_Avoid_: prompt question, pending start

## Settings

**Session Settings**:
A preset's settings as they apply within one Session; changing them affects no other Session.

**Default Settings**:
A preset's saved settings, copied into a Session the first time that preset is used there.
_Avoid_: preset settings, global settings

**Machine Settings**:
Settings that apply to every Session on this machine at once — device, backend install, speech
engine and voice. Changing one changes it for every Session.
_Avoid_: global settings

**App Settings**:
Preferences about the app itself rather than about how any preset runs — language, prompt bar
style, HuggingFace access, Permissions, developer toggles. Opened from the header, never from
inside a Session.
_Avoid_: global settings, preferences

## Themes

**Built-in Theme**:
A Theme that ships with the app. The user can pick it but never change it; app updates may.
_Avoid_: default theme, preset theme, standard theme

**Custom Theme**:
A Theme the user made by copying another one and changing its colours. The user can rename,
recolour, reset and delete it.
_Avoid_: user theme, edited theme

**Base Theme**:
The Built-in Theme a Custom Theme was made from. Resetting a Custom Theme gives it its Base
Theme's colours again.
_Avoid_: parent theme, template
