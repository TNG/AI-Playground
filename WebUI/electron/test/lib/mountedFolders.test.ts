import { describe, expect, it } from 'vitest'
import { resolveMountedFolders } from '@/lib/mountedFolders'

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

  it('keep the host path and access mode of each folder', () => {
    expect(resolveMountedFolders([{ hostPath: '/home/ada/notes', access: 'read-only' }])).toEqual([
      { hostPath: '/home/ada/notes', name: 'notes', access: 'read-only' },
    ])
  })

  it('treat a folder without an access mode as read-only', () => {
    expect(resolveMountedFolders([{ hostPath: '/home/ada/notes' }])[0].access).toBe('read-only')
  })
})
