import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import type { AgentToolSpec } from '@/types/agentIpc'
import { SCREENSHOT_WINDOW_QUERY } from '@/types/agentCapabilities'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => os.tmpdir()) },
  BrowserWindow: class {},
  net: {},
}))
vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../agent/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))

const captureWindow = vi.fn()
vi.mock('../../adapters/hardware/screenCapture.ts', () => ({ captureWindow }))

const executeToolInRenderer = vi.fn()
const sendToolImage = vi.fn()
vi.mock('../../agent/piCustomTools.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeToolInRenderer,
  sendToolImage,
}))

const { mediaCapability } = await import('../../agent/capabilities/media.ts')

const SCREENSHOT_SPEC: AgentToolSpec = {
  name: 'captureScreenshot',
  description: 'Capture the bound window',
  inputSchema: { type: 'object', properties: {} },
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
type Tool = {
  name: string
  execute: (id: string, params: unknown) => Promise<{ content: Content[] }>
}

async function tools(supportsVision: boolean): Promise<Record<string, Tool>> {
  const host = { sessionId: 's1', workspaceDir: os.tmpdir(), toolSpecs: [SCREENSHOT_SPEC] }
  const built = (await mediaCapability.buildTools?.({
    ...host,
    supportsVision,
  } as never)) as unknown as Tool[]
  return Object.fromEntries(built.map((tool) => [tool.name, tool]))
}

describe('the desktop screenshot tool', () => {
  beforeEach(() => {
    captureWindow.mockReset()
    executeToolInRenderer.mockReset()
    sendToolImage.mockReset()
  })

  it('is not offered to a model that cannot see images', async () => {
    expect(Object.keys(await tools(false))).not.toContain('captureScreenshot')
  })

  it('captures the window the user bound and hands the image to the model', async () => {
    executeToolInRenderer.mockResolvedValueOnce({ id: 'window:42', name: 'Calculator' })
    captureWindow.mockResolvedValueOnce('data:image/png;base64,iVBORw0KGgo=')
    const result = await (await tools(true)).captureScreenshot.execute('call-1', {})
    expect(executeToolInRenderer).toHaveBeenCalledWith(
      's1',
      SCREENSHOT_WINDOW_QUERY,
      {},
      'call-1',
      undefined,
    )
    expect(captureWindow).toHaveBeenCalledWith({ id: 'window:42', name: 'Calculator' })
    expect(result.content).toContainEqual({
      type: 'image',
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    })
    expect(sendToolImage).toHaveBeenCalledWith(
      's1',
      'call-1',
      'data:image/png;base64,iVBORw0KGgo=',
      'Calculator',
    )
  })

  it('tells the model to ask for a window when none is bound', async () => {
    executeToolInRenderer.mockResolvedValueOnce(null)
    const result = await (await tools(true)).captureScreenshot.execute('call-2', {})
    expect(captureWindow).not.toHaveBeenCalled()
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('No window is selected') },
    ])
  })

  it('reports a failed capture as text', async () => {
    executeToolInRenderer.mockResolvedValueOnce({ id: 'window:42', name: 'Calculator' })
    captureWindow.mockRejectedValueOnce(new Error('Screen Recording permission is required'))
    const result = await (await tools(true)).captureScreenshot.execute('call-3', {})
    expect(result.content).toEqual([
      { type: 'text', text: 'Screen Recording permission is required' },
    ])
  })
})
