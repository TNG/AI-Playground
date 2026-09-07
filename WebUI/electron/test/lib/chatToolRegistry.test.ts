import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonSchema, tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ChatToolExecution, ChatToolResult } from '@/types/chatIpc'
import {
  abortChatToolExecutions,
  activateChatToolSet,
  deactivateChatToolSet,
  serializeToolSet,
  setChatToolExecutionBridgeForTest,
} from '@/lib/chatToolRegistry'

type Execution = { callback: (payload: ChatToolExecution) => void; results: ChatToolResult[] }

function createExecutionBridge(): Execution & {
  bridge: {
    onToolExecution: (callback: (payload: ChatToolExecution) => void) => () => void
    toolResult: (payload: ChatToolResult) => Promise<void>
  }
  emit: (payload: ChatToolExecution) => void
  reset: () => void
} {
  let callback: ((payload: ChatToolExecution) => void) | undefined
  const results: ChatToolResult[] = []
  return {
    callback: undefined as never,
    results,
    bridge: {
      onToolExecution: (cb) => {
        callback = cb
        return () => (callback = undefined)
      },
      toolResult: (payload) => {
        results.push(payload)
        return Promise.resolve()
      },
    },
    emit: (payload) => callback?.(payload),
    reset: () => {
      results.length = 0
    },
  }
}

const execution = (overrides: Partial<ChatToolExecution> = {}): ChatToolExecution => ({
  requestId: 'req-1',
  conversationKey: 'conv-1',
  turnId: 't1',
  toolCallId: 'call-1',
  toolName: 'greet',
  input: { name: 'Ada' },
  ...overrides,
})

beforeEach(() => {
  setChatToolExecutionBridgeForTest(null)
})

describe('chat tool registry', () => {
  it('serializes zod and json-schema tools into specs', () => {
    const toolSet: ToolSet = {
      zodTool: tool({
        description: 'Greets',
        inputSchema: z.object({ name: z.string() }),
        execute: async () => 'hi',
      }),
      jsonTool: tool({
        description: 'Wrapped',
        inputSchema: jsonSchema({ type: 'object', properties: { a: { type: 'string' } } }),
        execute: async () => 'ok',
      }),
    }
    const specs = serializeToolSet(toolSet)
    expect(specs).toHaveLength(2)
    expect(specs[0]).toMatchObject({ name: 'zodTool', description: 'Greets' })
    expect(specs[0].inputSchema).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' } },
    })
    expect(specs[1].inputSchema).toMatchObject({
      type: 'object',
      properties: { a: { type: 'string' } },
    })
  })

  it('executes an activated tool and reports the output', async () => {
    const h = createExecutionBridge()
    setChatToolExecutionBridgeForTest(h.bridge)
    const seen: unknown[] = []
    const toolSet: ToolSet = {
      greet: tool({
        description: 'Greets',
        inputSchema: z.object({ name: z.string() }),
        execute: async (input, options) => {
          seen.push({ input, options })
          return { hello: (input as { name: string }).name }
        },
      }),
    }
    activateChatToolSet('conv-1', toolSet)
    h.emit(execution())

    await vi.waitFor(() => expect(h.results.length).toBe(1))
    expect(h.results[0]).toMatchObject({
      requestId: 'req-1',
      output: { hello: 'Ada' },
    })
    expect(seen[0]).toMatchObject({
      input: { name: 'Ada' },
      options: expect.objectContaining({
        toolCallId: 'call-1',
        conversationKey: 'conv-1',
        turnId: 't1',
        context: { conversationKey: 'conv-1' },
      }),
    })
  })

  it('validates input against the original zod schema before executing', async () => {
    const h = createExecutionBridge()
    setChatToolExecutionBridgeForTest(h.bridge)
    const executor = vi.fn(async () => 'never')
    const toolSet: ToolSet = {
      greet: tool({
        description: 'Greets',
        inputSchema: z.object({ name: z.string() }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: executor as any,
      }),
    }
    activateChatToolSet('conv-1', toolSet)
    h.emit(execution({ input: { name: 42 } }))

    await vi.waitFor(() => expect(h.results.length).toBe(1))
    expect(h.results[0].requestId).toBe('req-1')
    expect(h.results[0].error).toContain('Invalid tool input')
    expect(executor).not.toHaveBeenCalled()
  })

  it('reports an error for an unknown tool or conversation', async () => {
    const h = createExecutionBridge()
    setChatToolExecutionBridgeForTest(h.bridge)
    activateChatToolSet('conv-1', {
      greet: tool({ description: '', inputSchema: z.object({}), execute: async () => 1 }),
    })
    h.emit(execution({ toolName: 'nope' }))
    await vi.waitFor(() => expect(h.results.length).toBe(1))
    expect(h.results[0].error).toContain('not available')

    h.reset()
    h.emit(execution({ conversationKey: 'other-conv' }))
    await vi.waitFor(() => expect(h.results.length).toBe(1))
    expect(h.results[0].error).toContain('not available')
  })

  it('passes reconstructed conversation messages to tools that want them', async () => {
    const h = createExecutionBridge()
    setChatToolExecutionBridgeForTest(h.bridge)
    const seen: { messages?: unknown[] }[] = []
    const toolSet: ToolSet = {
      probe: tool({
        description: '',
        inputSchema: z.object({}),
        execute: async (_input, options) => {
          seen.push({ messages: options?.messages as unknown[] })
          return 'ok'
        },
      }),
    }
    activateChatToolSet('conv-1', toolSet, () => [
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'hello there' }],
      } as never,
    ])
    h.emit(execution({ toolName: 'probe' }))

    await vi.waitFor(() => expect(h.results.length).toBe(1))
    const flat = JSON.stringify(seen[0]?.messages)
    expect(flat).toContain('hello there')
  })

  it('aborts a running execution and flags the result as aborted', async () => {
    const h = createExecutionBridge()
    setChatToolExecutionBridgeForTest(h.bridge)
    let resolveExecution: (() => void) | undefined
    const toolSet: ToolSet = {
      slow: tool({
        description: '',
        inputSchema: z.object({}),
        execute: async (_input, options) => {
          await new Promise<void>((resolve) => {
            resolveExecution = resolve
            options?.abortSignal?.addEventListener('abort', () => resolve())
          })
          if (options?.abortSignal?.aborted) throw new Error('aborted mid-run')
          return 'done'
        },
      }),
    }
    activateChatToolSet('conv-1', toolSet)
    h.emit(execution({ toolName: 'slow' }))
    await vi.waitFor(() => expect(resolveExecution).toBeDefined())

    abortChatToolExecutions('conv-1')
    await vi.waitFor(() => expect(h.results.length).toBe(1))
    expect(h.results[0]).toMatchObject({
      requestId: 'req-1',
      aborted: true,
      error: 'aborted mid-run',
    })
  })

  it('deactivation makes the conversation answer with no active tool set', async () => {
    const h = createExecutionBridge()
    setChatToolExecutionBridgeForTest(h.bridge)
    activateChatToolSet('conv-1', {
      greet: tool({ description: '', inputSchema: z.object({}), execute: async () => 1 }),
    })
    deactivateChatToolSet('conv-1')
    h.emit(execution())
    await vi.waitFor(() => expect(h.results.length).toBe(1))
    expect(h.results[0].error).toContain('not available')
  })
})
