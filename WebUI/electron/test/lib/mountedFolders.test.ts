import { describe, expect, it } from 'vitest'
import { mountedFolderRefusal, resolveMountedFolders } from '@/lib/mountedFolders'

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
    sessionFolder: '/Users/ada/AI-Playground/sessions/s1/files',
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

  it.each([
    '/Users/ada/AI-Playground/sessions/s1/files',
    '/Users/ada/AI-Playground/sessions/s1/files/generated',
    '/Users/ada/AI-Playground/sessions',
  ])('refuses %s, which overlaps the Session Folder', (folder) => {
    expect(mountedFolderRefusal(folder, posix)).toEqual({ reason: 'session-folder' })
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

  it('accepts a folder with no Session Folder yet', () => {
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
