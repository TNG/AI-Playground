import { describe, expect, it } from 'vitest'
import { effectiveFolders } from '@/lib/effectiveFolders'
import type { SessionFolderEntry, SessionFolderList } from '@/types/sessionIpc'

const entry = (
  id: string,
  hostPath: string,
  slug: string,
  access: SessionFolderEntry['access'] = 'read-only',
): SessionFolderEntry => ({ id, hostPath, slug, access })

const project = entry('project', '/Users/me/Project', 'project', 'read-write')
const notes = entry('notes', '/Users/me/Notes', 'notes')
const papers = entry('papers', '/Users/me/Papers', 'papers', 'read-write')

const session: SessionFolderList = { workspaceId: project.id, folders: [project, notes, papers] }

const mounts = (resolved: ReturnType<typeof effectiveFolders>) =>
  resolved && {
    workspace: `${resolved.workspace.name}=${resolved.workspace.hostPath}`,
    others: resolved.others.map((folder) => `${folder.name}=${folder.hostPath} ${folder.access}`),
  }

describe('the folders in effect', () => {
  it("are the Session's star and its other folders when no Agent overrides them", () => {
    expect(mounts(effectiveFolders({ session }))).toEqual({
      workspace: 'project=/Users/me/Project',
      others: ['notes=/Users/me/Notes read-only', 'papers=/Users/me/Papers read-write'],
    })
  })

  it('are nothing while the Session has no Workspace', () => {
    expect(effectiveFolders({ session: { workspaceId: 'gone', folders: [notes] } })).toBeUndefined()
  })

  it("replace the Session's other folders with the Agent's, keeping the Workspace", () => {
    const agent = { folders: [{ hostPath: '/Users/me/Data', access: 'read-only' as const }] }
    expect(mounts(effectiveFolders({ session, agent }))).toEqual({
      workspace: 'project=/Users/me/Project',
      others: ['Data=/Users/me/Data read-only'],
    })
  })

  it('give the Agent an empty list when its list is empty', () => {
    expect(effectiveFolders({ session, agent: { folders: [] } })?.others).toEqual([])
  })

  it("work in the Agent's Workspace, with the Session's Workspace joining the others read-write", () => {
    const agent = { workspace: { hostPath: '/Users/me/Site', name: 'site' } }
    expect(mounts(effectiveFolders({ session, agent }))).toEqual({
      workspace: 'site=/Users/me/Site',
      others: [
        'notes=/Users/me/Notes read-only',
        'papers=/Users/me/Papers read-write',
        'project=/Users/me/Project read-write',
      ],
    })
  })

  it("override both parts independently, leaving nothing of the Session's", () => {
    const agent = {
      workspace: { hostPath: '/Users/me/Site', name: 'site' },
      folders: [{ hostPath: '/Users/me/Data' }],
    }
    expect(mounts(effectiveFolders({ session, agent }))).toEqual({
      workspace: 'site=/Users/me/Site',
      others: ['Data=/Users/me/Data read-only'],
    })
  })

  it('say which list each folder came from', () => {
    const agent = { folders: [{ id: 'a1', hostPath: '/Users/me/Data' }] }
    const resolved = effectiveFolders({ session, agent })
    expect(resolved?.workspace).toMatchObject({ id: 'project', source: 'session' })
    expect(resolved?.others).toMatchObject([{ id: 'a1', source: 'agent' }])
  })

  it("keep every Session slug and suffix an Agent folder's name that one already holds", () => {
    const agent = { folders: [{ hostPath: '/Volumes/usb/Project' }, { hostPath: '/x/notes' }] }
    expect(mounts(effectiveFolders({ session, agent }))?.others).toEqual([
      'Project-2=/Volumes/usb/Project read-only',
      'notes=/x/notes read-only',
    ])
  })

  it('suffix a clashing Agent folder past the names the other Agent folders hold', () => {
    const agent = {
      folders: [
        { hostPath: '/x/other/project', name: 'project' },
        { hostPath: '/x/notes', name: 'project-2' },
      ],
    }
    expect(mounts(effectiveFolders({ session, agent }))?.others).toEqual([
      'project-3=/x/other/project read-only',
      'project-2=/x/notes read-only',
    ])
  })

  it('keep planned folders, marked, for the caller to leave unmounted', () => {
    const planned = { ...entry('later', '/Users/me/Later', 'later'), planned: true }
    const resolved = effectiveFolders({
      session: { ...session, folders: [...session.folders, planned] },
    })
    expect(resolved?.others.at(-1)).toMatchObject({ id: 'later', planned: true })
  })
})

describe('a folder in both the Agent and the Session lists', () => {
  it("is mounted once as the Workspace when an Agent folder is the Session's Workspace", () => {
    const agent = { folders: [{ hostPath: '/Users/me/Project', name: 'mine' }] }
    expect(mounts(effectiveFolders({ session, agent }))).toEqual({
      workspace: 'project=/Users/me/Project',
      others: [],
    })
  })

  it("is mounted once as the Workspace when the Agent's Workspace is a Session folder", () => {
    const agent = { workspace: { hostPath: '/Users/me/Notes', name: 'site' } }
    expect(mounts(effectiveFolders({ session, agent }))).toEqual({
      workspace: 'site=/Users/me/Notes',
      others: ['papers=/Users/me/Papers read-write', 'project=/Users/me/Project read-write'],
    })
  })

  it('is matched by the comparison the caller gives, such as one through symlinks', () => {
    const agent = { folders: [{ hostPath: '/alias/Project' }] }
    const sameFolder = (a: string, b: string) =>
      a.replace('/alias', '/Users/me') === b.replace('/alias', '/Users/me')
    expect(effectiveFolders({ session, agent, sameFolder })?.others).toEqual([])
  })
})

describe('an Agent folder nested with a Session folder', () => {
  it('drops a read-only Session folder inside it and keeps a read-write one', () => {
    const agent = { workspace: { hostPath: '/Users/me', name: 'home' } }
    const nested = { workspaceId: project.id, folders: [project, notes] }
    expect(mounts(effectiveFolders({ session: nested, agent }))).toEqual({
      workspace: 'home=/Users/me',
      others: ['project=/Users/me/Project read-write'],
    })
  })

  it('drops a read-only Session folder around it', () => {
    const agent = {
      workspace: { hostPath: '/Users/me/Notes/2026', name: 'year' },
    }
    expect(mounts(effectiveFolders({ session, agent }))).toEqual({
      workspace: 'year=/Users/me/Notes/2026',
      others: ['papers=/Users/me/Papers read-write', 'project=/Users/me/Project read-write'],
    })
  })

  it("keeps the Session's Workspace around it, both being read-write", () => {
    const agent = { workspace: { hostPath: '/Users/me/Project/site', name: 'site' } }
    expect(mounts(effectiveFolders({ session, agent }))?.others).toEqual([
      'notes=/Users/me/Notes read-only',
      'papers=/Users/me/Papers read-write',
      'project=/Users/me/Project read-write',
    ])
  })

  it('names the Session folders it drops, and the folder each gave way to', () => {
    const agent = { workspace: { hostPath: '/Users/me/Notes/2026', name: 'year' } }
    expect(effectiveFolders({ session, agent })?.leftOut).toMatchObject([
      { hostPath: '/Users/me/Notes', overlaps: '/Users/me/Notes/2026' },
    ])
  })

  it("never drops the Session's Workspace while it is the one in effect", () => {
    const agent = { folders: [{ hostPath: '/Users/me/Project/assets' }] }
    expect(mounts(effectiveFolders({ session, agent }))).toEqual({
      workspace: 'project=/Users/me/Project',
      others: ['assets=/Users/me/Project/assets read-only'],
    })
  })
})
