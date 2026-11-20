---
status: accepted
supersedes: the Session Folder at /workspace in ADR-0006
---

# The Workspace is one starred Mounted Folder, and every folder is at /mnt/<name>

Users could not tell the Session Folder, Mounted Folders and where their results went apart: the
Session Folder was named by id, mixed the Session's bookkeeping with its output, and was the only
place output could land. A Session now has one list of Mounted Folders, one of which is starred as
its Workspace: where every non-game preset's Artifacts land and where its agents work. The app
creates the first one, readably named under `AI-Playground/Sessions/`, at the Session's first turn
or when the user opens it, and it is shown from the start so a Session never looks folderless; the
user can star any other folder instead. The Session's record, History and Attached
Documents are kept apart from every folder, so starring a user's folder never writes app files into
it. In the sandbox every folder appears at `/mnt/<name>`, named once when it is added and kept through
any rename, and the Workspace is the working directory, so moving the star changes only the working directory and paths already in a transcript
stay valid. Game Agent and Quick Coder keep their game folders and are not part of this.

## Considered Options

- **A Workspace field beside the Mounted Folders**: rejected because the old Workspace would drop
  out of reach on a switch, and "make this the workspace" would be a move between two lists.
- **Copying or moving the Workspace's contents on a switch**: rejected. A copy duplicates files
  and leaves the History pointing at the originals. A move of the app-created Workspace was built
  and taken out again: an Artifact's URL is saved in places no move can rewrite (agent messages,
  Pi transcripts, conversations, the open window), so moved Artifacts kept their previews but lost
  their file actions. Nothing moves; the old folder stays listed and mounted.
- **Keeping `/workspace` for the Workspace**: rejected because a switch would silently re-point a
  path the model has already used mid-conversation.
- **Letting an Agent override the Workspace**: rejected because a run's output would land
  somewhere other than the Session the user is looking at. An Agent that must write elsewhere gets a
  read-write Mounted Folder.

## Consequences

An Artifact is recorded as a folder plus a path inside it, not a path relative to the Session, so
the History survives a switch and a renamed Workspace. The user can never take the folder the app
created for a Session off its list, starred or not: users do not find it again in their file
manager, so the list is the way back to it. A missing starred folder is replaced by that folder
while it is on disk, and only once it is gone too by a fresh one. Taking any other folder off the list only stops its mounting: the
Session keeps it as a detached folder, so the Artifacts made there still resolve, and adding it
again brings back the same entry. Deleting a Session moves only its
app-created Workspace to the Trash, and a folder the user chose is never deleted or renamed.
