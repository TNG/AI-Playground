import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The workspace preview server serves the agent's files to the browser tool. It
// runs in the main process, so a read failure there is not a 500 — it is an
// uncaught exception and an Electron crash dialog. That happens for real on
// macOS: the privacy layer hands out metadata for a folder under ~/Documents
// while refusing to open the files inside it (EPERM).

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
  BrowserWindow: class {},
}))

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../subprocesses/agentBrowser.ts', () => ({
  closeBrowserSession: vi.fn(),
}))

const { ensureWorkspaceRuntime, closeWorkspaceRuntime } =
  await import('../../agentMode/piWorkspaceRuntime.ts')

let workspace: string

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-preview-'))
})

afterEach(() => {
  closeWorkspaceRuntime()
})

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
})

async function serve(fileName: string): Promise<Response> {
  const runtime = await ensureWorkspaceRuntime('session-1', workspace)
  expect(runtime.baseUrl).toBeTruthy()
  return await fetch(new URL(fileName, runtime.baseUrl!))
}

describe('workspace preview server', () => {
  it('serves a workspace file', async () => {
    fs.writeFileSync(path.join(workspace, 'index.html'), '<h1>hi</h1>')

    const response = await serve('index.html')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toBe('<h1>hi</h1>')
  })

  it('answers with an error instead of crashing when the file cannot be opened', async () => {
    const unreadable = path.join(workspace, 'locked.html')
    fs.writeFileSync(unreadable, '<h1>secret</h1>')
    fs.chmodSync(unreadable, 0o000)

    const response = await serve('locked.html')

    expect(response.status).toBe(500)
    expect(await response.text()).toContain('locked.html')
  })
})
