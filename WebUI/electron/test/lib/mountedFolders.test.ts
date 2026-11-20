import { describe, expect, it } from 'vitest'
import {
  assignSlug,
  foldersBesideWorkspace,
  mountedFolderRefusal,
  resolveMountedFolders,
  sameHostPath,
  sessionFolderRefusal,
} from '@/lib/mountedFolders'
import type { SessionFolderEntry } from '@/types/sessionIpc'

const names = (hostPaths: string[]) =>
  resolveMountedFolders(hostPaths.map((hostPath) => ({ hostPath, access: 'read-only' }))).map(
    (folder) => folder.name,
  )

describe('Mounted Folder names', () => {
  it('fall back to the folder name', () => {
    expect(names(['/Users/ada/notes', 'C:\\Users\\ada\\Projects\\'])).toEqual(['notes', 'Projects'])
  })

  it('give two folders with the same folder name distinct names', () => {
    expect(names(['/home/ada/notes', '/mnt/usb/notes', '/srv/notes'])).toEqual([
      'notes',
      'notes-2',
      'notes-3',
    ])
  })

  it('reduce an unsafe folder name to one path segment', () => {
    expect(names(['/home/ada/my notes:2024', '/home/ada/..', '/'])).toEqual([
      'my-notes-2024',
      'folder',
      'folder-2',
    ])
  })

  it('use the name the user gave, sanitised and kept unique', () => {
    const resolved = resolveMountedFolders([
      { hostPath: '/home/ada/notes' },
      { hostPath: '/home/ada/archive', name: ' notes ' },
      { hostPath: '/home/ada/x', name: '../../etc/passwd' },
      { hostPath: '/home/ada/blank', name: '   ' },
    ])
    expect(resolved.map((folder) => folder.name)).toEqual([
      'notes',
      'notes-2',
      'etc-passwd',
      'blank',
    ])
  })

  it('keep the host path and access mode of each folder', () => {
    expect(resolveMountedFolders([{ hostPath: '/home/ada/notes', access: 'read-only' }])).toEqual([
      { hostPath: '/home/ada/notes', name: 'notes', access: 'read-only' },
    ])
  })

  it('treat a folder without an access mode as read-only', () => {
    expect(resolveMountedFolders([{ hostPath: '/home/ada/notes' }])[0].access).toBe('read-only')
  })
})

describe('Adding a Mounted Folder', () => {
  const posix = {
    homeFolder: '/Users/ada',
    mountedFolders: [{ hostPath: '/Users/ada/notes' }],
  }

  it('refuses the filesystem root', () => {
    expect(mountedFolderRefusal('/', posix)).toEqual({ reason: 'too-broad' })
  })

  it.each(['C:\\', 'd:', 'D:/', '\\\\nas\\share\\', '/Volumes/Backup'])(
    'refuses the drive root %s',
    (root) => {
      expect(mountedFolderRefusal(root, posix)).toEqual({ reason: 'too-broad' })
    },
  )

  it.each(['/Users/ada', '/Users/ada/', '/Users'])(
    'refuses %s, which holds the home folder',
    (folder) => {
      expect(mountedFolderRefusal(folder, posix)).toEqual({ reason: 'home' })
    },
  )

  it('compares Windows paths without regard to case or separator', () => {
    const windows = { homeFolder: 'C:\\Users\\Ada', mountedFolders: [] }
    expect(mountedFolderRefusal('c:/users/ada', windows)).toEqual({ reason: 'home' })
  })

  it.each(['/Users/ada/notes', '/Users/ada/notes/2024/'])(
    'refuses %s, already reachable through a Mounted Folder',
    (folder) => {
      expect(mountedFolderRefusal(folder, posix)).toEqual({
        reason: 'mounted',
        folder: '/mnt/notes',
      })
    },
  )

  it('refuses a folder that contains a Mounted Folder', () => {
    const context = { ...posix, mountedFolders: [{ hostPath: '/srv/a/notes', name: 'Work notes' }] }
    expect(mountedFolderRefusal('/srv/a', context)).toEqual({
      reason: 'contains-mounted',
      folder: '/mnt/Work-notes',
    })
  })

  it('accepts a folder when nothing is mounted yet', () => {
    expect(mountedFolderRefusal('/srv/data', { mountedFolders: [] })).toBeUndefined()
  })

  it.each([
    '/Users/ada/Documents/papers',
    '/srv/data',
    '/Users/adam',
    '/Users/ada/notes-old',
    '/Users/ada/AI-Playground/sessions/s2/files',
  ])('accepts %s', (folder) => {
    expect(mountedFolderRefusal(folder, posix)).toBeUndefined()
  })
})

describe('A sandbox slug', () => {
  it('is the folder name, sanitised', () => {
    expect(assignSlug('/Users/ada/my notes:2024', [])).toBe('my-notes-2024')
    expect(assignSlug('C:\\Users\\ada\\Projects\\', [])).toBe('Projects')
  })

  it('gets a numeric suffix when the Session already uses its name, in any case', () => {
    expect(assignSlug('/srv/notes', ['notes'])).toBe('notes-2')
    expect(assignSlug('/srv/Notes', ['notes', 'NOTES-2'])).toBe('Notes-3')
  })

  it('falls back to "folder" for a name with nothing usable in it', () => {
    expect(assignSlug('/', [])).toBe('folder')
  })
})

describe('Folders beside a Workspace', () => {
  const workspace = { hostPath: '/Users/ada/poster', name: 'files', access: 'read-write' as const }
  const isWorkspace = (folder: { hostPath: string }) => folder.hostPath === workspace.hostPath

  it('drop the Workspace itself, so it is mounted once, read-write, at its own slug', () => {
    const beside = foldersBesideWorkspace(
      workspace,
      [
        { hostPath: '/Users/ada/poster', name: 'poster', access: 'read-only' },
        { hostPath: '/Users/ada/notes', name: 'notes', access: 'read-only' },
      ],
      isWorkspace,
    )

    expect(beside).toEqual([{ hostPath: '/Users/ada/notes', name: 'notes', access: 'read-only' }])
  })

  it("rename a folder that would take the Workspace's slug, and nothing else", () => {
    const beside = foldersBesideWorkspace(
      workspace,
      [
        { hostPath: '/Users/ada/other/files', name: 'files', access: 'read-only' },
        { hostPath: '/Users/ada/notes', name: 'files-2', access: 'read-write' },
      ],
      isWorkspace,
    )

    expect(beside.map((folder) => folder.name)).toEqual(['files-3', 'files-2'])
  })
})

describe("Adding a folder to a Session's list", () => {
  const entry = (hostPath: string, slug: string): SessionFolderEntry => ({
    id: slug,
    hostPath,
    access: 'read-write',
    slug,
  })
  const context = {
    homeFolder: '/Users/ada',
    folders: [
      entry('/Users/ada/AI-Playground/sessions/s1/files', 'files'),
      entry('/Users/ada/notes', 'notes'),
    ],
  }

  it('refuses a drive root and the home folder', () => {
    expect(sessionFolderRefusal('/', context)).toEqual({ reason: 'too-broad' })
    expect(sessionFolderRefusal('/Users', context)).toEqual({ reason: 'home' })
  })

  it.each([
    ['/Users/ada/AI-Playground/sessions/s1/files/generated', 'mounted', '/mnt/files'],
    ['/Users/ada/AI-Playground/sessions', 'contains-mounted', '/mnt/files'],
    ['/Users/ada/notes', 'mounted', '/mnt/notes'],
  ])(
    'refuses %s, which overlaps an entry of the list, the Workspace included',
    (folder, reason, at) => {
      expect(sessionFolderRefusal(folder, context)).toEqual({ reason, folder: at })
    },
  )

  it.each(['/Users/ada/AI-Playground/sessions/s2/files', '/Users/ada/notes-old', '/srv/data'])(
    'accepts %s',
    (folder) => {
      expect(sessionFolderRefusal(folder, context)).toBeUndefined()
    },
  )
})

describe('The same host folder', () => {
  it('ignores case and separators on Windows, and a trailing separator anywhere', () => {
    expect(sameHostPath('C:\\Users\\ada\\Proj', 'c:/users/ADA/proj/')).toBe(true)
    expect(sameHostPath('/Users/ada/proj/', '/Users/ada/proj')).toBe(true)
  })

  it('keeps case on POSIX paths, and tells siblings apart', () => {
    expect(sameHostPath('/Users/ada/Proj', '/Users/ada/proj')).toBe(false)
    expect(sameHostPath('/Users/ada/proj', '/Users/ada/proj-2')).toBe(false)
  })
})
