import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio'
import { appLoggerInstance } from '../logging/logger'
import { mcpServers, type McpServerConfig } from './mcpServers'

export type McpConnectionState = 'stopped' | 'starting' | 'running' | 'error'

export type McpStatus = {
  state: McpConnectionState
  lastError?: string
}

export type McpToolInfo = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export type McpServerInfo = {
  id: string
  name: string
}

export type McpToolCallResult = {
  isError?: boolean
  content?: unknown
  structuredContent?: unknown
}

const clients = new Map<string, MCPClient>()
const statuses = new Map<string, McpStatus>()

function ensureStatus(serverId: string) {
  if (!statuses.has(serverId)) {
    statuses.set(serverId, { state: 'stopped' })
  }
}

function getServerConfig(serverId: string): McpServerConfig {
  const config = mcpServers[serverId]
  if (!config) {
    throw new Error(`Unknown MCP server id: ${serverId}`)
  }
  return config
}

export function listMcpServers(): McpServerInfo[] {
  return Object.values(mcpServers).map((server) => ({
    id: server.id,
    name: server.name,
  }))
}

function setStatus(serverId: string, next: McpStatus) {
  statuses.set(serverId, next)
}

export function getMcpServerStatus(serverId: string): McpStatus {
  ensureStatus(serverId)
  return statuses.get(serverId) ?? { state: 'stopped' }
}

export async function startMcpServer(serverId: string): Promise<McpStatus> {
  ensureStatus(serverId)

  if (clients.has(serverId)) {
    return getMcpServerStatus(serverId)
  }

  const config = getServerConfig(serverId)
  setStatus(serverId, { state: 'starting' })

  try {
    const mergedEnv = {
      ...process.env,
      ...(config.env ?? {}),
    }
    const stdioEnv = Object.fromEntries(
      Object.entries(mergedEnv).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )

    const transport = new Experimental_StdioMCPTransport({
      command: config.command,
      args: config.args,
      env: stdioEnv,
    })

    const client = await createMCPClient({
      transport,
      name: `ai-playground-${serverId}-mcp-client`,
      version: '1.0.0',
    })

    clients.set(serverId, client)
    setStatus(serverId, { state: 'running' })
    appLoggerInstance.info(`MCP server started: ${config.name}`, 'mcp')
    return getMcpServerStatus(serverId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setStatus(serverId, { state: 'error', lastError: message })
    appLoggerInstance.error(`Failed to start MCP server ${serverId}: ${message}`, 'mcp')
    return getMcpServerStatus(serverId)
  }
}

export async function stopMcpServer(serverId: string): Promise<McpStatus> {
  ensureStatus(serverId)
  const client = clients.get(serverId)

  if (!client) {
    setStatus(serverId, { state: 'stopped' })
    return getMcpServerStatus(serverId)
  }

  try {
    await client.close()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appLoggerInstance.warn(`Error while stopping MCP server ${serverId}: ${message}`, 'mcp')
  } finally {
    clients.delete(serverId)
    setStatus(serverId, { state: 'stopped' })
  }

  appLoggerInstance.info(`MCP server stopped: ${serverId}`, 'mcp')
  return getMcpServerStatus(serverId)
}

export async function listMcpServerTools(serverId: string): Promise<McpToolInfo[]> {
  const client = clients.get(serverId)
  if (!client || getMcpServerStatus(serverId).state !== 'running') {
    return []
  }

  const allTools: McpToolInfo[] = []
  let cursor: string | undefined

  do {
    const { tools, nextCursor } = await client.listTools({
      params: { cursor },
    })
    allTools.push(
      ...tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      })),
    )
    cursor = nextCursor
  } while (cursor)

  return allTools
}

export async function invokeMcpServerTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  const client = clients.get(serverId)
  if (!client || getMcpServerStatus(serverId).state !== 'running') {
    return {
      isError: true,
      content: [{ type: 'text', text: `MCP server ${serverId} is not running` }],
    }
  }

  try {
    const tools = await client.tools()
    const targetTool = tools[toolName]

    if (!targetTool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `MCP tool not found: ${toolName}` }],
      }
    }

    // MCP tools are AI SDK tools, execute through the AI SDK contract.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (targetTool.execute as any)?.(args, {
      toolCallId: `mcp-${Date.now()}`,
      messages: [],
    })

    return {
      isError: false,
      structuredContent: result,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appLoggerInstance.error(`Failed to call MCP tool ${toolName} on ${serverId}: ${message}`, 'mcp')
    return {
      isError: true,
      content: [{ type: 'text', text: `Failed to call MCP tool ${toolName}: ${message}` }],
    }
  }
}

export async function stopAllMcpServers(): Promise<void> {
  const serverIds = [...clients.keys()]
  await Promise.all(serverIds.map((serverId) => stopMcpServer(serverId)))
}
