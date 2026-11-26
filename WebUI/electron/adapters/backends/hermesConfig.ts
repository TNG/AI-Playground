import { HERMES_MIN_CONTEXT } from '@/lib/agentHarness'

export { HERMES_MIN_CONTEXT }

/** The model id Hermes sends; the LLM proxy replaces it with the model AIPG has loaded. */
export const HERMES_PROXY_MODEL = 'aipg-local'

/** Name of the AIPG MCP server inside Hermes' config, and so the prefix of its tools there. */
export const HERMES_AIPG_MCP_SERVER = 'aipg'

export type HermesEndpoint = { url: string; key: string }

export type HermesConfigInput = {
  llm: HermesEndpoint
  mcp?: HermesEndpoint
  contextLength: number
  workspaceDir?: string
  /** Absent means on, which is what Pi gives a preset that does not own its prompt. */
  fileTools?: boolean
}

/** `hermes-acp` minus everything that reads or writes the disk or runs code. */
const HERMES_TOOLSETS_WITHOUT_FILES = [
  'web',
  'vision',
  'skills',
  'todo',
  'memory',
  'session_search',
]

/**
 * Hermes' `config.yaml`, which it re-reads for every run, so the workspace and window
 * follow the turn without a gateway restart. JSON is valid YAML, so no YAML writer is needed.
 */
export function buildHermesConfig(input: HermesConfigInput): Record<string, unknown> {
  const config: Record<string, unknown> = {
    model: {
      default: HERMES_PROXY_MODEL,
      provider: 'custom',
      base_url: `${input.llm.url}/v1`,
      api_key: input.llm.key,
      context_length: Math.max(input.contextLength, HERMES_MIN_CONTEXT),
    },
    platform_toolsets: {
      api_server: [
        ...(input.fileTools === false ? HERMES_TOOLSETS_WITHOUT_FILES : ['hermes-acp']),
        input.mcp ? HERMES_AIPG_MCP_SERVER : 'no_mcp',
      ],
    },
  }
  if (input.workspaceDir) config.terminal = { cwd: input.workspaceDir }
  if (input.mcp) {
    config.mcp_servers = {
      [HERMES_AIPG_MCP_SERVER]: {
        url: input.mcp.url,
        headers: { Authorization: `Bearer ${input.mcp.key}` },
      },
    }
  }
  return config
}

/** Hermes' `.env`: the API server is the only platform AIPG turns on. */
export function buildHermesEnv(apiPort: number, apiKey: string): string {
  return [
    'API_SERVER_ENABLED=true',
    `API_SERVER_KEY=${apiKey}`,
    `API_SERVER_PORT=${apiPort}`,
    'API_SERVER_HOST=127.0.0.1',
    '',
  ].join('\n')
}
