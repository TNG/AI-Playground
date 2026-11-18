import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '../../agent/piStreamTranslate'
import {
  aipgToolNameOf,
  createHermesStreamTranslator,
  readSseEvents,
  type HermesRunEvent,
} from '../../agent/hermes/hermesStreamTranslate'

// A Hermes run reaches the renderer through the Pi translator, so these assert the chunks Agent
// Mode renders: text, reasoning, tool cards under the AIPG tool name, and a settled finish.

function run(
  events: HermesRunEvent[],
  options: { aipgToolNames?: string[]; takeAipgResult?: (name: string) => unknown } = {},
) {
  const chunks: StreamChunk[] = []
  const approvals: HermesRunEvent[] = []
  const translator = createHermesStreamTranslator({
    emit: (chunk) => chunks.push(chunk),
    model: 'LFM2.5-350M-Q4_K_M.gguf',
    onApprovalRequest: (event) => approvals.push(event),
    ...options,
  })
  for (const event of events) {
    translator.handle(event)
    if (translator.isTerminal(event)) break
  }
  translator.finish()
  return { chunks, approvals, types: chunks.map((chunk) => String(chunk.type)) }
}

const textOf = (chunks: StreamChunk[], type: string) =>
  chunks
    .filter((chunk) => chunk.type === type)
    .map((chunk) => String((chunk as { delta?: string }).delta ?? ''))
    .join('')

describe('Hermes run events as Agent Mode chunks', () => {
  it('streams text deltas as one text part and closes the turn', () => {
    const { chunks, types } = run([
      { event: 'message.delta', delta: 'Hello ' },
      { event: 'message.delta', delta: 'there' },
      { event: 'run.completed', output: 'Hello there', usage: { input_tokens: 5 } },
    ])
    expect(textOf(chunks, 'text-delta')).toBe('Hello there')
    expect(types).toContain('text-end')
    expect(types.at(-1)).toBe('finish')
  })

  it('falls back to the run output when nothing was streamed', () => {
    const { chunks } = run([{ event: 'run.completed', output: 'Only the output' }])
    expect(textOf(chunks, 'text-delta')).toBe('Only the output')
  })

  it('renders reasoning as a reasoning part', () => {
    const { chunks } = run([
      { event: 'reasoning.available', text: 'Thinking it over' },
      { event: 'message.delta', delta: 'Answer' },
      { event: 'run.completed' },
    ])
    expect(textOf(chunks, 'reasoning-delta')).toBe('Thinking it over')
    expect(textOf(chunks, 'text-delta')).toBe('Answer')
  })

  it('names an AIPG MCP tool by its own name and returns its full result', () => {
    const result = {
      content: [{ type: 'text', text: 'Generated 1 image.' }],
      details: { items: [{ path: 'images/cover.png' }] },
    }
    const { chunks } = run(
      [
        { event: 'tool.started', tool: 'mcp__aipg__generateimage', tool_call_id: 'c1' },
        { event: 'tool.completed', tool: 'mcp__aipg__generateimage', tool_call_id: 'c1' },
        { event: 'run.completed', output: 'Done' },
      ],
      { aipgToolNames: ['generateImage'], takeAipgResult: () => result },
    )
    const input = chunks.find((chunk) => chunk.type === 'tool-input-available') as
      { toolName?: string } | undefined
    expect(input?.toolName).toBe('generateImage')
    const output = chunks.find((chunk) => chunk.type === 'tool-output-available') as
      { output?: unknown } | undefined
    expect(JSON.stringify(output?.output)).toContain('images/cover.png')
  })

  it('keeps Hermes-native tools under their own names with a summary result', () => {
    const { chunks } = run([
      { event: 'tool.started', tool: 'terminal', preview: 'ls', tool_call_id: 't1' },
      { event: 'tool.completed', tool: 'terminal', duration: 0.4, tool_call_id: 't1' },
      { event: 'run.completed' },
    ])
    const input = chunks.find((chunk) => chunk.type === 'tool-input-available') as
      { toolName?: string } | undefined
    expect(input?.toolName).toBe('terminal')
    const output = chunks.find((chunk) => chunk.type === 'tool-output-available')
    expect(JSON.stringify(output)).toContain('Done in 0.4s.')
  })

  it('hands approval requests to the caller', () => {
    const { approvals } = run([
      { event: 'approval.request', command: 'rm -rf /', request_id: 'r1' },
      { event: 'run.completed' },
    ])
    expect(approvals).toHaveLength(1)
  })

  it('treats failure, cancel and interrupt as terminal', () => {
    const translator = createHermesStreamTranslator({ emit: () => {} })
    for (const event of ['run.failed', 'run.cancelled', 'run.interrupted', 'run.completed']) {
      expect(translator.isTerminal({ event })).toBe(true)
    }
    expect(translator.isTerminal({ event: 'message.delta' })).toBe(false)
  })
})

describe('aipgToolNameOf', () => {
  it('maps only the aipg server prefix, case-insensitively', () => {
    const known = ['generateImage', 'editImage']
    expect(aipgToolNameOf('mcp__aipg__editImage', known)).toBe('editImage')
    expect(aipgToolNameOf('mcp__aipg__EDITIMAGE', known)).toBe('editImage')
    expect(aipgToolNameOf('mcp__other__editImage', known)).toBeUndefined()
    expect(aipgToolNameOf('generateImage', known)).toBeUndefined()
  })
})

describe('readSseEvents', () => {
  it('parses data blocks split across chunks and skips non-JSON', async () => {
    const encoder = new TextEncoder()
    async function* body() {
      yield encoder.encode('data: {"event":"message.delta","del')
      yield encoder.encode('ta":"a"}\n\n: keepalive\n\ndata: not json\n\n')
      yield encoder.encode('data: {"event":"run.completed"}\r\n\r\n')
    }
    const events: HermesRunEvent[] = []
    for await (const event of readSseEvents(body())) events.push(event)
    expect(events.map((event) => event.event)).toEqual(['message.delta', 'run.completed'])
  })
})
