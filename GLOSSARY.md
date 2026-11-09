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
The agent harness's own conversation inside a Session, one per Agent Preset used there; it carries
that preset's full context across its turns.
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

**Session Update**:
A short templated digest of the History Entries a chat preset or Agent Preset missed since its own
last turn in the Session, handed to it with the next prompt. Never a model-written summary.
_Avoid_: session summary, recap

## Agents

**Agent**:
A named, repeatable piece of work, available to every Session: an ordered list of Steps run with
its own Settings Template, by hand or on a Schedule. The Session it was made in does not own it.
_Avoid_: Task, job, automation

**Agent Preset**:
A chat preset that runs on the agent harness — Agent Maker, Game Agent, Quick Coder, or an Agent
saved as a preset.
_Avoid_: agent (on its own, for a preset)

**Step**:
One prompt of an Agent, sent as its own turn.

**Settings Template**:
The settings an Agent's runs use, fixed on the Agent rather than taken from the Session.

**Schedule**:
The recurring interval at which an Agent runs by itself in one Session. An Agent can have a
Schedule in several Sessions; a Schedule ends with its Session or its Agent.

**Agent Run**:
One execution of an Agent's Steps inside the Session it was started or scheduled in, in a fresh
Harness Session that starts with no context from the Session. Its result is its final answer and
the Artifacts it produced.
_Avoid_: Task Run, Task Session, scheduled session

**Mounted Folder**:
A folder on the user's machine that Agent Maker's turns or an Agent's runs can reach besides the
Session Folder, added by the user to the Session Settings or to the Agent's Settings Template, and
either read-only or read-write.
_Avoid_: extra folder, attached folder, workspace

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
