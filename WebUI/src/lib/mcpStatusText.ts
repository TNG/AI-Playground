import type { McpConnectionState } from '@/types/mcpIpc'

/** A ticked server that is not running yet is started by the next turn, not broken. */
export function mcpStatusText(
  state: McpConnectionState,
  languages: StringKV,
  selected = false,
): string {
  if (state === 'starting') return languages.SETTINGS_MCP_STARTING
  if (state === 'running') return languages.SETTINGS_MCP_CONNECTED
  if (state === 'error') return languages.SETTINGS_MCP_ERROR_STATE
  return selected ? languages.SETTINGS_MCP_STARTS_NEXT_TURN : languages.SETTINGS_MCP_DISCONNECTED
}

export function mcpStatusDotClass(state: McpConnectionState): string {
  if (state === 'starting') return 'bg-warning animate-pulse'
  if (state === 'running') return 'bg-success'
  if (state === 'error') return 'bg-destructive'
  return 'bg-muted-foreground/40'
}
