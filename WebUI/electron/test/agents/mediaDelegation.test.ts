import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type { AgentToolSpec } from '@/types/agentIpc'

// The `media` delegation tool stays a renderer proxy (mediaDelegation.ts): the
// media specialist it dispatches to is renderer-side. What main owns here is
// the path handling around the dispatch — workspace paths become data URIs on
// the way in, generated media is saved into the workspace on the way out.

const executeToolInRendererMock =
  vi.fn<(name: string, input: unknown, id?: string, signal?: AbortSignal) => Promise<unknown>>()
const saveMediaMock = vi.fn<(result: unknown, workspaceDir: string) => Promise<unknown>>()

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../agentMode/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))

vi.mock('../../agentMode/piCustomTools.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agentMode/piCustomTools.ts')>()
  return {
    ...actual,
    executeToolInRenderer: executeToolInRendererMock,
    saveGeneratedMediaToWorkspace: saveMediaMock,
    jsonResult: (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] }),
  }
})

const { buildDelegatedMediaTool } = await import('../../agentMode/capabilities/mediaDelegation.ts')

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-delegation-'))

const MEDIA_SPEC: AgentToolSpec = {
  name: 'media',
  description: 'create or transform media',
  inputSchema: { type: 'object' },
  workspacePathInputs: ['sourceImagePath'],
}

function hostWith() {
  return {
    sessionId: 'session-1',
    workspaceDir,
    toolSpecs: [MEDIA_SPEC],
    agentDir: workspaceDir,
    keepModelsLoaded: false,
  }
}

describe('mediaDelegation (bridged media tool)', () => {
  beforeEach(() => {
    executeToolInRendererMock.mockReset()
    saveMediaMock.mockReset().mockImplementation(async (result) => result)
  })

  it('dispatches to the renderer under the spec name and id', async () => {
    executeToolInRendererMock.mockResolvedValueOnce({ success: true, images: [] })
    const tool = (await buildDelegatedMediaTool(hostWith(), MEDIA_SPEC)) as unknown as {
      name: string
      execute: (id: string, params: unknown, signal: AbortSignal) => Promise<unknown>
    }
    const controller = new AbortController()

    await tool.execute('call-1', { request: 'a castle' }, controller.signal)

    expect(tool.name).toBe('media')
    expect(executeToolInRendererMock).toHaveBeenCalledWith(
      'media',
      { request: 'a castle' },
      'call-1',
      controller.signal,
    )
    expect(saveMediaMock).toHaveBeenCalledWith({ success: true, images: [] }, workspaceDir)
  })

  it('resolves a workspace source path to a data URI before dispatching', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
    executeToolInRendererMock.mockResolvedValueOnce({ images: [] })
    const tool = (await buildDelegatedMediaTool(hostWith(), MEDIA_SPEC)) as unknown as {
      execute: (id: string, params: unknown, signal: AbortSignal) => Promise<unknown>
    }

    await tool.execute(
      'call-1',
      { request: 'edit this', sourceImagePath: 'shot.png' },
      new AbortController().signal,
    )

    const dispatched = executeToolInRendererMock.mock.calls[0][1] as Record<string, unknown>
    expect(String(dispatched.sourceImagePath)).toMatch(/^data:image\/png;base64,/)
  })

  it('forwards the abort signal to the renderer dispatch', async () => {
    executeToolInRendererMock.mockResolvedValueOnce({ images: [] })
    const tool = (await buildDelegatedMediaTool(hostWith(), MEDIA_SPEC)) as unknown as {
      execute: (id: string, params: unknown, signal: AbortSignal) => Promise<unknown>
    }
    const controller = new AbortController()

    await tool.execute('call-1', { request: 'x' }, controller.signal)

    expect(executeToolInRendererMock.mock.calls[0][3]).toBe(controller.signal)
  })
})
