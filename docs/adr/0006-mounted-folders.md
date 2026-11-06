---
status: accepted
---

# Mounted Folders are per Session, appear at /mnt/<name>, and are advisory under the real shell

Agent Maker could only reach its Session Folder. The user can now add Mounted Folders, each
read-only or read-write. They are part of the Session Settings, like every other agent setting
since ADR-0004, so one Session's folders never leak into another. An Agent's Settings Template
carries its own copy, so an Agent Run, which starts with no context from its Session, does not
inherit the Session's folders either. In the sandbox a Mounted Folder appears at `/mnt/<name>`
rather than at its real path. That keeps the host's layout and Windows drive letters out of what
the model sees, and gives each Session the same paths on every machine. The Session Folder stays
`/workspace` and remains the working directory.

## Considered Options

- **Machine Settings (one list for every Session)**: rejected because a folder given to one piece
  of work would be readable by every Agent Run and Session on the machine.
- **Real host paths in the sandbox**: rejected for the reasons above, and because the sandbox
  cannot mount anything inside `/workspace`, so the paths would not match the real-shell mode
  either way.
- **Enforcing read-only under the real shell**: not possible. A real process can write wherever
  the user can. Under the developer-only real shell, a read-only Mounted Folder is refused by
  Pi's own write tools and stated in the prompt, but is not a boundary. Its Session Folder
  boundary was already advisory in the same way.
