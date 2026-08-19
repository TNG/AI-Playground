import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    isPackaged: false,
    getAppPath: () => '/tmp',
  },
}))

type StartArgs = { name: string; parentSpanContext?: unknown }

const started: StartArgs[] = []
const ended: string[] = []

/**
 * Enough of the SDK to see what the bridge asked for: which spans it created,
 * what it parented them to, and whether it closed them again.
 */
vi.mock('@lmnr-ai/lmnr', () => ({
  Laminar: {
    initialized: () => true,
    startSpan: (args: StartArgs) => {
      started.push(args)
      return {
        name: args.name,
        setAttributes: () => {},
        setAttribute: () => {},
        setStatus: () => {},
        end: () => ended.push(args.name),
      }
    },
    // The real one derives this from the span's own attributes; a stand-in that
    // names the span is enough to tell "parented to the tool span" from "root".
    getLaminarSpanContext: (span: { name?: string }) => ({ spanPath: [span.name] }),
  },
}))

const { handleSpanEvent, noteSpanEnd, noteSpanStart } = await import('../laminarSpans.ts')

/** A span as a processor sees it: Pi sets the type at creation. */
function toolSpan(name: string, spanId: string) {
  return {
    name,
    attributes: { 'lmnr.span.type': 'TOOL' },
    spanContext: () => ({ spanId }),
  }
}

async function start(event: Record<string, unknown>) {
  await handleSpanEvent('aipgSpanStart', JSON.stringify(event))
}

describe('renderer span bridge', () => {
  beforeEach(() => {
    started.length = 0
    ended.length = 0
  })

  it('nests a span under the open media tool span', async () => {
    const media = toolSpan('media', 'aa')
    noteSpanStart(media)
    await start({ id: '1', name: 'comfyui.generate' })
    expect(started).toHaveLength(1)
    expect(started[0].parentSpanContext).toEqual({ spanPath: ['media'] })
    noteSpanEnd(media)
  })

  it('nests a span under the AI SDK tool span, which has no type yet at start', async () => {
    const tool = { name: 'ai.tool comfyUI', attributes: {}, spanContext: () => ({ spanId: 'bb' }) }
    noteSpanStart(tool)
    await start({ id: '1', name: 'comfyui.generate' })
    expect(started[0].parentSpanContext).toEqual({ spanPath: ['ai.tool comfyUI'] })
    noteSpanEnd(tool)
  })

  it('parents to the oldest open tool span, which is the run being served', async () => {
    const first = toolSpan('media', 'aa')
    const second = toolSpan('media', 'bb')
    noteSpanStart(first)
    noteSpanStart(second)
    await start({ id: '1', name: 'comfyui.generate' })
    expect(started[0].parentSpanContext).toEqual({ spanPath: ['media'] })
    // The first call's generation finished, so the next one belongs to the second.
    noteSpanEnd(first)
    await start({ id: '2', name: 'comfyui.generate' })
    expect(started[1].parentSpanContext).toEqual({ spanPath: ['media'] })
    noteSpanEnd(second)
  })

  it('ignores tool spans that are not media ones', async () => {
    const other = toolSpan('read', 'cc')
    noteSpanStart(other)
    await start({ id: '1', name: 'comfyui.generate' })
    expect(started[0].parentSpanContext).toBeUndefined()
    noteSpanEnd(other)
  })

  it('makes a desktop generation its own root', async () => {
    await start({ id: '1', name: 'comfyui.generate' })
    expect(started[0].parentSpanContext).toBeUndefined()
  })

  it('parents an explicit child to the span it names, and ends what it started', async () => {
    await start({ id: '1', name: 'comfyui.generate' })
    await start({ id: '2', name: 'comfyui.generating', parentId: '1' })
    expect(started[1].parentSpanContext).toEqual({ spanPath: ['comfyui.generate'] })
    await handleSpanEvent('aipgSpanEnd', JSON.stringify({ id: '2' }))
    await handleSpanEvent('aipgSpanEnd', JSON.stringify({ id: '1' }))
    expect(ended).toEqual(['comfyui.generating', 'comfyui.generate'])
    // An id nobody started (a reload mid-generation) is dropped, not thrown.
    await handleSpanEvent('aipgSpanEnd', JSON.stringify({ id: '404' }))
    expect(ended).toHaveLength(2)
  })
})
