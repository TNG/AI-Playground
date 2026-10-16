import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => os.tmpdir()) },
  BrowserWindow: class {},
  net: {},
}))

const { workspaceAudioDataUri } = await import('../../agent/piCustomTools.ts')

let workspaceDir: string

describe('workspaceAudioDataUri', () => {
  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-audio-'))
  })

  it('reads a clip under generated/ as a wav data URI', async () => {
    fs.mkdirSync(path.join(workspaceDir, 'generated'))
    fs.writeFileSync(path.join(workspaceDir, 'generated', 'speech.wav'), 'riff')

    const uri = await workspaceAudioDataUri(workspaceDir, 'generated/speech.wav')

    expect(uri).toBe(`data:audio/wav;base64,${Buffer.from('riff').toString('base64')}`)
  })

  it('rejects a path that escapes the workspace and a non-audio file', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'notes.txt'), 'x')

    await expect(workspaceAudioDataUri(workspaceDir, '../outside.wav')).rejects.toThrow(
      /escapes the workspace/,
    )
    await expect(workspaceAudioDataUri(workspaceDir, 'notes.txt')).rejects.toThrow(
      /Unsupported audio file type/,
    )
  })
})
