import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The kernel-owned MCP config file (architecture-target §6.1, step 8): the
// user-data path, seeded from the shipped default on a fresh install, one-shot
// migration of the previous resources-root copy, empty-when-missing loads and
// corrupt-file errors, driven against real files in a temp dir.

const paths = vi.hoisted(() => ({
  target: '',
  dev: '',
  legacyUser: '',
  bundle: '',
}))

const mockApp = vi.hoisted(() => ({ isPackaged: false }))

vi.mock('electron', () => ({
  app: mockApp,
}))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getMcpConfigFile: () => paths.target,
}))

vi.mock('../../kernel/aipgRoot.ts', () => ({
  externalResourcesDir: () => path.dirname(paths.dev),
}))

vi.mock('../../kernel/userConfig.ts', () => ({
  writableConfigFile: (fileName: string) => path.join(path.dirname(paths.legacyUser), fileName),
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { getMcpConfigPath, loadMcpServers, saveMcpServers } =
  await import('../../persist/mcpConfigFile')

let tmpRoot = ''
let resourcesPath = ''

function writeServers(file: string, servers: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2))
}

function readRaw(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  if (!tmpRoot) {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-mcp-config-'))
  }
  mockApp.isPackaged = false
  resourcesPath = process.resourcesPath
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process as any).resourcesPath = path.join(tmpRoot, 'bundle', 'resources')
  paths.target = path.join(tmpRoot, 'AI-Playground', 'mcp.json')
  paths.dev = path.join(tmpRoot, 'dev', 'external', 'mcp-dev.json')
  paths.legacyUser = path.join(tmpRoot, 'user-root', 'resources', 'mcp.json')
  paths.bundle = path.join(tmpRoot, 'bundle', 'resources', 'mcp.json')
  for (const file of [paths.target, paths.dev, paths.legacyUser, paths.bundle]) {
    fs.rmSync(file, { force: true })
  }
})

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process as any).resourcesPath = resourcesPath
})

describe('the kernel MCP config file', () => {
  it('loads an absent config as an empty server list and creates the file', () => {
    expect(loadMcpServers()).toEqual({})
    expect(readRaw(paths.target)).toEqual({ mcpServers: {} })
  })

  it('seeds from the dev file when the target is absent (dev mode)', () => {
    writeServers(paths.dev, { datetime: { command: 'uvx', args: ['mcp-server-time'] } })
    expect(loadMcpServers()).toEqual({ datetime: { command: 'uvx', args: ['mcp-server-time'] } })
    expect(readRaw(paths.target)).toEqual(readRaw(paths.dev))
  })

  it('migrates the previous resources-root copy ahead of the shipped default (packaged)', () => {
    mockApp.isPackaged = true
    writeServers(paths.legacyUser, { mine: { command: 'my-server' } })
    writeServers(paths.bundle, { shipped: { command: 'shipped-server' } })
    expect(loadMcpServers()).toEqual({ mine: { command: 'my-server' } })
    // The shipped default stays available for the next fresh install.
    expect(readRaw(paths.bundle)).not.toBeNull()
  })

  it('never overwrites an existing target', () => {
    writeServers(paths.target, { mine: { command: 'my-server' } })
    writeServers(paths.dev, { other: { command: 'other-server' } })
    expect(loadMcpServers()).toEqual({ mine: { command: 'my-server' } })
  })

  it('skips an invalid migration source and falls through to the next one', () => {
    mockApp.isPackaged = true
    fs.mkdirSync(path.dirname(paths.legacyUser), { recursive: true })
    fs.writeFileSync(paths.legacyUser, '{ not json')
    writeServers(paths.bundle, { shipped: { command: 'shipped-server' } })
    expect(loadMcpServers()).toEqual({ shipped: { command: 'shipped-server' } })
  })

  it('throws on a corrupt target instead of silently replacing it', () => {
    fs.mkdirSync(path.dirname(paths.target), { recursive: true })
    fs.writeFileSync(paths.target, '{ not json')
    expect(() => loadMcpServers()).toThrow(/Failed to parse|not json/i)
  })

  it('throws on a target missing the mcpServers field', () => {
    fs.mkdirSync(path.dirname(paths.target), { recursive: true })
    fs.writeFileSync(paths.target, JSON.stringify({ somethingElse: {} }))
    expect(() => loadMcpServers()).toThrow(/mcpServers/)
  })

  it('round-trips saves through the user-data file', () => {
    saveMcpServers({ one: { command: 'a' }, two: { type: 'http', url: 'https://x' } })
    expect(loadMcpServers()).toEqual({
      one: { command: 'a' },
      two: { type: 'http', url: 'https://x' },
    })
  })

  it('getMcpConfigPath creates a real file the editor can open', () => {
    expect(getMcpConfigPath()).toBe(paths.target)
    expect(readRaw(paths.target)).toEqual({ mcpServers: {} })
  })
})
