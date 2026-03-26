import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { appLoggerInstance } from '../logging/logger'

export type McpServerConfig = {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

type McpConfigFile = {
  servers: Record<string, McpServerConfig>
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

  if (!config.servers || typeof config.servers !== 'object') {
    throw new Error(`Invalid MCP config file: ${configPath}. Missing or invalid 'servers' field.`)
  }

  appLoggerInstance.info(`Loaded MCP servers from ${configPath}`, 'mcp')
  return config.servers
}
