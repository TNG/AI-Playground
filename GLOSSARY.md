# AI Playground

A desktop app that runs chat, agent and media-generation models locally on Intel GPUs, organised
around the presets a user picks.

## Modes

**Mode**:
A group of presets the user picks between in the prompt bar: Assistant, Audio, Image Gen, Image
Edit or Video. Picking a Mode selects the preset last used in it.
_Avoid_: tab, view

**Assistant**:
The Mode holding the conversational presets, the Agent presets and the saved Agents.
_Avoid_: Chat mode, Agent mode

**Assistant preset**:
The general preset of the Assistant Mode, and the one Agents run on.
_Avoid_: Agent Maker

**Media Mode**:
A Mode that runs one media preset directly: Audio, Image Gen, Image Edit or Video. The Assistant
reaches media only through its tools, so it is not a Media Mode. The user can hide all Media Modes.
_Avoid_: direct media preset, media gen mode

## Sessions

**Session**:
The unit of work the user sees in the sessions panel: one continuous history in which any mix of
presets can take turns. A new Session starts only when the user asks for one, and starts on the
Assistant preset — with Default Settings, or with another Session's Session Settings when the user
starts it from that Session. Nothing else of that Session comes along but, when started from its
row, its Session Group.
_Avoid_: user session, agent session, conversation, thread, clone, duplicate

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

**Workspace**:
The one Mounted Folder of a Session that is starred: where its turns' Artifacts land and where its
agents work. Always read-write. An Agent may override it while it is active in the Session. Game
Agent and Quick Coder work in their game's folder instead.
_Avoid_: Session Folder, output folder, media folder

**Artifact**:
A file a turn produced — an image, video, 3D model or audio clip — kept in the Workspace it was
produced in.
_Avoid_: media item, output, generation

**Attached Document**:
A document the user attached in a Session for its turns to search. It belongs to that Session
alone and stays with it whichever folder is its Workspace.
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

## Capabilities

**Capability**:
A named bundle of tools a Session's agent turns can use, ticked per Session in its Agent
settings; unticking one takes its tools away from every agent turn there. A few are on by
default for every new Session — Files and shell, Media generation, Document search, Web
access and Website screenshots — and the rest are the user's to opt into.
_Avoid_: skill, plugin, tool

**Readable Page**:
The text-and-list form of a web page the assistant reads: its visible text, its links, its
fields and its images, each described in the page's own words — an image by its alt text. It
is a page as words to read, not markup to parse.
_Avoid_: the HTML, scrape, dump

**Website Screenshot**:
A picture of a web page, taken to show the user and kept in the Workspace as an Artifact. The
assistant may capture any web page, or a page of the Session's own work, and nothing more
happens on the page: it can only look. A capture takes in the whole page or a single element,
and an element is named by quoting its visible text — an image by its alt text — the same
words the Readable Page lists, never by a selector: the capture looks at the page on its own
and shares no window and no page state with the web tools. The capture Web debugging makes of
a page it is inspecting is one of its own actions, not a Website Screenshot, and a picture of
the user's screen is a Window Screenshot.
_Avoid_: browser screenshot, debug screenshot, page capture

**Window Screenshot**:
A picture of a window on the user's own screen, taken by Media generation to show what the
user sees — the desktop, an app, a browser the user had open. It captures the user's machine,
not the web; a page the assistant went to is a Website Screenshot.
_Avoid_: screen recording, page capture, website screenshot

## Media

**Media Specialist**:
The helper that turns a request for an image, video or 3D model into the workflow that makes it
and the settings to run it with.
_Avoid_: media agent, media subagent

**Source Image**:
The existing image a request for media transforms: an image the user attached, or an earlier
result.
_Avoid_: input image, reference image

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
One instruction in an Agent's ordered list. An Agent Run is given all its Steps at once and decides
how to carry them out: in order, conditionally, repeatedly, or by asking the user.
_Avoid_: task, stage

**Start Prompt**:
Text the user gives when starting an Agent, for that Agent Run only. It goes in with the Steps and
applies to every Step it is relevant to; starting without one runs the Steps as written.
_Avoid_: task, run instructions, input

**Settings Template**:
The settings an Agent's runs use, fixed on the Agent rather than taken from the Session. A setting
it leaves out, such as the model, comes from the Assistant preset's Default Settings, never from
the Session.

**Schedule**:
The recurring interval at which an Agent runs by itself in one existing Session, set in the Agent
Library. An Agent can have Schedules in several Sessions but at most one per Session; a Schedule
ends with its Session or its Agent.

**Agent Run**:
One conversation with an Agent inside the Session it was started or scheduled in. It starts by
giving the Agent all its Steps at once, in a fresh Harness Session with no context from the
Session, and its Follow-ups continue it until the Agent is run again. It works with its Session's
Workspace and Mounted Folders, unless the Agent overrides either. Its result is the
final answer of its first turn and the Artifacts that turn produced.
_Avoid_: Task Run, Task Session, scheduled session

**Follow-up**:
A prompt sent to an Agent without running its Steps: a later turn of the Agent's latest Agent Run
or Trial Run, and how the user answers a question the run asked. An Agent that has not run yet
takes none.
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
A folder on the user's machine that the Assistant preset's turns or an Agent's runs can reach,
listed in the Session Settings or, as an override of the Session's, in the Agent's Settings
Template, and either read-only or read-write. Every Session has at least one, its Workspace, which the app provides until the user
stars another, and which the user can never take off the list. Taking any other one off the list ends its access,
never the Artifacts made in it.
_Avoid_: extra folder, attached folder

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
Channel has its own; the Session open on the desktop never changes it, but starting an Agent from
the Channel in a new Session makes that Session its Channel Session. The other way round, each
deliberate move of the Channel Session (`/load`, `/new`, an Agent start) brings it into view on
the desktop; plain messages and Answers never do.
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
A message asking the user, in a Channel, for the Start Prompt of one Agent in one Reachable Session,
or in a new Session made only once the reply arrives. The first reply to it starts that Agent Run
there with the reply as its Start Prompt; it is not an Answer, and it is forgotten when the app
quits.
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
A Theme the user made by saving changed colours of another one. The user can rename,
recolour, reset and delete it.
_Avoid_: user theme, edited theme

**Base Theme**:
The Built-in Theme a Custom Theme was made from. Resetting a Custom Theme gives it its Base
Theme's colours again.
_Avoid_: parent theme, template

**Editing Mode**:
How a theme's colours are edited: Simple (the user picks its Main Colours and the app works out
the rest) or Advanced (the user sets every colour). Each Custom Theme has exactly one at a time;
edits to a Built-in Theme carry theirs into the Custom Theme that saving them creates.
_Avoid_: simple theme, advanced theme

**Way Back**:
The theme button and its menu, which every theme must leave visible so the user can always
switch to a readable one. It is the only thing a theme is required to keep readable.
_Avoid_: minimal rule, readability check, blocking pairs

**Main Colours**:
The few colours the user picks for a Custom Theme in Simple mode: Background, Panels, Text,
Accent and Accent text.
_Avoid_: colour roles, base colours, seed colours

**Derived Colours**:
Every colour of a Custom Theme that is not a Main Colour. In Simple mode the app works them out
from the Main Colours; in Advanced mode the user sets them like any other.
_Avoid_: calculated colours, generated colours, secondary colours
