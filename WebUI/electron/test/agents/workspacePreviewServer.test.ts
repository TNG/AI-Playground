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

const { ensureWorkspaceRuntime, closeWorkspaceRuntime, buildWorkspaceInstructions } =
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

  // Windows ignores a chmod of the read bit, so the file stays readable and
  // there is no failure to answer with.
  it.skipIf(process.platform === 'win32')(
    'answers with an error instead of crashing when the file cannot be opened',
    async () => {
      const unreadable = path.join(workspace, 'locked.html')
      fs.writeFileSync(unreadable, '<h1>secret</h1>')
      fs.chmodSync(unreadable, 0o000)

      const response = await serve('locked.html')

      expect(response.status).toBe(500)
      expect(await response.text()).toContain('locked.html')
    },
  )
})

describe('workspace instructions', () => {
  const options = {
    cwd: '/workspace',
    workspaceDir: 'C:\\games\\space',
    baseUrl: 'http://127.0.0.1:45678/',
    unsandboxed: false,
  }

  it('names the JavaScript interpreter the sandbox actually ships', () => {
    // `js` is not a command in the emulated shell; inventing one costs the
    // model a turn on "command not found".
    expect(buildWorkspaceInstructions(options)).toContain('js-exec')
  })

  it('offers python3 where the emulated shell can run it', () => {
    const instructions = buildWorkspaceInstructions({ ...options, emulatedPython: true })

    expect(instructions).toContain('python3')
    expect(instructions).toContain('heredoc')
  })

  it('does not offer python3 where every invocation would fail', () => {
    const instructions = buildWorkspaceInstructions({ ...options, emulatedPython: false })

    expect(instructions).toContain('There is no python3 in this shell')
    expect(instructions).not.toContain('heredoc')
  })
})
