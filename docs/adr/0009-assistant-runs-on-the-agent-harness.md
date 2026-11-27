---
status: accepted
supersedes: Agent Maker as a preset of its own
amended-by: ADR 0010 (Home Agent threads are gone; Channels reach Sessions)
---

# Assistant runs on the agent harness

Assistant, the general chat preset, ran on the chat turn engine while Agent Maker ran on Pi, so
the same Session had two general-purpose presets that did nearly the same thing with different
tools, different settings and different ways of handling documents, and users had to know which
engine they wanted before they typed. Assistant now runs on Pi, in its own Harness Session per
Session, with the chat UI on top (mic, camera, Speak, Regenerate, Delete, metrics), and Agent Maker
is merged into it: its Sessions, settings and Agents' Settings Templates are refiled under
Assistant, and the file and shell tools it always had become the `files` capability, on by
default and withheld from models not suited to agent work. The chat turn engine stays, for Home Agent threads and for aiDAPTIV (amended by ADR 0010: Home
Agent threads are gone, so it stays for aiDAPTIV alone). Injected RAG is
gone from Assistant: a document attached in a Session belongs to that Session, is kept in its
Session Folder and is searched with the `rag` tool, which the model calls when it needs it. The
global document list is kept only for aiDAPTIV.

## Considered Options

- **Separate the engine from the UI mode**, letting any chat preset pick Pi or the chat engine:
  rejected because every feature would then need two implementations kept in step, and the
  choice of engine is not one a user should have to make.
- **Keep both presets**, Assistant on the chat engine and Agent Maker on Pi: rejected because
  the two kept drifting apart and the difference between them was the engine, not the job.

## Consequences

Assistant's earlier chat-engine turns are replayed into its first Harness Session, so the model
sees them; turns from before turn markers existed cannot be deleted from what the model sees, so
they offer no Delete. Capabilities a model cannot use are shown disabled (no tool calling, or
not suited to agent work). On the NPU, whose prompt is capped at 8k, speech tools are opt-in.
Moving aiDAPTIV onto Pi, and removing the chat turn engine, are left for later; Home Agent was
replaced by Channels that reach Sessions instead (ADR 0010).
