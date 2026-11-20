import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertMountedFoldersApart, mountedFoldersChangeNote } from '../../agent/mountedFolderTurn'

let root: string
let project: string
let site: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-folder-turn-')))
  project = path.join(root, 'project')
  site = path.join(project, 'site')
  fs.mkdirSync(site, { recursive: true })
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('a folder overlapping the Workspace', () => {
  it('is allowed around it when both are read-write', () => {
    expect(() =>
      assertMountedFoldersApart(site, [{ hostPath: project, access: 'read-write' }]),
    ).not.toThrow()
  })

  it('is refused when it is read-only', () => {
    expect(() =>
      assertMountedFoldersApart(site, [{ hostPath: project, access: 'read-only' }]),
    ).toThrow(/overlaps the Workspace/)
  })

  it('is refused when it is the Workspace itself', () => {
    expect(() =>
      assertMountedFoldersApart(site, [{ hostPath: site, access: 'read-write' }]),
    ).toThrow(/overlaps the Workspace/)
  })
})

describe('the folder note', () => {
  const folder = { hostPath: '/x/site', name: 'site', access: 'read-write' as const }

  it('says which Session folder a run leaves out, even when nothing else changed', () => {
    const leftOut = [{ hostPath: '/x/notes', name: 'notes', overlaps: '/x/notes/2026' }]

    expect(mountedFoldersChangeNote([folder], [folder], false, undefined, leftOut)).toBe(
      "[Not mounted for this run: /x/notes, the Session's folder, overlaps /x/notes/2026.]",
    )
  })
})
