import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false, getAppPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
}))

vi.mock('../../kernel/developerMode.ts', () => ({ isDeveloperMode: () => false }))

const hermesService = vi.fn()
vi.mock('../../agent/hermes/hermesIntegration.ts', () => ({
  hermesService,
  hermesIntegration: vi.fn(),
}))

const { startHermesTurn } = await import('../../agent/hermes/hermesTurnRunner')

// A Session that picked Hermes on a developer build keeps its harness; an installed build without
// the debug settings must still refuse to start Hermes' unsandboxed shell for it.

describe('Hermes outside developer mode', () => {
  it('refuses the turn before touching the sidecar', async () => {
    const result = await startHermesTurn('turn-1', 'hi', {
      sessionId: 'aipg-agent-gate',
      workspaceDir: '/tmp',
      harness: 'hermes',
      modelConfig: { source: 'local', model: 'm', backend: 'llamaCPP', baseUrl: 'http://x' },
    } as never)
    expect(result).toMatchObject({ success: false })
    expect(!result.success && result.error).toMatch(/developer preview/)
    expect(hermesService).not.toHaveBeenCalled()
  })
})
