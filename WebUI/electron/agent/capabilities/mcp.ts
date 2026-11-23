import { createHash } from 'node:crypto'
import { asSchema, type ToolSet } from 'ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { appLoggerInstance } from '../../observability/logger.ts'
import { getMcpServerTools } from '../../adapters/mcp/mcpManager.ts'
import { jsonResult, jsonSchemaParameters } from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import type { AgentCapability } from './types.ts'
import { mcpCapabilityId } from '@/types/agentCapabilities'

export { MCP_CAPABILITY_PREFIX, mcpCapabilityId, mcpServerIdOf } from '@/types/agentCapabilities'

// ── MCP capabilities ─────────────────────────────────────────────────────────
//
// One capability per configured MCP server (`mcp:<serverId>`). Pi 1.0 ships its
// own MCP client; this stays on mcpManager so Chat and the settings UI share it.
// Servers are started on demand by mcpManager, which also owns their lifetime
// (shared with the app's MCP UI, stopped on app quit), so nothing is closed on
// session teardown.

const logger = appLoggerInstance
const LOG_SOURCE = 'capabilities/mcp'

const MAX_TOOL_NAME_LENGTH = 64

/** The server id in the name keeps two servers' same-named tools from shadowing each other. */
function createMcpToolName(
  serverId: string,
  toolName: string,
  isTaken: (name: string) => boolean,
): string {
  const name = `mcp__${serverId}__${toolName}`.replace(/[^A-Za-z0-9_]/g, '_')
  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name
  const hash = createHash('sha256').update(`${serverId}\0${toolName}`).digest('hex').slice(0, 8)
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`
}

async function buildMcpTools(serverId: string): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  let tools: ToolSet
  try {
    tools = await getMcpServerTools(serverId)
  } catch (error) {
    // A broken MCP config must not take down the whole agent turn.
    logger.warn(`failed to attach MCP server '${serverId}': ${error}`, LOG_SOURCE)
    return []
  }
  const definitions: ToolDefinition[] = []
  const takenNames = new Set<string>()
  for (const [name, mcpTool] of Object.entries(tools)) {
    const execute = mcpTool.execute
    if (!execute) continue
    const inputSchema = asSchema(mcpTool.inputSchema).jsonSchema as Record<string, unknown>
    // MCP tool descriptions are plain strings; the AI SDK type also allows a
    // context-dependent function, which MCP never produces.
    const description =
      typeof mcpTool.description === 'string'
        ? mcpTool.description
        : `MCP tool ${name} from ${serverId}`
    const toolName = createMcpToolName(serverId, name, (candidate) => takenNames.has(candidate))
    takenNames.add(toolName)
    definitions.push(
      pi.defineTool({
        name: toolName,
        label: name,
        description,
        parameters: jsonSchemaParameters(inputSchema),
        execute: async (toolCallId, params, signal) => {
          const result = await execute(params, {
            toolCallId,
            messages: [],
            context: undefined,
            ...(signal ? { abortSignal: signal } : {}),
          })
          return jsonResult(result)
        },
      }) as ToolDefinition,
    )
  }
  logger.info(`attached ${definitions.length} MCP tool(s) from '${serverId}'`, LOG_SOURCE)
  return definitions
}

/** The capability record for one configured MCP server. */
export function mcpCapability(serverId: string): AgentCapability {
  return {
    id: mcpCapabilityId(serverId),
    label: `MCP: ${serverId}`,
    summary: `Tools from the '${serverId}' MCP server.`,
    buildTools: () => buildMcpTools(serverId),
    lazyEligible: true,
  }
}
