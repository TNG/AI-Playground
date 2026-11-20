import { describe, expect, it } from 'vitest'
import { agentFolderEntries, editableFolders, withOtherFolders } from '@/lib/agentFolderOverrides'
import type { AgentFolderEntry } from '@/types/agentSessionIpc'

const notes: AgentFolderEntry = {
  id: 'f1',
  hostPath: '/Users/me/Notes',
  slug: 'notes',
  access: 'read-only',
}

let counter = 0
const newId = () => `new-${++counter}`

describe("an Agent's “Use only these” folders", () => {
  it('are edited in the shared folder list under their slugs', () => {
    expect(editableFolders([notes])).toEqual([
      { hostPath: '/Users/me/Notes', name: 'notes', access: 'read-only' },
    ])
  })

  it('keep their id and slug through an edit, and a new folder gets both once', () => {
    counter = 0
    const edited = [
      { hostPath: '/Users/me/Notes', name: 'notes', access: 'read-write' as const },
      { hostPath: '/Volumes/usb/notes' },
    ]

    expect(agentFolderEntries(edited, [notes], newId)).toEqual([
      { id: 'f1', hostPath: '/Users/me/Notes', slug: 'notes', access: 'read-write' },
      { id: 'new-1', hostPath: '/Volumes/usb/notes', slug: 'notes-2', access: 'read-only' },
    ])
  })

  it('keep a later slug when an earlier folder is removed', () => {
    const second = { id: 'f2', hostPath: '/x/notes', slug: 'notes-2', access: 'read-only' as const }

    expect(agentFolderEntries(editableFolders([second]), [notes, second], newId)).toEqual([second])
  })
})

describe('the “Other folders” choice', () => {
  it('inherits the Session’s folders by leaving the list out', () => {
    expect(withOtherFolders({ folders: [notes] }, undefined)).toEqual({})
  })

  it('uses only the listed folders, an empty list included, and keeps the Workspace choice', () => {
    const workspace = { id: 'w', hostPath: '/Users/me/Site', slug: 'site' }

    expect(withOtherFolders({ workspace }, [])).toEqual({ workspace, folders: [] })
  })
})
