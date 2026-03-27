import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { appLoggerInstance } from '../logging/logger'

export type McpServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string>
  displayName?: string
}

type McpConfigFile = {
  mcpServers: Record<string, McpServerConfig>
}

function getExternalResourcesDir(): string {
  return path.resolve(
    app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../external/'),
  )
}

export function getMcpConfigPath(): string {
  const externalRes = getExternalResourcesDir()
  return path.join(externalRes, app.isPackaged ? 'mcp.json' : 'mcp-dev.json')
}

export function loadMcpServers(): Record<string, McpServerConfig> {
  const configPath = getMcpConfigPath()

  if (!fs.existsSync(configPath)) {
    throw new Error(`MCP config file not found: ${configPath}`)
  }

  const content = fs.readFileSync(configPath, 'utf-8')

  let config: McpConfigFile
  try {
    config = JSON.parse(content) as McpConfigFile
  } catch (error) {
    throw new Error(
      `Failed to parse MCP config file: ${configPath}. ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    throw new Error(
      `Invalid MCP config file: ${configPath}. Missing or invalid 'mcpServers' field.`,
    )
  }

  appLoggerInstance.info(`Loaded MCP servers from ${configPath}`, 'mcp')
  return config.mcpServers
}

export function addMcpServer(serverId: string, config: McpServerConfig): void {
  const configPath = getMcpConfigPath()
  const servers = loadMcpServers()

  if (servers[serverId]) {
    throw new Error(`MCP server with ID "${serverId}" already exists`)
  }

  servers[serverId] = config

  const newConfig: McpConfigFile = { mcpServers: servers }
  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf-8')

  appLoggerInstance.info(`Added MCP server: ${serverId}`, 'mcp')
}
