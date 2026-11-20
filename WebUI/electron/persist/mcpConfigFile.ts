import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { appLoggerInstance } from '../observability/logger'
import { externalResourcesDir } from '../kernel/aipgRoot.ts'
import { writableConfigFile } from '../kernel/userConfig.ts'
import { getMcpConfigFile } from './userDataPaths.ts'
import type { McpServerConfig } from '@/types/mcpIpc'

/**
 * The kernel-owned MCP server config (architecture-target §6.1, step 8):
 * `AI-Playground/mcp.json` — the user's configured MCP servers. The file lives
 * in the user-data root so it survives app updates and reinstalls (the
 * resources root is re-seeded from the bundle on update and the NSIS
 * uninstaller deletes it). On first use the previous resources-root copy
 * migrates in; a fresh install seeds from the shipped default.
 *
 * Sync like `localSettingsFile.ts` — the MCP registry's surface is sync.
 * A missing file is an empty server list (the UI's "add a server" state); a
 * corrupt file throws, so a hand-edit mistake surfaces instead of being
 * silently replaced by the next write.
 */

const LOG_SCOPE = 'mcp'

type McpConfigFile = { mcpServers: Record<string, McpServerConfig> }

/** Parses a config file; null when absent, throws when present but invalid. */
function parseConfigFile(file: string): Record<string, McpServerConfig> | null {
  let content: string
  try {
    content = fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
  let config: McpConfigFile
  try {
    config = JSON.parse(content) as McpConfigFile
  } catch (error) {
    throw new Error(
      `Failed to parse MCP config file: ${file}. ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (
    !config ||
    typeof config !== 'object' ||
    !config.mcpServers ||
    typeof config.mcpServers !== 'object'
  ) {
    throw new Error(`Invalid MCP config file: ${file}. Missing or invalid 'mcpServers' field.`)
  }
  return config.mcpServers
}

/** Torn-write-safe JSON write: a crash mid-write leaves the old file intact. */
function writeConfigFile(file: string, config: McpConfigFile): void {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // cleanup is best effort
    }
    throw e
  }
}

/**
 * Where the config lived before the move to the user-data root, most
 * user-owned first: the dev seed, the per-user resources-root copy, then the
 * read-only bundle's shipped default.
 */
function legacyPaths(): string[] {
  if (!app.isPackaged) return [path.join(externalResourcesDir(), 'mcp-dev.json')]
  return [writableConfigFile('mcp.json'), path.join(process.resourcesPath, 'mcp.json')]
}

/**
 * Brings the user-data config into existence: migrate the previous copy when
 * one exists, else seed from the shipped default, else start empty (so "Edit
 * mcp.json" always opens a real file). Never overwrites an existing target.
 * Best-effort — a location that cannot be written logs and leaves the target
 * absent, which reads as an empty server list.
 */
function ensureMcpConfigFile(): string {
  const target = getMcpConfigFile()
  if (fs.existsSync(target)) return target

  const sources = [...new Set(legacyPaths())]
  for (const source of sources) {
    if (source === target) continue
    let servers: Record<string, McpServerConfig> | null = null
    try {
      servers = parseConfigFile(source)
    } catch (error) {
      appLoggerInstance.warn(
        `MCP config source ${source} is invalid and was not migrated: ${String(error)}`,
        LOG_SCOPE,
      )
    }
    if (!servers) continue
    try {
      writeConfigFile(target, { mcpServers: servers })
      appLoggerInstance.info(`MCP config migrated from ${source} into ${target}`, LOG_SCOPE)
      return target
    } catch (error) {
      appLoggerInstance.warn(
        `MCP config could not be copied from ${source}: ${String(error)}`,
        LOG_SCOPE,
      )
    }
  }

  try {
    writeConfigFile(target, { mcpServers: {} })
  } catch (error) {
    appLoggerInstance.warn(
      `MCP config could not be created at ${target}: ${String(error)}`,
      LOG_SCOPE,
    )
  }
  return target
}

// ── Public API ────────────────────────────────────────────────────────────────

/** The user-data config path, creating the file (seeded) when absent. */
export function getMcpConfigPath(): string {
  return ensureMcpConfigFile()
}

/** The configured servers; empty when the config is (still) absent. */
export function loadMcpServers(): Record<string, McpServerConfig> {
  const configPath = ensureMcpConfigFile()
  const servers = parseConfigFile(configPath)
  if (servers === null) return {}
  appLoggerInstance.info(`Loaded MCP servers from ${configPath}`, LOG_SCOPE)
  return servers
}

export function saveMcpServers(servers: Record<string, McpServerConfig>): void {
  writeConfigFile(getMcpConfigPath(), { mcpServers: servers })
}
