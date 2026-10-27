import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workspaceMediaFileActions } from '../../agent/workspaceMediaFile'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-media-file-')))
const workspaceDir = path.join(root, 'workspace')
const mediaDir = path.join(root, 'media')
const audioDir = path.join(root, 'audio')
for (const dir of [path.join(workspaceDir, 'generated'), mediaDir, audioDir]) {
  fs.mkdirSync(dir, { recursive: true })
}
fs.writeFileSync(path.join(workspaceDir, 'generated', 'castle.png'), 'workspace copy')
fs.writeFileSync(path.join(mediaDir, 'castle.png'), 'app copy')
fs.writeFileSync(path.join(audioDir, 'speech.wav'), 'app audio')
fs.writeFileSync(path.join(root, 'secret.txt'), 'outside')

const sender = {} as Electron.WebContents
const open = vi.fn()
const reveal = vi.fn()
const drag = vi.fn()
const saveCopy = vi.fn()

const act = workspaceMediaFileActions({
  sessionWorkspaceDir: async (sessionId) => (sessionId === 'session-1' ? workspaceDir : null),
  mediaUrlPath: (url) =>
    url.startsWith('aipg-media://media/') ? path.join(mediaDir, url.slice(19)) : null,
  audioDir: () => audioDir,
  open,
  reveal,
  drag,
  saveCopy,
})

beforeEach(() => {
  for (const fn of [open, reveal, drag, saveCopy]) fn.mockReset()
})

describe('workspace media file actions', () => {
  it('opens the workspace copy of a generated file', async () => {
    const result = await act(
      sender,
      {
        sessionId: 'session-1',
        workspacePath: 'generated/castle.png',
        appCopy: 'aipg-media://media/castle.png',
      },
      'open',
    )

    expect(result).toEqual({ success: true })
    expect(open).toHaveBeenCalledWith(path.join(workspaceDir, 'generated', 'castle.png'))
  })

  it('falls back to the app copy once the workspace file is gone', async () => {
    await act(
      sender,
      {
        sessionId: 'session-1',
        workspacePath: 'generated/deleted.png',
        appCopy: 'aipg-media://media/castle.png',
      },
      'reveal',
    )

    expect(reveal).toHaveBeenCalledWith(path.join(mediaDir, 'castle.png'))
  })

  it('falls back to the app copy when the session has no workspace any more', async () => {
    await act(
      sender,
      {
        sessionId: 'gone',
        workspacePath: 'generated/castle.png',
        appCopy: path.join(audioDir, 'speech.wav'),
      },
      'saveAs',
    )

    expect(saveCopy).toHaveBeenCalledWith(sender, path.join(audioDir, 'speech.wav'))
  })

  it('drags the workspace copy', async () => {
    await act(
      sender,
      {
        sessionId: 'session-1',
        workspacePath: 'generated/castle.png',
        appCopy: 'aipg-media://media/castle.png',
      },
      'drag',
    )

    expect(drag).toHaveBeenCalledWith(sender, path.join(workspaceDir, 'generated', 'castle.png'))
  })

  it.each(['../secret.txt', path.join(root, 'secret.txt')])(
    'refuses a workspace path that escapes the workspace (%s)',
    async (workspacePath) => {
      const result = await act(
        sender,
        { sessionId: 'session-1', workspacePath, appCopy: 'aipg-media://media/castle.png' },
        'open',
      )

      expect(result.success).toBe(false)
      expect(open).not.toHaveBeenCalled()
    },
  )

  it('refuses a workspace symlink that points outside the workspace', async () => {
    const link = path.join(workspaceDir, 'generated', 'link.txt')
    fs.symlinkSync(path.join(root, 'secret.txt'), link)

    const result = await act(
      sender,
      {
        sessionId: 'session-1',
        workspacePath: 'generated/link.txt',
        appCopy: 'aipg-media://media/castle.png',
      },
      'open',
    )

    expect(result.success).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses an app copy outside the app media and audio folders', async () => {
    const result = await act(
      sender,
      { sessionId: 'gone', appCopy: path.join(root, 'secret.txt') },
      'open',
    )

    expect(result.success).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('fails when neither copy exists', async () => {
    const result = await act(
      sender,
      {
        sessionId: 'session-1',
        workspacePath: 'generated/deleted.png',
        appCopy: 'aipg-media://media/deleted.png',
      },
      'open',
    )

    expect(result.success).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
