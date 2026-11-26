import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SESSION_FILE_FULL_PREVIEW_CAP,
  SESSION_FILE_PREVIEW_CAP,
  SESSION_FILE_PREVIEW_LINES,
  sessionFileActions,
  sessionFileReader,
} from '../../agent/sessionFileAction'
import type { SessionFileMounts } from '../../agent/sessionWorkspace'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-file-action-')))
const workspaceDir = path.join(root, 'workspace')
const mountedDir = path.join(root, 'data')
fs.mkdirSync(path.join(workspaceDir, 'sub'), { recursive: true })
fs.mkdirSync(mountedDir, { recursive: true })
fs.writeFileSync(path.join(workspaceDir, 'game.js'), 'game')
fs.writeFileSync(path.join(workspaceDir, 'sub', 'notes.txt'), 'notes')
fs.writeFileSync(path.join(mountedDir, 'todo.txt'), 'todo')
fs.writeFileSync(path.join(workspaceDir, 'big.js'), 'b'.repeat(SESSION_FILE_PREVIEW_CAP + 10))
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
const del = vi.fn(async () => undefined)

const act = sessionFileActions({
  mountsOf: async (sessionId) =>
    sessionId === 'session-1' ? sessionMounts : sessionId === 'game-1' ? gamesMounts : null,
  open,
  reveal,
  delete: del,
})

beforeEach(() => {
  open.mockReset().mockResolvedValue('')
  reveal.mockReset()
  del.mockReset().mockResolvedValue(undefined)
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

  it('deletes the resolved file', async () => {
    const result = await act('session-1', 'sub/notes.txt', 'delete')
    expect(result).toEqual({ success: true })
    expect(del).toHaveBeenCalledWith(path.join(workspaceDir, 'sub', 'notes.txt'))
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses to delete a path that escapes the session folders', async () => {
    const result = await act('session-1', '../secret.txt', 'delete')
    expect(result.success).toBe(false)
    expect(del).not.toHaveBeenCalled()
  })

  it('refuses to delete a file that is gone', async () => {
    const result = await act('session-1', 'missing.js', 'delete')
    expect(result).toEqual({ success: false, error: 'The file no longer exists.' })
    expect(del).not.toHaveBeenCalled()
  })
})

const read = sessionFileReader({
  mountsOf: async (sessionId) =>
    sessionId === 'session-1' ? sessionMounts : sessionId === 'game-1' ? gamesMounts : null,
})

describe('session file reader', () => {
  it('reads a workspace-relative file', async () => {
    const result = await read('session-1', 'sub/notes.txt')
    expect(result).toEqual({ success: true, data: { content: 'notes', truncated: false } })
  })

  it('shows a short file whole', async () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`)
    fs.writeFileSync(path.join(workspaceDir, 'ten.txt'), lines.join('\n'))
    const result = await read('session-1', 'ten.txt')
    expect(result).toEqual({ success: true, data: { content: lines.join('\n'), truncated: false } })
  })

  it('keeps only the first lines of a long file and says so', async () => {
    const lines = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`)
    fs.writeFileSync(path.join(workspaceDir, 'long.txt'), lines.join('\n'))
    const result = await read('session-1', 'long.txt')
    expect(result).toEqual({
      success: true,
      data: { content: lines.slice(0, SESSION_FILE_PREVIEW_LINES).join('\n'), truncated: true },
    })
  })

  it('truncates a file past the byte ceiling and says so', async () => {
    const result = await read('session-1', 'big.js')
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.content).toBe('b'.repeat(SESSION_FILE_PREVIEW_CAP))
    expect(result.data.truncated).toBe(true)
  })

  it('shows a long file whole when asked for the full view', async () => {
    const lines = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`)
    fs.writeFileSync(path.join(workspaceDir, 'long.txt'), lines.join('\n'))
    const result = await read('session-1', 'long.txt', true)
    expect(result).toEqual({ success: true, data: { content: lines.join('\n'), truncated: false } })
  })

  it('still truncates the full view of a file past the full ceiling', async () => {
    fs.writeFileSync(
      path.join(workspaceDir, 'huge.js'),
      'h'.repeat(SESSION_FILE_FULL_PREVIEW_CAP + 1),
    )
    const result = await read('session-1', 'huge.js', true)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.content).toBe('h'.repeat(SESSION_FILE_FULL_PREVIEW_CAP))
    expect(result.data.truncated).toBe(true)
  })

  it('refuses a path that escapes the session folders', async () => {
    const result = await read('session-1', '../secret.txt')
    expect(result.success).toBe(false)
    expect('missing' in result).toBe(false)
  })

  it('fails with the missing marker when the file is gone', async () => {
    const result = await read('session-1', 'missing.js')
    expect(result).toEqual({
      success: false,
      error: 'The file no longer exists.',
      missing: true,
    })
  })

  it('fails when the session has no workspace', async () => {
    const result = await read('gone', 'game.js')
    expect(result.success).toBe(false)
    expect('missing' in result).toBe(false)
  })

  it('refuses an invalid request', async () => {
    const result = await read('', 'game.js')
    expect(result).toEqual({ success: false, error: 'invalid file request' })
  })
})
