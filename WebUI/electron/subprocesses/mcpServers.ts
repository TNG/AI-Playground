export type McpServerConfig = {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

// Hardcoded servers for now. Keep server-specific wiring here.
export const mcpServers: Record<string, McpServerConfig> = {
  blender: {
    id: 'blender',
    name: 'Blender MCP',
    command: 'cmd',
    args: ['/c', 'uvx', 'blender-mcp'],
    env: {
      DISABLE_TELEMETRY: 'true',
    },
  },
}
