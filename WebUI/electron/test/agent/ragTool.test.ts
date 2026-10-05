import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The `rag` capability's tool: containment, index caching, k clamping and the
// passage formatting. Splitting/embedding/retrieval are reached through the
// ragAccess bridge, so the tests install a fake and inspect what the tool asks
// it to do — the langchain worker and the embedding server are not under test.

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-rag-'))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => agentDir, getAppPath: () => agentDir },
  BrowserWindow: class {},
  net: {},
}))

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Pi is ESM-only and loaded lazily; `defineTool` is an identity function here.
vi.mock('../../agent/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))

vi.mock('../../agent/agentBrowser.ts', () => ({ runBrowserAction: vi.fn() }))
vi.mock('../../adapters/mcp/mcpManager.ts', () => ({
  getMcpServerTools: vi.fn(async () => ({})),
}))

const { resolveCapabilities } = await import('../../agent/capabilities/index.ts')
const { setRagAccess, resetRagAccess } = await import('../../agent/ragAccess.ts')
const { testables } = await import('../../agent/capabilities/rag.ts')
const { setToolBridgeWindow, submitAgentToolResult } = await import('../../agent/piCustomTools.ts')
const { Document } = await import('@langchain/classic/document')
import type { RagAccess } from '../../agent/ragAccess.ts'

const { DEFAULT_K, MAX_K, MAX_RESULT_CHARS, resolveWorkspaceFile, formatChunks } = testables

type Host = Parameters<typeof resolveCapabilities>[0]

function hostWith(overrides: Partial<Host> = {}): Host {
  const workspaceDir = path.join(agentDir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })
  return {
    sessionId: 'session-1',
    workspaceDir,
    toolSpecs: [],
    agentDir,
    keepModelsLoaded: false,
    embeddingModel: 'emb-model',
    embeddingBackend: 'llamaCPP',
    ...overrides,
  }
}

type RagTool = {
  name: string
  parameters?: { required?: string[] }
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[] }>
}

async function buildRagTool(host: Host): Promise<RagTool> {
  const resolution = await resolveCapabilities(host, ['rag'])
  expect(resolution.resolved.map(({ capability }) => capability.id)).toEqual(['rag'])
  const tools: RagTool[] = []
  for (const factory of resolution.extensionFactories) {
    factory({
      registerTool: (tool: RagTool) => tools.push(tool),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as never)
  }
  expect(tools.map((tool) => tool.name)).toEqual(['rag'])
  return tools[0]
}

function makeChunk(text: string, metadata: Record<string, unknown> = {}) {
  return new Document({ pageContent: text, metadata })
}

function fakeAccess(
  options: {
    chunks?: ReturnType<typeof makeChunk>[]
    emptySplit?: boolean
    failRetrieve?: Error
  } = {},
) {
  const calls = { ingest: 0, ensure: 0, retrieve: 0 }
  let lastInquiry: Record<string, unknown> | undefined
  const chunks = options.chunks ?? [makeChunk('The budget is $42.', { loc: { pageNumber: 7 } })]
  const access: RagAccess = {
    ingest: async (document) => {
      calls.ingest += 1
      return {
        ...document,
        hash: `hash-${calls.ingest}`,
        splitDB: options.emptySplit ? [] : [makeChunk('chunk')],
      }
    },
    retrieve: async (inquiry) => {
      calls.retrieve += 1
      lastInquiry = inquiry as unknown as Record<string, unknown>
      if (options.failRetrieve) throw options.failRetrieve
      return chunks
    },
    ensureEmbeddingServer: async () => {
      calls.ensure += 1
      return 'http://127.0.0.1:39999'
    },
  }
  setRagAccess(access)
  return { calls, inquiry: () => lastInquiry as Record<string, unknown> }
}

function workspaceFile(host: Host, name: string, content = 'some text'): string {
  const filePath = path.join(host.workspaceDir, name)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return filePath
}

async function resultOf(tool: RagTool, params: Record<string, unknown>): Promise<string> {
  const result = await tool.execute('call-1', params)
  return result.content[0].text
}

// The tool asks the renderer (before first use) whether the session's embedding
// model is on disk; the renderer owns the download prompt. Fake the bridge: the
// window captures the dispatch and answers through submitAgentToolResult.
function fakeRendererPrep(status: 'ready' | 'declined') {
  const dispatches: { toolName: string; input: Record<string, unknown> }[] = []
  const send = (
    _channel: string,
    payload: { requestId: string; toolName: string; input: unknown },
  ) => {
    dispatches.push({ toolName: payload.toolName, input: payload.input as Record<string, unknown> })
    if (payload.toolName === 'ragPrepareEmbeddingModel') {
      submitAgentToolResult(payload.requestId, { status })
    }
  }
  setToolBridgeWindow({ webContents: { send } } as never)
  return { dispatches }
}

beforeEach(() => {
  resetRagAccess()
  fakeRendererPrep('ready')
})

afterAll(() => {
  fs.rmSync(agentDir, { recursive: true, force: true })
  resetRagAccess()
})

describe('the rag tool', () => {
  it('asks for a file and a query', async () => {
    const tool = await buildRagTool(hostWith())
    expect(tool.parameters?.required).toEqual(['file', 'query'])
  })

  it('indexes, retrieves and returns passages with page metadata', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    const { calls, inquiry } = fakeAccess()
    const tool = await buildRagTool(host)

    const text = await resultOf(tool, { file: 'report.pdf', query: 'the budget' })

    expect(calls.ingest).toBe(1)
    expect(calls.ensure).toBe(1)
    expect(inquiry()).toMatchObject({
      prompt: 'the budget',
      backendBaseUrl: 'http://127.0.0.1:39999',
      embeddingModel: 'emb-model',
      maxResults: DEFAULT_K,
      useGroupRetrieval: false,
    })
    expect(text).toContain('report.pdf')
    expect(text).toContain('page 7')
    expect(text).toContain('The budget is $42.')
  })

  it('keeps the index and the server handshake for the session', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    await resultOf(tool, { file: 'report.pdf', query: 'first question' })
    await resultOf(tool, { file: 'report.pdf', query: 'second question' })

    expect(calls.ingest).toBe(1)
    expect(calls.ensure).toBe(1)
    expect(calls.retrieve).toBe(2)

    // A changed file re-indexes; the embedding server handshake is kept.
    const changed = workspaceFile(host, 'report.pdf', 'rewritten content')
    fs.utimesSync(changed, new Date(), new Date(Date.now() + 10_000))
    await resultOf(tool, { file: 'report.pdf', query: 'third question' })
    expect(calls.ingest).toBe(2)
    expect(calls.ensure).toBe(1)
  })

  it('clamps k into range', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    const { inquiry } = fakeAccess()
    const tool = await buildRagTool(host)

    await resultOf(tool, { file: 'report.pdf', query: 'q', k: 99 })
    expect(inquiry().maxResults).toBe(MAX_K)
    await resultOf(tool, { file: 'report.pdf', query: 'q', k: 0 })
    expect(inquiry().maxResults).toBe(1)
    await resultOf(tool, { file: 'report.pdf', query: 'q' })
    expect(inquiry().maxResults).toBe(DEFAULT_K)
  })

  it('refuses paths outside the workspace without touching the index', async () => {
    const host = hostWith()
    workspaceFile(host, 'inside.pdf')
    const outside = path.join(agentDir, 'outside.pdf')
    fs.writeFileSync(outside, 'secret')
    const link = path.join(host.workspaceDir, 'link.pdf')
    fs.symlinkSync(outside, link)
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    expect(await resultOf(tool, { file: outside, query: 'q' })).toMatch(
      /Not a file in the workspace/,
    )
    expect(await resultOf(tool, { file: '../outside.pdf', query: 'q' })).toMatch(
      /Not a file in the workspace/,
    )
    expect(await resultOf(tool, { file: 'link.pdf', query: 'q' })).toMatch(
      /Not a file in the workspace/,
    )
    expect(await resultOf(tool, { file: 'missing.pdf', query: 'q' })).toMatch(
      /Not a file in the workspace/,
    )
    expect(calls.ingest).toBe(0)
    expect(calls.retrieve).toBe(0)
  })

  it('refuses file types the indexer cannot read and points at read', async () => {
    const host = hostWith()
    workspaceFile(host, 'index.html')
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    expect(await resultOf(tool, { file: 'index.html', query: 'q' })).toMatch(/'read' instead/)
    expect(calls.ingest).toBe(0)
  })

  it('says when a document has no indexable text', async () => {
    const host = hostWith()
    workspaceFile(host, 'scanned.pdf')
    fakeAccess({ emptySplit: true })
    const tool = await buildRagTool(host)

    expect(await resultOf(tool, { file: 'scanned.pdf', query: 'q' })).toMatch(
      /no indexable text content/,
    )
  })

  it('says when nothing matched', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    fakeAccess({ chunks: [] })
    const tool = await buildRagTool(host)

    expect(await resultOf(tool, { file: 'report.pdf', query: 'q' })).toMatch(/No passage/)
  })

  it('returns failures as tool text instead of throwing', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    fakeAccess({ failRetrieve: new Error('embedding server exploded') })
    const tool = await buildRagTool(host)

    expect(await resultOf(tool, { file: 'report.pdf', query: 'q' })).toMatch(
      /Document search failed: embedding server exploded/,
    )
  })

  it('prompts for the embedding model through the renderer before first use', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    const { dispatches } = fakeRendererPrep('ready')
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    await resultOf(tool, { file: 'report.pdf', query: 'q' })
    await resultOf(tool, { file: 'report.pdf', query: 'other question' })

    // One prompt per session, with the session-frozen model and backend.
    expect(dispatches).toEqual([
      { toolName: 'ragPrepareEmbeddingModel', input: { model: 'emb-model', backend: 'llamaCPP' } },
    ])
    expect(calls.ingest).toBe(1)
  })

  it('falls back to read when the user declines the download', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    fakeRendererPrep('declined')
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    expect(await resultOf(tool, { file: 'report.pdf', query: 'q' })).toMatch(
      /declined the embedding model download/,
    )
    expect(await resultOf(tool, { file: 'report.pdf', query: 'q' })).toMatch(/'read' instead/)
    expect(calls.ingest).toBe(0)
    expect(calls.ensure).toBe(0)
    expect(calls.retrieve).toBe(0)
  })

  it('says how to fix it when the embedding server cannot be brought up', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    fakeRendererPrep('ready')
    const access: RagAccess = {
      ingest: async (document) => ({ ...document, hash: 'h', splitDB: [makeChunk('c')] }),
      retrieve: async () => [],
      ensureEmbeddingServer: async () => {
        throw new Error('model file missing')
      },
    }
    setRagAccess(access)
    const tool = await buildRagTool(host)

    expect(await resultOf(tool, { file: 'report.pdf', query: 'q' })).toMatch(
      /not usable on this machine \(model file missing\)/,
    )
    expect(await resultOf(tool, { file: 'report.pdf', query: 'q' })).toMatch(/'read' instead/)
  })

  it('is not offered to a session without an embedding model', async () => {
    const host = hostWith({ embeddingModel: undefined })
    workspaceFile(host, 'report.pdf')
    fakeAccess()
    const resolution = await resolveCapabilities(host, ['rag'])
    expect(resolution.resolved).toEqual([])
    expect(resolution.extensionFactories).toEqual([])
  })
})

describe('formatChunks', () => {
  it('labels each passage with whatever location metadata exists', () => {
    const text = formatChunks(
      [
        makeChunk('first', { loc: { pageNumber: 3 } }),
        makeChunk('second', { loc: { lines: { from: 10, to: 20 } } }),
        makeChunk('third', {}),
      ],
      'doc.pdf',
      5,
    )
    expect(text).toContain('3 passage(s) from doc.pdf (k=5)')
    expect(text).toContain('passage 1 (page 3)')
    expect(text).toContain('passage 2 (lines 10-20)')
    expect(text).toContain('passage 3')
    expect(text).not.toContain('left out')
  })

  it('stops before the result eats the context', () => {
    const chunks = Array.from({ length: 20 }, (_, i) =>
      makeChunk(`${i} `.repeat(2000), { loc: { pageNumber: i + 1 } }),
    )
    const text = formatChunks(chunks, 'big.pdf', 20)
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 400)
    expect(text).toContain('left out')
  })
})

describe('resolveWorkspaceFile', () => {
  it('rejects empty, absolute and escaping paths', () => {
    const workspaceDir = hostWith().workspaceDir
    expect(resolveWorkspaceFile(workspaceDir, '')).toBeNull()
    expect(resolveWorkspaceFile(workspaceDir, '/etc/passwd')).toBeNull()
    expect(resolveWorkspaceFile(workspaceDir, '../escape.pdf')).toBeNull()
    expect(resolveWorkspaceFile(workspaceDir, '.')).toBeNull()
  })
})
