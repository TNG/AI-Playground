import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  startAipgMcpServer,
  type AipgMcpServer,
  type AipgMcpToolResult,
} from '../../agent/hermes/aipgMcpServer'

// Hermes calls AIPG's media tools over MCP; the server must list the turn's Pi tools, run them,
// and hand the full result (details included) back to the turn runner for the media card.

const KEY = 'mcp-key-0123456789abcdef'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

function stubTool(result: AipgMcpToolResult, calls: unknown[]): ToolDefinition {
  return {
    name: 'generateImage',
    label: 'Generate image',
    description: 'Generates an image',
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    },
    execute: async (_id: string, args: unknown) => {
      calls.push(args)
      return result
    },
  } as unknown as ToolDefinition
}

async function connect(server: AipgMcpServer, key = KEY): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  )
  cleanup.push(() => client.close())
  return client
}

async function start(): Promise<AipgMcpServer> {
  const server = await startAipgMcpServer(KEY)
  cleanup.push(server.close)
  return server
}

describe('AIPG MCP server for Hermes', () => {
  it('refuses a client without the key', async () => {
    const server = await start()
    await expect(connect(server, 'wrong-key-0123456789abc')).rejects.toThrow()
  })

  it('lists no tools outside a turn and the turn tools inside one', async () => {
    const server = await start()
    const client = await connect(server)
    expect((await client.listTools()).tools).toEqual([])

    server.setTurn({
      tools: [stubTool({ content: [] }, [])],
      signal: new AbortController().signal,
      onResult: () => {},
    })
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['generateImage'])
    expect(tools[0].inputSchema).toMatchObject({ required: ['prompt'] })
  })

  it('runs a tool and reports its full result to the turn', async () => {
    const server = await start()
    const calls: unknown[] = []
    const results: [string, AipgMcpToolResult][] = []
    const full: AipgMcpToolResult = {
      content: [
        { type: 'text', text: 'Saved images/cover.png' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ],
      details: { items: [{ path: 'images/cover.png' }] },
    }
    server.setTurn({
      tools: [stubTool(full, calls)],
      signal: new AbortController().signal,
      onResult: (name, result) => results.push([name, result]),
    })
    const client = await connect(server)
    const reply = await client.callTool({ name: 'generateImage', arguments: { prompt: 'a cat' } })

    expect(calls).toEqual([{ prompt: 'a cat' }])
    expect(reply.content).toEqual([
      { type: 'text', text: 'Saved images/cover.png' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])
    expect(results).toEqual([['generateImage', full]])
  })

  it('answers an unknown tool with an error result', async () => {
    const server = await start()
    const client = await connect(server)
    const reply = await client.callTool({ name: 'missing', arguments: {} })
    expect(reply.isError).toBe(true)
  })
})
