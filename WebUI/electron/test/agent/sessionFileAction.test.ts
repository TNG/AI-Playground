import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sessionFileActions } from '../../agent/sessionFileAction'
import type { SessionFileMounts } from '../../agent/sessionWorkspace'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-file-action-')))
const workspaceDir = path.join(root, 'workspace')
const mountedDir = path.join(root, 'data')
fs.mkdirSync(path.join(workspaceDir, 'sub'), { recursive: true })
fs.mkdirSync(mountedDir, { recursive: true })
fs.writeFileSync(path.join(workspaceDir, 'game.js'), 'game')
fs.writeFileSync(path.join(workspaceDir, 'sub', 'notes.txt'), 'notes')
fs.writeFileSync(path.join(mountedDir, 'todo.txt'), 'todo')
fs.writeFileSync(path.join(root, 'secret.txt'), 'outside')

const gamesMounts: SessionFileMounts = {
  workspaceDir,
  workdir: '/workspace',
  mounted: [],
}
const sessionMounts: SessionFileMounts = {
  workspaceDir,
  workdir: '/mnt/project',
  mounted: [{ hostPath: mountedDir, name: 'data' }],
}

const open = vi.fn(async () => '')
const reveal = vi.fn()

const act = sessionFileActions({
  mountsOf: async (sessionId) =>
    sessionId === 'session-1' ? sessionMounts : sessionId === 'game-1' ? gamesMounts : null,
  open,
  reveal,
})

beforeEach(() => {
  open.mockReset().mockResolvedValue('')
  reveal.mockReset()
})

describe('session file actions', () => {
  it('opens a workspace-relative file', async () => {
    const result = await act('session-1', 'sub/notes.txt', 'open')
    expect(result).toEqual({ success: true })
    expect(open).toHaveBeenCalledWith(path.join(workspaceDir, 'sub', 'notes.txt'))
  })

  it('strips the workspace mount prefix', async () => {
    const result = await act('session-1', '/mnt/project/game.js', 'open')
    expect(result).toEqual({ success: true })
    expect(open).toHaveBeenCalledWith(path.join(workspaceDir, 'game.js'))
  })

  it('resolves a mounted folder reference to its host folder', async () => {
    const result = await act('session-1', '/mnt/data/todo.txt', 'open')
    expect(result).toEqual({ success: true })
    expect(open).toHaveBeenCalledWith(path.join(mountedDir, 'todo.txt'))
  })

  it("strips a game workspace's /workspace prefix", async () => {
    const result = await act('game-1', '/workspace/game.js', 'open')
    expect(result).toEqual({ success: true })
    expect(open).toHaveBeenCalledWith(path.join(workspaceDir, 'game.js'))
  })

  it('opens a host absolute path inside the workspace (real-shell session)', async () => {
    const result = await act('session-1', path.join(workspaceDir, 'game.js'), 'open')
    expect(result).toEqual({ success: true })
    expect(open).toHaveBeenCalledWith(path.join(workspaceDir, 'game.js'))
  })

  it('reveals instead of opening', async () => {
    const result = await act('session-1', 'game.js', 'reveal')
    expect(result).toEqual({ success: true })
    expect(reveal).toHaveBeenCalledWith(path.join(workspaceDir, 'game.js'))
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['../secret.txt', path.join(root, 'secret.txt'), '/mnt/data/../../secret.txt'])(
    'refuses a path that escapes the session folders (%s)',
    async (rawPath) => {
      const result = await act('session-1', rawPath, 'open')
      expect(result.success).toBe(false)
      expect(open).not.toHaveBeenCalled()
    },
  )

  it('refuses a workspace symlink that points outside', async () => {
    const link = path.join(workspaceDir, 'link.txt')
    fs.symlinkSync(path.join(root, 'secret.txt'), link)
    try {
      const result = await act('session-1', 'link.txt', 'open')
      expect(result.success).toBe(false)
      expect(open).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(link)
    }
  })

  it('fails when the file is gone', async () => {
    const result = await act('session-1', 'missing.js', 'open')
    expect(result).toEqual({ success: false, error: 'The file no longer exists.' })
    expect(open).not.toHaveBeenCalled()
  })

  it('fails when the session has no workspace', async () => {
    const result = await act('gone', 'game.js', 'open')
    expect(result.success).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('reports the OS open error text', async () => {
    open.mockResolvedValue('No application is available for this file type')
    const result = await act('session-1', 'game.js', 'open')
    expect(result).toEqual({
      success: false,
      error: 'No application is available for this file type',
    })
  })

  it('refuses an invalid request', async () => {
    const result = await act('session-1', '', 'open')
    expect(result).toEqual({ success: false, error: 'invalid file request' })
  })
})
