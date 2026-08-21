export const DEFAULT_CAPABILITY_IDS = ['media', 'web-debug'] as const

export const MCP_CAPABILITY_PREFIX = 'mcp:'

export const GAME_STUDIO_ID = 'game-studio'
export const GAME_STUDIO_QUICK_ID = 'game-studio-quick'

export function mcpCapabilityId(serverId: string): string {
  return `${MCP_CAPABILITY_PREFIX}${serverId}`
}

export function mcpServerIdOf(capabilityId: string): string | undefined {
  return capabilityId.startsWith(MCP_CAPABILITY_PREFIX)
    ? capabilityId.slice(MCP_CAPABILITY_PREFIX.length)
    : undefined
}
