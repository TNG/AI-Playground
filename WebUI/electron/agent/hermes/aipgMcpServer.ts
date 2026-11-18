import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

// Hermes reaches AIPG's own tools (image generation and editing) over MCP. The tools are the very
// Pi tool definitions an agent session would get, so a Hermes call saves into the workspace and
// returns the same result, which is what lets the renderer show it as a Pi media card.

export type AipgMcpToolResult = {
  content: { type: string; text?: string; data?: string; mimeType?: string }[]
  details?: unknown
  isError?: boolean
}

/** The turn Hermes is serving; only one runs at a time, so its tools are the whole catalog. */
export type AipgMcpTurn = {
  tools: ToolDefinition[]
  signal: AbortSignal
  onResult: (toolName: string, result: AipgMcpToolResult) => void
}

export type AipgMcpServer = {
  url: string
  key: string
  setTurn(turn: AipgMcpTurn | null): void
  close(): Promise<void>
}

function bearerMatches(header: string | undefined, key: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '')
  const expected = Buffer.from(key)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

function asMcpContent(content: AipgMcpToolResult['content']): McpContent[] {
  return content.flatMap((part): McpContent[] => {
    if (part.type === 'text') return [{ type: 'text' as const, text: part.text ?? '' }]
    if (part.type === 'image' && part.data && part.mimeType) {
      return [{ type: 'image' as const, data: part.data, mimeType: part.mimeType }]
    }
    return []
  })
}

let callCount = 0

/** One stateless MCP server per request: Hermes needs no session, and the catalog is per turn. */
function createMcpServer(getTurn: () => AipgMcpTurn | null): Server {
  const server = new Server({ name: 'aipg', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (getTurn()?.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as { type: 'object'; [key: string]: unknown },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const turn = getTurn()
    const tool = turn?.tools.find((candidate) => candidate.name === request.params.name)
    if (!turn || !tool) {
      return {
        content: [{ type: 'text', text: `Tool ${request.params.name} is not available now.` }],
        isError: true,
      }
    }
    let result: AipgMcpToolResult
    try {
      result = (await tool.execute(
        `hermes-mcp-${(callCount += 1)}`,
        request.params.arguments ?? {},
        turn.signal,
        undefined,
        undefined as never,
      )) as AipgMcpToolResult
    } catch (error) {
      result = {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
    turn.onResult(tool.name, result)
    return { content: asMcpContent(result.content), ...(result.isError ? { isError: true } : {}) }
  })
  return server
}

export async function startAipgMcpServer(key: string): Promise<AipgMcpServer> {
  let turn: AipgMcpTurn | null = null

  const httpServer = http.createServer(async (req, res) => {
    if (!bearerMatches(req.headers.authorization, key)) {
      res.writeHead(401, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    const mcp = createMcpServer(() => turn)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error) }))
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = httpServer.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    key,
    setTurn(next) {
      turn = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections()
        httpServer.close(() => resolve())
      }),
  }
}
