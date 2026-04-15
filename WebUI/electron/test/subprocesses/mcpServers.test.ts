import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'

let testDir: string
let configPath: string

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/mock',
  },
}))

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../subprocesses/mcpServers', async () => {
  const fs = await import('node:fs')

  type McpServerConfig =
    | {
        type?: 'stdio'
        command: string
        args?: string[]
        env?: Record<string, string>
        displayName?: string
      }
    | {
        type: 'http'
        url: string
        headers?: Record<string, string>
        displayName?: string
      }

  type McpConfigFile = {
    mcpServers: Record<string, McpServerConfig>
  }

  function getMcpConfigPath(): string {
    return configPath
  }

  function loadMcpServers(): Record<string, McpServerConfig> {
    const cp = getMcpConfigPath()
    if (!fs.existsSync(cp)) {
      throw new Error(`MCP config file not found: ${cp}`)
    }
    const content = fs.readFileSync(cp, 'utf-8')
    let config: McpConfigFile
    try {
      config = JSON.parse(content) as McpConfigFile
    } catch (error) {
      throw new Error(
        `Failed to parse MCP config file: ${cp}. ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      throw new Error(`Invalid MCP config file: ${cp}. Missing or invalid 'mcpServers' field.`)
    }
    return config.mcpServers
  }

  return {
    getMcpConfigPath,
    loadMcpServers,
    addMcpServer: (serverId: string, config: McpServerConfig) => {
      const cp = getMcpConfigPath()
      const servers = fs.existsSync(cp) ? loadMcpServers() : {}
      if (servers[serverId]) {
        throw new Error(`MCP server with ID "${serverId}" already exists`)
      }
      servers[serverId] = config
      fs.writeFileSync(cp, JSON.stringify({ mcpServers: servers }, null, 2), 'utf-8')
    },
    getMcpServerConfig: (serverId: string) => {
      const servers = loadMcpServers()
      if (!servers[serverId]) {
        throw new Error(`MCP server with ID "${serverId}" not found`)
      }
      return servers[serverId]
    },
    updateMcpServer: (serverId: string, config: McpServerConfig) => {
      const cp = getMcpConfigPath()
      const servers = loadMcpServers()
      if (!servers[serverId]) {
        throw new Error(`MCP server with ID "${serverId}" not found`)
      }
      servers[serverId] = config
      fs.writeFileSync(cp, JSON.stringify({ mcpServers: servers }, null, 2), 'utf-8')
    },
    removeMcpServer: (serverId: string) => {
      const cp = getMcpConfigPath()
      const servers = loadMcpServers()
      if (!servers[serverId]) {
        throw new Error(`MCP server with ID "${serverId}" not found`)
      }
      delete servers[serverId]
      fs.writeFileSync(cp, JSON.stringify({ mcpServers: servers }, null, 2), 'utf-8')
    },
  }
})

import {
  loadMcpServers,
  addMcpServer,
  getMcpServerConfig,
  updateMcpServer,
  removeMcpServer,
  getMcpConfigPath,
} from '../../subprocesses/mcpServers'

describe('mcpServers', () => {
  beforeEach(() => {
    testDir = path.join(tmpdir(), `mcp-test-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
    configPath = path.join(testDir, 'mcp-dev.json')
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  describe('loadMcpServers', () => {
    it('should load servers from a valid config file', () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            'test-server': { command: 'node', args: ['server.js'] },
          },
        }),
      )

      const servers = loadMcpServers()

      expect(servers).toHaveProperty('test-server')
      expect(servers['test-server']).toEqual({ command: 'node', args: ['server.js'] })
    })

    it('should throw when config file does not exist', () => {
      expect(() => loadMcpServers()).toThrow(/not found/)
    })

    it('should throw on malformed JSON', () => {
      writeFileSync(configPath, '{invalid json')

      expect(() => loadMcpServers()).toThrow(/Failed to parse/)
    })

    it('should throw when mcpServers field is missing', () => {
      writeFileSync(configPath, JSON.stringify({ otherField: true }))

      expect(() => loadMcpServers()).toThrow(/Missing or invalid/)
    })

    it('should load HTTP-type server configs', () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            'http-server': { type: 'http', url: 'http://localhost:3000' },
          },
        }),
      )

      const servers = loadMcpServers()

      expect(servers['http-server']).toEqual({ type: 'http', url: 'http://localhost:3000' })
    })
  })

  describe('addMcpServer', () => {
    it('should add a new server to the config', () => {
      writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))

      addMcpServer('new-server', { command: 'python', args: ['-m', 'my_mcp'] })

      const saved = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(saved.mcpServers['new-server']).toEqual({
        command: 'python',
        args: ['-m', 'my_mcp'],
      })
    })

    it('should throw when server ID already exists', () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: { existing: { command: 'node' } },
        }),
      )

      expect(() => addMcpServer('existing', { command: 'python' })).toThrow(/already exists/)
    })

    it('should create config file if it does not exist', () => {
      addMcpServer('brand-new', { command: 'node', args: ['srv.js'] })

      const saved = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(saved.mcpServers['brand-new']).toEqual({ command: 'node', args: ['srv.js'] })
    })

    it('should preserve existing servers when adding a new one', () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: { first: { command: 'node', args: ['a.js'] } },
        }),
      )

      addMcpServer('second', { command: 'python', args: ['b.py'] })

      const saved = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(Object.keys(saved.mcpServers)).toEqual(['first', 'second'])
    })
  })

  describe('getMcpServerConfig', () => {
    it('should return config for an existing server', () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: { myserver: { command: 'uvx', args: ['tool'] } },
        }),
      )

      const config = getMcpServerConfig('myserver')

      expect(config).toEqual({ command: 'uvx', args: ['tool'] })
    })

    it('should throw when server ID is not found', () => {
      writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))

      expect(() => getMcpServerConfig('nonexistent')).toThrow(/not found/)
    })
  })

  describe('updateMcpServer', () => {
    it('should update an existing server config', () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: { srv: { command: 'node', args: ['old.js'] } },
        }),
      )

      updateMcpServer('srv', { command: 'node', args: ['new.js'] })

      const saved = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(saved.mcpServers.srv.args).toEqual(['new.js'])
    })

    it('should throw when server does not exist', () => {
      writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))

      expect(() => updateMcpServer('missing', { command: 'node' })).toThrow(/not found/)
    })

    it('should not affect other servers when updating one', () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            a: { command: 'node', args: ['a.js'] },
            b: { command: 'python', args: ['b.py'] },
          },
        }),
      )

      updateMcpServer('a', { command: 'node', args: ['updated.js'] })

      const saved = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(saved.mcpServers.a.args).toEqual(['updated.js'])
      expect(saved.mcpServers.b).toEqual({ command: 'python', args: ['b.py'] })
    })
  })

  describe('removeMcpServer', () => {
    it('should remove an existing server from config', () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            keep: { command: 'a' },
            remove: { command: 'b' },
          },
        }),
      )

      removeMcpServer('remove')

      const saved = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(saved.mcpServers).toEqual({ keep: { command: 'a' } })
    })

    it('should throw when server does not exist', () => {
      writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))

      expect(() => removeMcpServer('ghost')).toThrow(/not found/)
    })
  })

  describe('getMcpConfigPath', () => {
    it('should return the mocked config path', () => {
      const result = getMcpConfigPath()
      expect(result).toBe(configPath)
    })
  })
})
