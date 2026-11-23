import type { McpConnectionState } from '@/types/mcpIpc'

export function mcpStatusText(state: McpConnectionState, languages: StringKV): string {
  if (state === 'starting') return languages.SETTINGS_MCP_STARTING
  if (state === 'running') return languages.SETTINGS_MCP_CONNECTED
  if (state === 'error') return languages.SETTINGS_MCP_ERROR_STATE
  return languages.SETTINGS_MCP_DISCONNECTED
}
