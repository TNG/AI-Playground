import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/tmp' },
  BrowserWindow: class {},
  net: {},
}))

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { mediaToolResult } = await import('../../agent/piCustomTools.ts')

describe("an Agent Preset media tool's details", () => {
  const done = { id: 'd1', type: 'image', imageUrl: 'aipg-media://sessions/s1/files/d1.png' }
  const slot = {
    id: 'f1',
    type: 'image',
    state: 'failed',
    imageUrl: '',
    mode: 'imageGen',
    settings: { width: 1024, height: 768 },
  }

  it('keeps the finished items, the failed slots and the full error of a failed run', () => {
    const { details } = mediaToolResult({
      success: false,
      state: 'failed',
      message: 'ComfyUI generation failed: out of memory',
      error: 'out of memory',
      images: [done],
      unfinished: [slot],
    })

    expect(details?.items?.map((item) => [item.id, item.state])).toEqual([
      ['d1', 'done'],
      ['f1', 'failed'],
    ])
    expect(details?.failure).toEqual({ state: 'failed', error: 'out of memory' })
  })

  it('records a run cancelled before it generated anything', () => {
    const { details } = mediaToolResult({
      success: false,
      message: 'Generation cancelled.',
      images: [],
    })

    expect(details).toEqual({ items: [], failure: { state: 'cancelled' } })
  })

  it('records no failure for a run that completed', () => {
    expect(mediaToolResult({ images: [done] }).details?.failure).toBeUndefined()
  })
})
