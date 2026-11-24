import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import { importAttachment } from '../../agent/workspaceAttachments.ts'

// The Agent preset inside a Session, seen from outside main: a real Pi session
// runs each turn against a fake OpenAI-compatible backend served through
// `fetch`, so the assertions are on the request bodies Pi sent and on the
// Session Folder's own files.

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-agent-session-')))

vi.mock('../../adapters/trash', async () => {
  const fs = await import('node:fs/promises')
  return { moveToTrash: (target: string) => fs.rm(target, { recursive: true, force: true }) }
})

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot, isPackaged: false, getAppPath: () => tempRoot },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
}))

vi.mock('../../persist/userDataPaths.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../persist/userDataPaths.ts')>()),
  getSessionsDir: () => path.join(tempRoot, 'sessions'),
  getLegacySessionsDir: () => path.join(tempRoot, 'sessions'),
  getAppWorkspacesDir: () => `${path.join(tempRoot, 'sessions')}-workspaces`,
  getSessionsDemoDir: () => path.join(tempRoot, 'sessions-demo'),
  getLegacySessionsDemoDir: () => path.join(tempRoot, 'sessions-demo'),
  getAppWorkspacesDemoDir: () => `${path.join(tempRoot, 'sessions-demo')}-workspaces`,
  getRagDocumentsFile: () => path.join(tempRoot, 'rag', 'documents.json'),
  getAgentSessionsDir: () => path.join(tempRoot, 'agent-sessions'),
  getAgentTasksFile: () => path.join(tempRoot, 'agent-tasks.json'),
  getAgentDraftsFile: () => path.join(tempRoot, 'agent-drafts.json'),
  getAgentTrialsDir: () => path.join(tempRoot, 'agent-trials'),
}))

vi.mock('../../adapters/mcp/mcpManager.ts', () => ({
  getMcpServerTools: async (serverId: string) => {
    const { jsonSchema } = await import('ai')
    return {
      [`${serverId}_lookup`]: {
        description: `look something up on ${serverId}`,
        inputSchema: jsonSchema({ type: 'object', properties: { q: { type: 'string' } } }),
        execute: async () => 'ok',
      },
    }
  },
}))

type AskRenderer = typeof import('../../chat/chatAsk.ts').askRenderer
const askedRenderer: Parameters<AskRenderer>[0][] = []
vi.mock('../../chat/chatAsk.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../chat/chatAsk.ts')>()
  return {
    ...actual,
    askRenderer: async (...args: Parameters<AskRenderer>) => {
      const [question] = args
      if (question.kind !== 'speech-transcribe') return actual.askRenderer(...args)
      askedRenderer.push(question)
      return { text: 'buy oat milk' }
    },
  }
})

const BACKEND = 'http://fake-llm.test/v1'

type Body = { messages?: Array<{ role: string; content?: unknown }> }

/** Request bodies the fake backend received, in order. */
let bodies: Body[] = []
/** A tool call the backend makes once, before it answers. */
let toolCall: { name: string; args: Record<string, unknown> } | null = null
/** What the backend closes its stream with: llama.cpp's own timings, or only usage. */
let finalChunkExtra: Record<string, unknown> = {}
/** Kernel events main sent the window. */
let kernelEvents: { type?: string; turnId?: string; chunk?: Record<string, unknown> }[] = []
/** What the renderer window is sent; a test answers the tool requests it cares about. */
let rendererSend: (channel: string, payload: unknown) => void = () => {}

function frame(chunk: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
}

function completion(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

function reply(body: Body): Response {
  const call = toolCall && !body.messages?.some((message) => message.role === 'tool')
  const chunks = call
    ? [
        completion({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: toolCall!.name, arguments: JSON.stringify(toolCall!.args) },
            },
          ],
        }),
        completion({}, 'tool_calls'),
      ]
    : [
        completion({ role: 'assistant', content: `reply ${bodies.length}` }),
        { ...completion({}, 'stop'), ...finalChunkExtra },
      ]
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(frame(chunk))
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init)
    if (!request.url.startsWith(BACKEND)) return realFetch(input, init)
    const text = await request.text()
    const body = text ? (JSON.parse(text) as Body) : {}
    bodies.push(body)
    return reply(body)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

let manager: typeof import('../../agent/piAgentManager')
let sessions: typeof import('../../session/sessions')
let workspaces: typeof import('../../session/sessionWorkspace')

/** The Session's internal attachments folder, outside its Workspace. */
function attachmentsOf(config: AgentModeTurnConfig): { dir: string; reference: string } {
  return {
    dir: sessions.sessionPaths(config.sessionRef!).attachmentsDir,
    reference: '/attachments',
  }
}
let harness: typeof import('../../session/sessionHarness')
let history: typeof import('../../session/sessionHistory')
let store: typeof import('../../agent/piSessionStore')
let timeline: typeof import('../../session/sessionTimeline')

beforeAll(async () => {
  manager = await import('../../agent/piAgentManager')
  sessions = await import('../../session/sessions')
  workspaces = await import('../../session/sessionWorkspace')
  harness = await import('../../session/sessionHarness')
  history = await import('../../session/sessionHistory')
  store = await import('../../agent/piSessionStore')
  timeline = await import('../../session/sessionTimeline')
  sessions.setSessionDeps({ isDemoMode: () => false })
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        if (channel === 'kernel:event') kernelEvents.push(...([payload].flat() as never[]))
        rendererSend(channel, payload)
      },
    },
  }
  const bus = await import('../../kernel/kernelBus')
  bus.setKernelEventWindow(fakeWindow as never)
  manager.setAgentModeMainWindow(fakeWindow as never)
})

afterAll(async () => {
  await manager.shutdownAgentMode()
})

beforeEach(() => {
  bodies = []
  toolCall = null
  finalChunkExtra = {}
  kernelEvents = []
  rendererSend = () => {}
})

async function agentConfig(sessionId: string): Promise<AgentModeTurnConfig> {
  const { harnessSessionId, workspaceDir } = await harness.harnessSessionFor(sessionId, 'Agent')
  return {
    sessionId: harnessSessionId,
    sessionRef: sessionId,
    presetName: 'Agent',
    workspaceDir,
    modelConfig: { source: 'local', model: 'test-model', baseUrl: BACKEND, contextWindow: 8192 },
    toolSpecs: [],
    capabilities: [],
  }
}

async function workspaceFolderId(sessionId: string): Promise<string> {
  const { sessionWorkspaceEntry } = await import('../../session/sessionFolders')
  return (await sessionWorkspaceEntry(sessionId)).id
}

// The conversation, without the system prompt, which names the Workspace after the Session title.
function transcriptText(body: Body | undefined): string {
  return JSON.stringify((body?.messages ?? []).filter((message) => message.role !== 'system'))
}

describe('the Agent preset in a Session', () => {
  it('continues one Harness Session across a panel turn in between', async () => {
    const session = await sessions.createSession()

    const first = await agentConfig(session.id)
    expect(await manager.startAgentTurn('t1', 'remember the word plum', first)).toEqual({
      success: true,
    })
    await history.appendHistoryEntry(session.id, {
      preset: 'Draft Image',
      kind: 'image',
      prompt: 'a castle',
      status: 'completed',
      artifacts: [
        { folderId: await workspaceFolderId(session.id), path: 'castle.png', mediaType: 'image' },
      ],
    })
    const second = await agentConfig(session.id)
    expect(second.sessionId).toBe(first.sessionId)
    expect(await manager.startAgentTurn('t2', 'which word?', second)).toEqual({ success: true })

    const lastRequest = transcriptText(bodies.at(-1))
    expect(lastRequest).toContain('remember the word plum')
    expect(lastRequest).toContain('reply 1')
    expect(lastRequest).toContain('which word?')
  }, 30000)

  it('appends one History Entry per settled agent turn, with its full response', async () => {
    const session = await sessions.createSession()

    await manager.startAgentTurn('t1', 'build a page', await agentConfig(session.id))

    expect(await history.readHistoryEntries(session.id)).toEqual([
      expect.objectContaining({
        preset: 'Agent',
        kind: 'agent',
        prompt: 'build a page',
        status: 'completed',
        response: 'reply 1',
        artifacts: [],
      }),
    ])
  }, 30000)

  it('names an untitled Session after its first prompt and lists the preset as used', async () => {
    const session = await sessions.createSession()

    await manager.startAgentTurn('t1', 'build a landing page', await agentConfig(session.id))

    expect(await sessions.openSession(session.id)).toMatchObject({
      title: 'build a landing page',
      presetsUsed: ['Agent'],
    })
  }, 30000)

  it('works in the Session files folder, and its file tools cannot read the history', async () => {
    const session = await sessions.createSession()
    await history.appendHistoryEntry(session.id, {
      preset: 'Draft Image',
      kind: 'image',
      prompt: 'SECRET-PLUM',
      status: 'completed',
      artifacts: [],
    })
    const config = await agentConfig(session.id)
    expect(config.workspaceDir).toBe(workspaces.sessionWorkspaceDir(session.id))
    toolCall = { name: 'read', args: { path: '../session-history.jsonl' } }

    await manager.startAgentTurn('t1', 'read the history file', config)

    const toolMessages = (bodies.at(-1)?.messages ?? []).filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(JSON.stringify(toolMessages)).not.toContain('SECRET-PLUM')
  }, 30000)

  it("deletes the Harness Session's Pi file with the Session", async () => {
    const stop = harness.cleanUpHarnessSessionsOnDelete((id) => manager.deleteAgentSession(id))
    const session = await sessions.createSession()
    const config = await agentConfig(session.id)
    await manager.startAgentTurn('t1', 'hello', config)
    const piFile = store.readSessionStore()[config.sessionId]?.sessionFilePath
    expect(piFile && fs.existsSync(piFile)).toBe(true)

    await sessions.deleteSession(session.id)

    expect(fs.existsSync(piFile!)).toBe(false)
    expect(store.readSessionStore()[config.sessionId]).toBeUndefined()
    stop()
  }, 30000)
})

function userTexts(body: Body | undefined): string[] {
  return (body?.messages ?? [])
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
}

describe("the sandbox of a turn in a Session's folders", () => {
  const MODEL = { source: 'local', model: 'test-model', baseUrl: BACKEND, contextWindow: 8192 }
  let folders: typeof import('../../session/sessionFolders')

  beforeAll(async () => {
    folders = await import('../../session/sessionFolders')
  })

  function hostFolder(name: string, files: Record<string, string> = {}): string {
    const dir = fs.mkdtempSync(path.join(tempRoot, `${name}-`))
    for (const [file, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, file), content)
    }
    return dir
  }

  async function addFolder(sessionId: string, hostPath: string, access?: 'read-write') {
    const { list } = await folders.addSessionFolder(sessionId, hostPath)
    const entry = list.folders.find((folder) => folder.hostPath === hostPath)!
    if (access) await folders.setSessionFolderAccess(sessionId, entry.id, access)
    return entry.slug
  }

  async function workspaceSlug(sessionId: string): Promise<string> {
    return (await folders.sessionWorkspaceEntry(sessionId)).slug
  }

  /** Runs one `bash` call in the turn and returns what the tool answered. */
  async function shell(config: AgentModeTurnConfig, command: string): Promise<string> {
    toolCall = { name: 'bash', args: { command } }
    await manager.startAgentTurn(`t-${Date.now()}`, 'look around', config)
    const toolMessages = (bodies.at(-1)?.messages ?? []).filter((m) => m.role === 'tool')
    return JSON.stringify(toolMessages)
  }

  it("mounts every listed folder at /mnt/<slug>, works in the Workspace's, writes only where allowed", async () => {
    const session = await sessions.createSession()
    const notes = hostFolder('notes', { 'todo.md': 'MILK' })
    const project = hostFolder('project')
    const notesSlug = await addFolder(session.id, notes)
    const projectSlug = await addFolder(session.id, project, 'read-write')
    const workspace = await workspaceSlug(session.id)
    const config = await agentConfig(session.id)

    const seen = await shell(
      config,
      `pwd; ls /mnt; cat /mnt/${notesSlug}/todo.md; echo made > made.md; ` +
        `echo p > /mnt/${projectSlug}/p.md; ls /workspace`,
    )

    expect(seen).toContain(`/mnt/${workspace}`)
    expect(seen).toContain(notesSlug)
    expect(seen).toContain(projectSlug)
    expect(seen).toContain('MILK')
    expect(seen).toContain('/workspace: No such file or directory')
    expect(fs.readFileSync(path.join(config.workspaceDir, 'made.md'), 'utf8')).toBe('made\n')
    expect(fs.readFileSync(path.join(project, 'p.md'), 'utf8')).toBe('p\n')
    const prompt = systemPrompt(bodies[0])
    expect(prompt).toContain(`/mnt/${workspace} — the Workspace: your working`)
    expect(prompt).toContain(`/mnt/${notesSlug} (read-only)`)
    expect(prompt).not.toContain('/workspace')
  }, 30000)

  it("lets the agent read the Session's attachments at /attachments, and not change them", async () => {
    const session = await sessions.createSession()
    const config = await agentConfig(session.id)
    const saved = importAttachment(attachmentsOf(config), 'notes.md', Buffer.from('OATS'))
    expect(saved.path).toBe('/attachments/notes.md')

    toolCall = { name: 'read', args: { path: saved.path } }
    await manager.startAgentTurn('t-read', `summarize @${saved.path}`, config)
    const read = JSON.stringify((bodies.at(-1)?.messages ?? []).filter((m) => m.role === 'tool'))
    const other = await agentConfig((await sessions.createSession()).id)
    importAttachment(attachmentsOf(other), 'notes.md', Buffer.from('OATS'))
    const seen = await shell(other, 'ls /attachments; echo x > /attachments/notes.md; ls')

    expect(read).toContain('OATS')
    expect(seen).toContain('notes.md')
    expect(seen).toMatch(/read-only/i)
    expect(fs.readFileSync(path.join(attachmentsOf(other).dir, 'notes.md'), 'utf8')).toBe('OATS')
    expect(fs.existsSync(path.join(config.workspaceDir, 'attachments'))).toBe(false)
  }, 30000)

  it('gives a real-shell turn the real path of its attachments', async () => {
    const session = await sessions.createSession()
    const config = { ...(await agentConfig(session.id)), unsandboxed: true }
    const saved = importAttachment(attachmentsOf(config), 'notes.md', Buffer.from('OATS'))
    const real = path.join(attachmentsOf(config).dir, 'notes.md')

    toolCall = { name: 'read', args: { path: real } }
    await manager.startAgentTurn('t-real', `summarize @${saved.path}`, config)

    const sent = transcriptText(bodies.at(-1))
    expect(sent).toContain(`@${path.resolve(real).split(path.sep).join('/')}`)
    expect(sent).not.toContain('@/attachments/')
    expect(sent).toContain('OATS')
  }, 30000)

  it('tells a conversation that worked at /workspace where its Workspace is now', async () => {
    const session = await sessions.createSession()
    const config = await agentConfig(session.id)
    await manager.startAgentTurn('t1', 'first', config)
    const pointers = store.readSessionStore()
    const { workdir: _before, ...legacy } = pointers[config.sessionId]
    fs.writeFileSync(
      path.join(tempRoot, 'agent-sessions.json'),
      JSON.stringify({ ...pointers, [config.sessionId]: { ...legacy, mountedFolders: [] } }),
    )
    const notesSlug = await addFolder(session.id, hostFolder('notes'))

    await manager.startAgentTurn('t2', 'second', await agentConfig(session.id))

    const note = userTexts(bodies.at(-1)).at(-1) ?? ''
    const workspace = await workspaceSlug(session.id)
    expect(note).toContain(`working directory, the Workspace, is now /mnt/${workspace}`)
    expect(note).toContain('/workspace is no longer your working directory')
    expect(note).toMatch(new RegExp(`Added: .*/mnt/${notesSlug} \\(read-only\\)`))
    expect(note).toContain('second')
  }, 30000)

  it('continues the same conversation in a newly starred Workspace, with a note saying so', async () => {
    const session = await sessions.createSession()
    const before = await workspaceSlug(session.id)
    const first = await agentConfig(session.id)
    await shell(first, 'echo old > old.md')
    const project = hostFolder('project')
    const { list } = await folders.addSessionFolder(session.id, project)
    const projectEntry = list.folders.find((folder) => folder.hostPath === project)!
    await folders.starSessionFolder(session.id, projectEntry.id)

    const second = await agentConfig(session.id)
    await manager.startAgentTurn('t-star', 'carry on', second)

    expect(second.sessionId).toBe(first.sessionId)
    expect(second.workspaceDir).toBe(project)
    const sent = bodies.at(-1)
    expect(transcriptText(sent)).toContain('echo old > old.md')
    const note = userTexts(sent).at(-1) ?? ''
    expect(note).toContain(`working directory, the Workspace, is now /mnt/${projectEntry.slug}`)
    expect(note).toContain(`/mnt/${before} is no longer your working directory`)
    expect(note).toContain('carry on')
    expect(systemPrompt(sent)).toContain(`/mnt/${projectEntry.slug} — the Workspace: your working`)
    expect(systemPrompt(sent)).toContain(`/mnt/${before} (read-write)`)
  }, 30000)

  it('keeps its conversation and its sandbox paths when the Session renames its Workspace', async () => {
    const session = await sessions.createSession()
    const slug = await workspaceSlug(session.id)
    const config = await agentConfig(session.id)
    await shell(config, 'echo old > old.md')
    const promptBefore = systemPrompt(bodies.at(-1))

    await sessions.renameSession(session.id, 'Cat poster')
    const renamed = (await folders.sessionWorkspaceEntry(session.id)).hostPath
    toolCall = null
    await manager.startAgentTurn('t-renamed', 'carry on', config)

    expect(path.basename(renamed)).toMatch(/ Cat poster$/)
    expect(fs.existsSync(config.workspaceDir)).toBe(false)
    const sent = bodies.at(-1)
    expect(transcriptText(sent)).toContain('echo old > old.md')
    expect(userTexts(sent).at(-1)).not.toContain('no longer your working directory')
    expect(systemPrompt(sent)).toContain(`/mnt/${slug} — the Workspace: your working`)
    expect(systemPrompt(sent)).toBe(promptBefore)
    expect(systemPrompt(sent)).not.toContain('Cat poster')
    expect(fs.readFileSync(path.join(renamed, 'old.md'), 'utf8')).toBe('old\n')
  }, 30000)

  it('refuses a write in a read-only folder of the list', async () => {
    const session = await sessions.createSession()
    const notes = hostFolder('notes')
    const notesSlug = await addFolder(session.id, notes)

    const refused = await shell(await agentConfig(session.id), `echo n > /mnt/${notesSlug}/n.md`)

    expect(refused).toContain(`/mnt/${notesSlug} is a read-only Mounted Folder`)
    expect(fs.existsSync(path.join(notes, 'n.md'))).toBe(false)
  }, 30000)

  it('gives an inheriting Agent Run the Workspace and every other folder', async () => {
    const { taskRunHarnessFor } = await import('../../session/sessionTaskRuns')
    const session = await sessions.createSession()
    const notesSlug = await addFolder(session.id, hostFolder('notes', { 'n.md': 'NOTES' }))
    const { harnessSessionId, workspaceDir } = await taskRunHarnessFor(session.id)
    const config: AgentModeTurnConfig = {
      sessionId: harnessSessionId,
      sessionRef: session.id,
      workspaceDir,
      modelConfig: MODEL as AgentModeTurnConfig['modelConfig'],
      toolSpecs: [],
      capabilities: [],
      taskRun: { taskName: 'Poster' },
    }

    const seen = await shell(config, `pwd; cat /mnt/${notesSlug}/n.md`)

    expect(seen).toContain(`/mnt/${await workspaceSlug(session.id)}`)
    expect(seen).toContain('NOTES')
  }, 30000)

  it("gives a “Use only these” Agent Run the Workspace and its Agent's folders", async () => {
    const { taskRunHarnessFor } = await import('../../session/sessionTaskRuns')
    const session = await sessions.createSession()
    const sessionOnly = await addFolder(session.id, hostFolder('session-only'))
    const reference = hostFolder('reference', { 'brief.md': 'BRIEF' })
    const { harnessSessionId, workspaceDir } = await taskRunHarnessFor(session.id)
    const config: AgentModeTurnConfig = {
      sessionId: harnessSessionId,
      sessionRef: session.id,
      workspaceDir,
      modelConfig: MODEL as AgentModeTurnConfig['modelConfig'],
      toolSpecs: [],
      capabilities: [],
      taskRun: { taskName: 'Poster' },
      folderOverrides: {
        folders: [{ id: 'r', hostPath: reference, slug: 'reference', access: 'read-only' }],
      },
    }

    const seen = await shell(config, 'pwd; ls /mnt; cat /mnt/reference/brief.md')

    expect(seen).toContain(`/mnt/${await workspaceSlug(session.id)}`)
    expect(seen).toContain('BRIEF')
    expect(seen).not.toContain(sessionOnly)
  }, 30000)

  it('mounts a folder that is both the Workspace and an Agent folder once, read-write, at the Workspace slug', async () => {
    const { taskRunHarnessFor } = await import('../../session/sessionTaskRuns')
    const session = await sessions.createSession()
    const workspace = await workspaceSlug(session.id)
    const { harnessSessionId, workspaceDir } = await taskRunHarnessFor(session.id)
    const config: AgentModeTurnConfig = {
      sessionId: harnessSessionId,
      sessionRef: session.id,
      workspaceDir,
      modelConfig: MODEL as AgentModeTurnConfig['modelConfig'],
      toolSpecs: [],
      capabilities: [],
      taskRun: { taskName: 'Poster' },
      folderOverrides: {
        folders: [{ id: 's', hostPath: workspaceDir, slug: 'shared', access: 'read-only' }],
      },
    }

    const seen = await shell(config, `ls /mnt; echo x > /mnt/${workspace}/x.md`)

    expect(seen).not.toContain('shared')
    expect(seen).not.toContain('read-only')
    expect(fs.readFileSync(path.join(workspaceDir, 'x.md'), 'utf8')).toBe('x\n')
  }, 30000)

  it("runs a Trial Run in its scratch folder plus the Agent's folders", async () => {
    const { trialRunHarnessFor } = await import('../../agent/trialRuns')
    const reference = hostFolder('reference')
    const { harnessSessionId, workspaceDir } = await trialRunHarnessFor('agent-trial-1')
    const config: AgentModeTurnConfig = {
      sessionId: harnessSessionId,
      workspaceDir,
      modelConfig: MODEL as AgentModeTurnConfig['modelConfig'],
      toolSpecs: [],
      capabilities: [],
      taskRun: { taskName: 'Poster' },
      folderOverrides: {
        folders: [{ id: 'r', hostPath: reference, slug: 'reference', access: 'read-write' }],
      },
    }

    const seen = await shell(config, 'pwd; ls /mnt; echo t > t.md; echo r > /mnt/reference/r.md')

    expect(seen).toContain('/mnt/files')
    expect(seen).toContain('reference')
    expect(fs.readFileSync(path.join(workspaceDir, 't.md'), 'utf8')).toBe('t\n')
    expect(fs.readFileSync(path.join(reference, 'r.md'), 'utf8')).toBe('r\n')
  }, 30000)
})

describe('the Session Update and session_history for an agent preset', () => {
  async function sessionWithCastle() {
    const session = await sessions.createSession()
    await history.appendHistoryEntry(session.id, {
      preset: 'Draft Image',
      kind: 'image',
      prompt: 'a castle',
      status: 'completed',
      artifacts: [
        { folderId: await workspaceFolderId(session.id), path: 'castle.png', mediaType: 'image' },
      ],
    })
    return session
  }

  it('prepends what it missed to the user message, never the system prompt', async () => {
    const session = await sessionWithCastle()

    await manager.startAgentTurn('t1', 'describe that image', await agentConfig(session.id))

    const body = bodies[0]
    expect(body.messages?.[0].role).toBe('system')
    expect(JSON.stringify(body.messages?.[0].content)).not.toContain('a castle')
    const user = userTexts(body).at(-1)!
    expect(user).toMatch(/Draft Image: \\?"a castle\\?" → castle\.png/)
    expect(user.indexOf('a castle')).toBeLessThan(user.indexOf('describe that image'))
    expect(await history.readHistoryEntries(session.id)).toContainEqual(
      expect.objectContaining({ preset: 'Agent', prompt: 'describe that image' }),
    )
  }, 30000)

  it("reports a Task Run's Steps, which ran under the same preset in another Harness Session", async () => {
    const session = await sessions.createSession()
    await manager.startAgentTurn('t1', 'hello', await agentConfig(session.id))
    await history.appendHistoryEntry(session.id, {
      preset: 'Agent',
      kind: 'agent',
      prompt: 'summarize the inbox',
      status: 'completed',
      artifacts: [],
      response: 'Three new mails.',
      taskName: 'Morning digest',
    })
    bodies = []

    await manager.startAgentTurn('t2', 'what did the task find?', await agentConfig(session.id))

    expect(userTexts(bodies[0]).at(-1)).toContain('summarize the inbox')
  }, 30000)

  it('sends no update when nothing happened since its last turn', async () => {
    const session = await sessionWithCastle()
    await manager.startAgentTurn('t1', 'describe that image', await agentConfig(session.id))
    bodies = []

    await manager.startAgentTurn('t2', 'and now?', await agentConfig(session.id))

    const users = userTexts(bodies[0])
    expect(users.at(-1)).not.toContain('Session Update')
    expect(users.filter((text) => text.includes('Session Update'))).toHaveLength(1)
  }, 30000)

  it('offers session_history, which answers from the Session History', async () => {
    const session = await sessionWithCastle()
    toolCall = { name: 'session_history', args: { action: 'list' } }

    await manager.startAgentTurn('t1', 'what happened here?', await agentConfig(session.id))

    const offered = (bodies[0] as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
    expect(offered.map((tool) => tool.function?.name)).toContain('session_history')
    const toolMessages = (bodies.at(-1)?.messages ?? []).filter((m) => m.role === 'tool')
    expect(JSON.stringify(toolMessages)).toContain('a castle')
    expect(JSON.stringify(toolMessages)).toContain('Draft Image')
  }, 30000)
})

type OfferedTools = { tools?: Array<{ function?: { name?: string } }> }

function offeredToolNames(body: Body | undefined): string[] {
  return ((body as OfferedTools | undefined)?.tools ?? []).map((tool) => tool.function?.name ?? '')
}

function systemPrompt(body: Body | undefined): string {
  const system = body?.messages?.find((message) => message.role === 'system')
  return typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content)
}

describe('the Assistant preset in a Session', () => {
  const ASSISTANT_PROMPT = 'You are a friendly assistant. Answer plainly.'
  const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  )

  async function assistantConfig(
    sessionId: string,
    capabilities?: string[],
    model: Partial<Extract<AgentModeTurnConfig['modelConfig'], { source: 'local' }>> = {},
  ): Promise<AgentModeTurnConfig> {
    const { harnessSessionId, workspaceDir } = await harness.harnessSessionFor(
      sessionId,
      'Assistant',
    )
    return {
      sessionId: harnessSessionId,
      sessionRef: sessionId,
      presetName: 'Assistant',
      ownsPrompt: true,
      instructions: ASSISTANT_PROMPT,
      workspaceDir,
      modelConfig: {
        source: 'local',
        model: 'test-model',
        baseUrl: BACKEND,
        contextWindow: 32768,
        ...model,
      },
      toolSpecs: [],
      ...(capabilities ? { capabilities } : {}),
    }
  }

  it('sends its own prompt instead of the coding agent, from the Session Folder', async () => {
    const session = await sessions.createSession()
    const config = await assistantConfig(session.id, ['web'])
    expect(config.workspaceDir).toBe(workspaces.sessionWorkspaceDir(session.id))

    await manager.startAgentTurn('t1', 'why is the sky blue?', config)

    const prompt = systemPrompt(bodies[0])
    expect(prompt).toContain(ASSISTANT_PROMPT)
    expect(prompt).not.toContain('coding assistant operating inside pi')
    expect(prompt).not.toContain('project workspace')
    expect(prompt).not.toContain('<available_skills>')
  }, 30000)

  it('offers file and web tools by default, and no notify or browser tools', async () => {
    const session = await sessions.createSession()

    await manager.startAgentTurn('t1', 'hello', await assistantConfig(session.id))

    const offered = offeredToolNames(bodies[0])
    expect(offered).toEqual(
      expect.arrayContaining(['read', 'write', 'edit', 'bash', 'web_search', 'web_fetch']),
    )
    for (const name of ['notify_user', 'browser']) expect(offered).not.toContain(name)
    expect(systemPrompt(bodies[0])).not.toContain('coding assistant operating inside pi')
  }, 30000)

  it('transcribes an audio clip attached into the Session Folder', async () => {
    const { importAttachment } = await import('../../agent/workspaceAttachments')
    const session = await sessions.createSession()
    const config = {
      ...(await assistantConfig(session.id, ['media'])),
      toolSpecs: [
        {
          name: 'transcribeAudio',
          description: 'transcribe audio',
          inputSchema: {
            type: 'object',
            properties: { sourceAudioPath: { type: 'string' } },
            required: ['sourceAudioPath'],
          },
        },
      ],
    }
    const clip = importAttachment(
      attachmentsOf(config),
      'note.wav',
      new Uint8Array([82, 73, 70, 70]),
    )
    expect(clip.path).toBe('/attachments/note.wav')
    const { attachmentsDir, filesDir } = sessions.sessionPaths(session.id)
    expect(fs.readFileSync(path.join(attachmentsDir, 'note.wav'))).toEqual(Buffer.from('RIFF'))
    expect(fs.existsSync(path.join(filesDir, 'attachments'))).toBe(false)
    toolCall = { name: 'transcribeAudio', args: { sourceAudioPath: '@attachments/note.wav' } }
    askedRenderer.length = 0

    await manager.startAgentTurn('t1', 'what does @attachments/note.wav say?', config)

    expect(askedRenderer).toEqual([
      expect.objectContaining({ audioBase64: Buffer.from('RIFF').toString('base64') }),
    ])
    const toolMessages = (bodies.at(-1)?.messages ?? []).filter((m) => m.role === 'tool')
    expect(JSON.stringify(toolMessages)).toContain('buy oat milk')
  }, 30000)

  it('gets file and shell tools, and where they work, once files is switched on', async () => {
    const session = await sessions.createSession()

    await manager.startAgentTurn('t1', 'hello', await assistantConfig(session.id, ['files', 'web']))

    expect(offeredToolNames(bodies[0])).toEqual(expect.arrayContaining(['read', 'write', 'bash']))
    const prompt = systemPrompt(bodies[0])
    expect(prompt).toContain(ASSISTANT_PROMPT)
    expect(prompt).toContain('project workspace')
    expect(prompt).not.toContain('coding assistant operating inside pi')
  }, 30000)

  it('sends no tools at all for a model that cannot call them', async () => {
    const session = await sessions.createSession()
    const config = await assistantConfig(session.id, ['files', 'web', 'rag'], {
      supportsToolCalling: false,
      supportsAgentic: false,
    })

    await manager.startAgentTurn('t1', 'hello', config)

    expect(bodies[0]).toBeDefined()
    expect(bodies[0]).not.toHaveProperty('tools')
    expect(systemPrompt(bodies[0])).toContain(ASSISTANT_PROMPT)
  }, 30000)

  it('keeps file and shell tools away from a model not suited to agent work', async () => {
    const session = await sessions.createSession()
    const config = await assistantConfig(session.id, ['files', 'web'], {
      supportsToolCalling: true,
      supportsAgentic: false,
    })

    await manager.startAgentTurn('t1', 'hello', config)

    const offered = offeredToolNames(bodies[0])
    expect(offered).toEqual(expect.arrayContaining(['web_search', 'session_history']))
    for (const name of ['read', 'write', 'edit', 'bash']) expect(offered).not.toContain(name)
    expect(systemPrompt(bodies[0])).not.toContain('project workspace')
  }, 30000)

  it('fits the NPU prompt cap with its NPU default set, every tool offered up front', async () => {
    const session = await sessions.createSession()
    const config = await assistantConfig(session.id, ['media', 'rag', 'web'], {
      backend: 'openVINO',
      device: 'NPU',
      contextWindow: 8192,
      supportsToolCalling: true,
      supportsAgentic: false,
    })

    await manager.startAgentTurn('t1', 'hello', config)

    const offered = offeredToolNames(bodies[0])
    expect(offered).toEqual(expect.arrayContaining(['web_search', 'session_history']))
    expect(offered).not.toContain('capabilities')
    const prefix = JSON.stringify({
      messages: bodies[0]?.messages,
      tools: bodies[0] && (bodies[0] as OfferedTools).tools,
    })
    // ~4 characters per token; 02 measured the default prefix at about 1.2k of the 8k cap.
    expect(prefix.length / 4).toBeLessThan(2048)
  }, 30000)

  describe('with an attached image', () => {
    function imageParts(body: Body | undefined): unknown[] {
      const user = (body?.messages ?? []).filter((message) => message.role === 'user').at(-1)
      return Array.isArray(user?.content)
        ? user.content.filter((part: { type?: string }) => part.type === 'image_url')
        : []
    }

    async function attachPixel(config: AgentModeTurnConfig): Promise<string> {
      const saved = importAttachment(attachmentsOf(config), 'cat.png', new Uint8Array(PIXEL))
      return `what is this?\n\nAttached files: @${saved.path}`
    }

    async function visionConfig(sessionId: string): Promise<AgentModeTurnConfig> {
      const config = await assistantConfig(sessionId)
      return { ...config, modelConfig: { ...config.modelConfig, supportsVision: true } }
    }

    it('shows it to a vision model in the same turn, and keeps the copy', async () => {
      const session = await sessions.createSession()
      const config = await visionConfig(session.id)

      await manager.startAgentTurn('t1', await attachPixel(config), config)

      expect(imageParts(bodies[0])).toEqual([
        expect.objectContaining({
          image_url: expect.objectContaining({ url: expect.stringMatching(/^data:image\//) }),
        }),
      ])
      expect(transcriptText(bodies[0])).toContain('@/attachments/cat.png')
      const { attachmentsDir, filesDir } = sessions.sessionPaths(session.id)
      expect(fs.readFileSync(path.join(attachmentsDir, 'cat.png'))).toEqual(PIXEL)
      expect(fs.existsSync(path.join(filesDir, 'attachments'))).toBe(false)
    }, 30000)

    it('shows an image whose name has a space in it', async () => {
      const session = await sessions.createSession()
      const config = await visionConfig(session.id)
      importAttachment(attachmentsOf(config), 'my cat.png', new Uint8Array(PIXEL))

      await manager.startAgentTurn('t1', 'what is this? @"attachments/my cat.png"', config)

      expect(imageParts(bodies[0])).toHaveLength(1)
    }, 30000)

    it('only tells a model without image input where the file is', async () => {
      const session = await sessions.createSession()
      const config = await assistantConfig(session.id)

      await manager.startAgentTurn('t1', await attachPixel(config), config)

      expect(imageParts(bodies[0])).toEqual([])
      expect(transcriptText(bodies[0])).toContain('@/attachments/cat.png')
    }, 30000)

    it('does not attach a file from outside the Session Folder', async () => {
      const session = await sessions.createSession()
      const config = await visionConfig(session.id)
      const outside = path.join(tempRoot, 'outside.png')
      fs.writeFileSync(outside, PIXEL)
      fs.mkdirSync(attachmentsOf(config).dir, { recursive: true })
      fs.symlinkSync(outside, path.join(attachmentsOf(config).dir, 'link.png'))

      await manager.startAgentTurn(
        't1',
        'look @/attachments/../../outside.png @/attachments/link.png',
        config,
      )

      expect(imageParts(bodies[0])).toEqual([])
    }, 30000)
  })

  describe('turn footer', () => {
    function answerMetadata(turnId: string): Record<string, unknown> {
      return Object.assign(
        {},
        ...kernelEvents
          .filter((event) => event.type === 'agent-chunk' && event.turnId === turnId)
          .map((event) => (event.chunk?.messageMetadata ?? {}) as Record<string, unknown>),
      )
    }

    it("stamps the answer with llama.cpp's own timings for that turn", async () => {
      const session = await sessions.createSession()
      finalChunkExtra = {
        timings: {
          cache_n: 3,
          prompt_n: 120,
          prompt_ms: 400,
          prompt_per_token_ms: 3.33,
          prompt_per_second: 300,
          predicted_n: 50,
          predicted_ms: 2000,
          predicted_per_token_ms: 40,
          predicted_per_second: 25,
        },
      }

      await manager.startAgentTurn('t1', 'why is the sky blue?', await assistantConfig(session.id))

      expect(answerMetadata('t1')).toMatchObject({
        harnessTurnId: 't1',
        timings: { predicted_n: 50, predicted_per_second: 25, prompt_ms: 400 },
      })
    }, 30000)

    it('measures the timings from outside when the backend sends only usage', async () => {
      const session = await sessions.createSession()
      finalChunkExtra = { usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } }

      await manager.startAgentTurn('t1', 'why is the sky blue?', await assistantConfig(session.id))

      const timings = answerMetadata('t1').timings as Record<string, number>
      expect(timings).toMatchObject({ predicted_n: 20, prompt_n: 80 })
      expect(timings.prompt_ms).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(timings.predicted_per_second)).toBe(true)
    }, 30000)

    it('takes a deleted turn out of the timeline and out of what later turns see', async () => {
      const session = await sessions.createSession()
      const config = await assistantConfig(session.id)
      await manager.startAgentTurn('t1', 'remember the word plum', config)
      await manager.startAgentTurn('t2', 'and the word pear', config)
      const tag = { agentTurn: { presetName: 'Assistant', harnessSessionId: config.sessionId } }
      await timeline.upsertTimelineMessages(session.id, [
        { id: 'u1', role: 'user', parts: [], metadata: tag },
        { id: 'a1', role: 'assistant', parts: [], metadata: { ...tag, harnessTurnId: 't1' } },
        { id: 'u2', role: 'user', parts: [], metadata: tag },
        { id: 'a2', role: 'assistant', parts: [], metadata: { ...tag, harnessTurnId: 't2' } },
      ] as never)

      await manager.deleteAgentTurns({
        sessionRef: session.id,
        harnessSessionId: config.sessionId,
        turnIds: ['t1'],
        messageIds: ['u1', 'a1'],
      })
      await manager.startAgentTurn('t3', 'which words?', config)

      const lastRequest = transcriptText(bodies.at(-1))
      expect(lastRequest).not.toContain('plum')
      expect(lastRequest).not.toContain('reply 1')
      expect(lastRequest).toContain('and the word pear')
      expect(lastRequest).toContain('reply 2')
      const ids = (await sessions.readSession(session.id)).timeline.map(
        (message) => (message as { id: string }).id,
      )
      expect(ids).toEqual(['u2', 'a2'])
    }, 30000)

    it('regenerates the latest turn from the Harness Session as it was before it', async () => {
      const session = await sessions.createSession()
      const config = await assistantConfig(session.id)
      await manager.startAgentTurn('t1', 'remember the word plum', config)
      await manager.startAgentTurn('t2', 'and the word pear', config)

      expect(
        await manager.startAgentTurn('t3', 'and the word pear', { ...config, rewindTurnId: 't2' }),
      ).toEqual({ success: true })

      expect(JSON.stringify(bodies[2].messages)).toBe(JSON.stringify(bodies[1].messages))
      expect(transcriptText(bodies[2])).not.toContain('reply 2')
      await manager.startAgentTurn('t4', 'which words?', config)
      const next = transcriptText(bodies.at(-1))
      expect(next).not.toContain('reply 2')
      expect(next).toContain('reply 3')
      expect(next.match(/and the word pear/g)).toHaveLength(1)
    }, 30000)

    it('regenerates a turn with the image that was attached to it', async () => {
      const session = await sessions.createSession()
      const base = await assistantConfig(session.id)
      const config = { ...base, modelConfig: { ...base.modelConfig, supportsVision: true } }
      importAttachment(attachmentsOf(config), 'cat.png', new Uint8Array(PIXEL))
      const prompt = 'what is this? @/attachments/cat.png'
      await manager.startAgentTurn('t1', prompt, config)

      await manager.startAgentTurn('t2', prompt, { ...config, rewindTurnId: 't1' })

      expect(bodies).toHaveLength(2)
      expect(JSON.stringify(bodies[1].messages)).toBe(JSON.stringify(bodies[0].messages))
      expect(transcriptText(bodies[1])).toContain('image_url')
    }, 30000)

    it('refuses to regenerate a turn that is not the latest one', async () => {
      const session = await sessions.createSession()
      const config = await assistantConfig(session.id)
      await manager.startAgentTurn('t1', 'remember the word plum', config)
      await manager.startAgentTurn('t2', 'and the word pear', config)

      const result = await manager.startAgentTurn('t3', 'remember the word plum', {
        ...config,
        rewindTurnId: 't1',
      })

      expect(result.success).toBe(false)
      expect(bodies).toHaveLength(2)
    }, 30000)

    it('deletes a turn of a Harness Session that is no longer the live one', async () => {
      const first = await sessions.createSession()
      const config = await assistantConfig(first.id)
      await manager.startAgentTurn('t1', 'remember the word plum', config)
      const other = await sessions.createSession()
      await manager.startAgentTurn('o1', 'something else', await assistantConfig(other.id))

      await manager.deleteAgentTurns({
        sessionRef: first.id,
        harnessSessionId: config.sessionId,
        turnIds: ['t1'],
        messageIds: [],
      })
      await manager.startAgentTurn('t2', 'which word?', config)

      expect(transcriptText(bodies.at(-1))).not.toContain('plum')
    }, 30000)
  })

  describe('with an attached document', () => {
    async function documentConfig(sessionId: string): Promise<AgentModeTurnConfig> {
      return { ...(await assistantConfig(sessionId)), embeddingModel: 'test-embedding' }
    }

    function attachReport(config: AgentModeTurnConfig): void {
      importAttachment(
        attachmentsOf(config),
        'report.md',
        new TextEncoder().encode('# Report\n\nThe budget is $42.'),
      )
    }

    it('names it on every user message and leaves the system prompt alone', async () => {
      const session = await sessions.createSession()
      const config = await documentConfig(session.id)
      attachReport(config)

      await manager.startAgentTurn('t1', 'what does the report say?', config)
      await manager.startAgentTurn('t2', 'and the budget?', config)

      const first = userTexts(bodies[0]).at(-1)!
      const last = userTexts(bodies.at(-1)).at(-1)!
      for (const message of [first, last]) {
        expect(message).toContain('attachments/report.md')
        expect(message).toContain('rag')
      }
      expect(systemPrompt(bodies.at(-1))).toBe(systemPrompt(bodies[0]))
      expect(systemPrompt(bodies[0])).not.toContain('report.md')
    }, 30000)

    it('answers a rag call from it, with the passage and where it came from', async () => {
      const { setRagAccess } = await import('../../agent/ragAccess.ts')
      const { Document } = await import('@langchain/classic/document')
      const { submitAgentToolResult } = await import('../../agent/piCustomTools.ts')
      setRagAccess({
        ingest: async (document) => ({
          ...document,
          hash: 'h',
          splitDB: [new Document({ pageContent: 'The budget is $42.' })],
        }),
        retrieve: async (inquiry) => [
          new Document({
            pageContent: 'The budget is $42.',
            metadata: { source: inquiry.ragList[0].filepath, loc: { pageNumber: 3 } },
          }),
        ],
        ensureEmbeddingServer: async () => 'http://fake-embedding.test',
      })
      const toolOutputs: unknown[] = []
      rendererSend = (channel, payload) => {
        const request = payload as { requestId?: string; toolName?: string }
        if (channel === 'agentMode:executeTool' && request.requestId) {
          submitAgentToolResult(request.requestId, { status: 'ready' })
        }
        if (channel !== 'kernel:event') return
        for (const event of [payload].flat() as Array<{ type?: string; chunk?: unknown }>) {
          const chunk = event.chunk as { type?: string; output?: unknown } | undefined
          if (event.type === 'agent-chunk' && chunk?.type === 'tool-output-available') {
            toolOutputs.push(chunk.output)
          }
        }
      }
      const session = await sessions.createSession()
      const config = await documentConfig(session.id)
      attachReport(config)
      toolCall = { name: 'rag', args: { files: ['attachments/report.md'], query: 'budget' } }

      await manager.startAgentTurn('t1', 'what is the budget?', config)

      const toolMessages = (bodies.at(-1)?.messages ?? []).filter((m) => m.role === 'tool')
      expect(JSON.stringify(toolMessages)).toContain('The budget is $42.')
      expect(JSON.stringify(toolMessages)).toContain('attachments/report.md (page 3)')
      expect(toolOutputs).toContainEqual(
        expect.objectContaining({
          details: { sources: [{ file: 'attachments/report.md', page: 3 }] },
        }),
      )
    }, 30000)

    it('indexes it on attach, so the first question does not split or embed it again', async () => {
      const { setRagAccess } = await import('../../agent/ragAccess.ts')
      const { Document } = await import('@langchain/classic/document')
      const { submitAgentToolResult } = await import('../../agent/piCustomTools.ts')
      const { indexSessionDocument } = await import('../../agent/sessionDocuments.ts')
      const calls: string[] = []
      setRagAccess({
        ingest: async (document) => {
          calls.push(`ingest ${document.filename}`)
          return { ...document, hash: 'h', splitDB: [new Document({ pageContent: 'budget' })] }
        },
        retrieve: async (inquiry) => {
          calls.push(`embed ${inquiry.embeddingModel} ${inquiry.ragList.map((d) => d.filename)}`)
          return []
        },
        ensureEmbeddingServer: async () => 'http://fake-embedding.test',
      })
      rendererSend = (channel, payload) => {
        const request = payload as { requestId?: string }
        if (channel === 'agentMode:executeTool' && request.requestId) {
          submitAgentToolResult(request.requestId, { status: 'ready' })
        }
      }
      const session = await sessions.createSession()
      const config = await documentConfig(session.id)
      const saved = importAttachment(
        attachmentsOf(config),
        'notes.md',
        new TextEncoder().encode('the budget'),
      )

      await indexSessionDocument(attachmentsOf(config), saved.path, {
        model: 'test-embedding',
        backend: 'llamaCPP',
      })
      expect(calls).toEqual(['ingest notes.md', 'embed test-embedding notes.md'])
      toolCall = { name: 'rag', args: { files: [saved.path], query: 'budget' } }
      await manager.startAgentTurn('t1', 'what is the budget?', config)

      expect(calls.filter((call) => call.startsWith('ingest'))).toHaveLength(1)
    }, 30000)

    it("never reads the chat engine's global document list", async () => {
      const { writeRagDocumentSection, setRagDocumentFilesDeps } =
        await import('../../persist/ragDocumentFiles.ts')
      const { setRagAccess } = await import('../../agent/ragAccess.ts')
      const { submitAgentToolResult } = await import('../../agent/piCustomTools.ts')
      setRagDocumentFilesDeps({ isDemoMode: () => false })
      await writeRagDocumentSection({
        ragList: [
          {
            filename: 'global-handbook.pdf',
            filepath: path.join(tempRoot, 'global-handbook.pdf'),
            type: 'pdf',
            hash: 'global',
            isChecked: true,
            splitDB: [{ pageContent: 'GLOBAL-SECRET', metadata: {} }],
          },
        ],
      })
      const searched: string[] = []
      setRagAccess({
        ingest: async (document) => ({ ...document, hash: 'h', splitDB: [] }),
        retrieve: async (inquiry) => {
          searched.push(...inquiry.ragList.map((doc) => doc.filename))
          return []
        },
        ensureEmbeddingServer: async () => 'http://fake-embedding.test',
      })
      rendererSend = (channel, payload) => {
        const request = payload as { requestId?: string }
        if (channel === 'agentMode:executeTool' && request.requestId) {
          submitAgentToolResult(request.requestId, { status: 'ready' })
        }
      }
      const session = await sessions.createSession()
      const config = await documentConfig(session.id)
      attachReport(config)
      toolCall = { name: 'rag', args: { files: ['attachments/report.md'], query: 'budget' } }

      await manager.startAgentTurn('t1', 'search my documents', config)

      const everything = JSON.stringify(bodies)
      expect(everything).not.toContain('global-handbook')
      expect(everything).not.toContain('GLOBAL-SECRET')
      expect(searched).not.toContain('global-handbook.pdf')
    }, 30000)

    it('does not name documents attached in another Session', async () => {
      const other = await sessions.createSession()
      attachReport(await documentConfig(other.id))
      const session = await sessions.createSession()

      await manager.startAgentTurn('t1', 'hello', await documentConfig(session.id))

      expect(transcriptText(bodies[0])).not.toContain('report.md')
    }, 30000)

    it('says nothing about documents when document search is off', async () => {
      const session = await sessions.createSession()
      const config = await assistantConfig(session.id)
      attachReport(config)

      await manager.startAgentTurn('t1', 'hello', config)

      expect(userTexts(bodies[0]).at(-1)).not.toContain('report.md')
    }, 30000)
  })

  describe('with its Session Settings', () => {
    type Sampled = Body & {
      temperature?: number
      max_tokens?: number
      max_completion_tokens?: number
      chat_template_kwargs?: { reasoning_effort?: string }
    }

    function sampled(body: Body | undefined): Sampled {
      return (body ?? {}) as Sampled
    }

    function maxTokensOf(body: Body | undefined): number | undefined {
      return sampled(body).max_completion_tokens ?? sampled(body).max_tokens
    }

    function settled(
      config: AgentModeTurnConfig,
      settings: { temperature: number; effort: string; maxTokens: number; prompt: string },
    ): AgentModeTurnConfig {
      return {
        ...config,
        instructions: settings.prompt,
        modelConfig: {
          ...(config.modelConfig as Extract<
            AgentModeTurnConfig['modelConfig'],
            { source: 'local' }
          >),
          samplingParams: {
            temperature: settings.temperature,
            chat_template_kwargs: { reasoning_effort: settings.effort },
          },
          maxOutputTokens: settings.maxTokens,
        },
      }
    }

    it('sends its temperature, reasoning effort, max tokens and prompt, and the next turn the changed ones', async () => {
      const session = await sessions.createSession()
      const config = await assistantConfig(session.id)

      await manager.startAgentTurn(
        't1',
        'hello',
        settled(config, { temperature: 0.3, effort: 'low', maxTokens: 512, prompt: 'Be terse.' }),
      )
      const first = bodies.length
      await manager.startAgentTurn(
        't2',
        'again',
        settled(config, {
          temperature: 1.1,
          effort: 'high',
          maxTokens: 2048,
          prompt: 'Answer in rhyme.',
        }),
      )

      expect(sampled(bodies[0]).temperature).toBe(0.3)
      expect(sampled(bodies[0]).chat_template_kwargs?.reasoning_effort).toBe('low')
      expect(maxTokensOf(bodies[0])).toBe(512)
      expect(systemPrompt(bodies[0])).toContain('Be terse.')
      const next = bodies[first]
      expect(sampled(next).temperature).toBe(1.1)
      expect(sampled(next).chat_template_kwargs?.reasoning_effort).toBe('high')
      expect(maxTokensOf(next)).toBe(2048)
      expect(systemPrompt(next)).toContain('Answer in rhyme.')
      expect(systemPrompt(next)).not.toContain('Be terse.')
      expect(transcriptText(next)).toContain('hello')
    }, 30000)

    it('keeps the budget Pi picks for the window when the user asks for more', async () => {
      const session = await sessions.createSession()
      const config = await assistantConfig(session.id)
      const huge = settled(config, {
        temperature: 0.7,
        effort: 'low',
        maxTokens: 1_000_000,
        prompt: 'x',
      })

      await manager.startAgentTurn('t1', 'hello', huge)

      expect(maxTokensOf(bodies[0])).toBeLessThan(32768)
    }, 30000)

    it('offers only the tools of the MCP servers that are ticked', async () => {
      const session = await sessions.createSession()

      await manager.startAgentTurn(
        't1',
        'hello',
        await assistantConfig(session.id, ['web', 'mcp:alpha']),
      )

      const offered = offeredToolNames(bodies[0])
      expect(offered).toContain('mcp__alpha__alpha_lookup')
      expect(offered).not.toContain('beta_lookup')
    }, 30000)
  })
})

describe('an Agent Maker Session migrated to Assistant', () => {
  /** An Agent Maker Session that worked in `picked`, migrated, as its next turn sees it. */
  async function migratedTurn(picked: string) {
    const { migrateAgentMakerSessions } = await import('../../agent/agentMakerMigration')
    const agentSessionFiles = await import('../../persist/agentSessionFiles')
    const { readSessionSettings } = await import('../../session/sessionSettings')
    const { resolveMountedFolders } = await import('@/lib/mountedFolders')
    fs.mkdirSync(picked, { recursive: true })
    const session = await sessions.createSession()
    const old = await harness.harnessSessionFor(session.id, 'Agent')
    await agentSessionFiles.saveAgentSession({
      id: old.harnessSessionId,
      sessionRef: session.id,
      workspaceDir: picked,
      presetName: 'Agent',
      capabilities: ['web'],
      title: 'old',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    })

    await migrateAgentMakerSessions()

    const settings = (await readSessionSettings(session.id)).Assistant.bags.Assistant.values
    const [mount] = resolveMountedFolders(settings.mountedFolders as never)
    const { harnessSessionId, workspaceDir } = await harness.harnessSessionFor(
      session.id,
      'Assistant',
    )
    expect(harnessSessionId).toBe(old.harnessSessionId)
    const config: AgentModeTurnConfig = {
      sessionId: harnessSessionId,
      sessionRef: session.id,
      presetName: 'Assistant',
      ownsPrompt: true,
      instructions: 'You are a friendly assistant.',
      workspaceDir,
      modelConfig: { source: 'local', model: 'test-model', baseUrl: BACKEND, contextWindow: 32768 },
      toolSpecs: [],
      capabilities: settings.capabilities as string[],
    }
    return { config, mountPath: `/mnt/${mount.name}` }
  }

  it('reads the folder it used to work in, through its Mounted Folder', async () => {
    const picked = path.join(tempRoot, 'picked-read')
    const { config, mountPath } = await migratedTurn(picked)
    fs.writeFileSync(path.join(picked, 'notes.md'), 'PLUM-NOTES')
    toolCall = { name: 'read', args: { path: `${mountPath}/notes.md` } }

    await manager.startAgentTurn('t1', 'read my notes', config)

    const toolMessages = (bodies.at(-1)?.messages ?? []).filter((m) => m.role === 'tool')
    expect(JSON.stringify(toolMessages)).toContain('PLUM-NOTES')
  }, 30000)

  it('writes into that folder', async () => {
    const picked = path.join(tempRoot, 'picked-write')
    const { config, mountPath } = await migratedTurn(picked)
    toolCall = {
      name: 'write',
      args: { path: `${mountPath}/answer.md`, content: 'written by Assistant' },
    }

    await manager.startAgentTurn('t1', 'write an answer', config)

    expect(fs.readFileSync(path.join(picked, 'answer.md'), 'utf8')).toBe('written by Assistant')
  }, 30000)
})

describe('earlier chat-engine Assistant turns on the first Pi turn', () => {
  async function assistantConfig(sessionId: string): Promise<AgentModeTurnConfig> {
    const { harnessSessionId, workspaceDir } = await harness.harnessSessionFor(
      sessionId,
      'Assistant',
    )
    return {
      ...(await agentConfig(sessionId)),
      sessionId: harnessSessionId,
      workspaceDir,
      presetName: 'Assistant',
    }
  }

  function chatTurn(prompt: string, response: string) {
    return {
      preset: 'Assistant',
      kind: 'chat' as const,
      prompt,
      status: 'completed' as const,
      artifacts: [],
      response,
    }
  }

  function conversation(body: Body | undefined) {
    return (body?.messages ?? [])
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        role: message.role,
        text:
          typeof message.content === 'string'
            ? message.content
            : (message.content as Array<{ text?: string }>).map((part) => part.text).join(''),
      }))
  }

  async function sessionWithChatTurns() {
    const session = await sessions.createSession()
    await history.appendHistoryEntry(session.id, chatTurn('my cat is called Miso', 'Nice name!'))
    await history.appendHistoryEntry(session.id, {
      preset: 'Draft Image',
      kind: 'image',
      prompt: 'a castle',
      status: 'completed',
      artifacts: [
        { folderId: await workspaceFolderId(session.id), path: 'castle.png', mediaType: 'image' },
      ],
    })
    await history.appendHistoryEntry(session.id, {
      ...chatTurn('draw her', ''),
      response: undefined,
      artifacts: [
        { folderId: await workspaceFolderId(session.id), path: 'miso.png', mediaType: 'image' },
      ],
    })
    return session
  }

  it('replays them as user and assistant messages, in order, ahead of the new prompt', async () => {
    const session = await sessionWithChatTurns()

    await manager.startAgentTurn('t1', "what is my cat's name?", await assistantConfig(session.id))

    const turns = conversation(bodies[0])
    expect(turns.slice(0, 4)).toEqual([
      { role: 'user', text: 'my cat is called Miso' },
      { role: 'assistant', text: 'Nice name!' },
      { role: 'user', text: 'draw her' },
      { role: 'assistant', text: expect.stringContaining('miso.png') },
    ])
    expect(turns).toHaveLength(5)
    expect(turns[4].text).toContain("what is my cat's name?")
  }, 30000)

  it('reports only the other presets’ turns in the Session Update', async () => {
    const session = await sessionWithChatTurns()

    await manager.startAgentTurn('t1', 'hello again', await assistantConfig(session.id))

    const last = userTexts(bodies[0]).at(-1)!
    expect(last).toContain('a castle')
    expect(last).not.toContain('Miso')
    expect(last).not.toContain('draw her')
  }, 30000)

  it('keeps the replayed turns as the same prefix on later turns', async () => {
    const session = await sessionWithChatTurns()
    await manager.startAgentTurn('t1', 'first pi turn', await assistantConfig(session.id))
    const first = conversation(bodies[0])
    bodies = []

    await manager.startAgentTurn('t2', 'second pi turn', await assistantConfig(session.id))

    const second = conversation(bodies[0])
    expect(second.slice(0, first.length)).toEqual(first)
    expect(second.filter((turn) => turn.text === 'my cat is called Miso')).toHaveLength(1)
  }, 30000)

  it('does not replay Agent Maker turns, which already live in the Harness Session', async () => {
    const session = await sessions.createSession()
    const config = await assistantConfig(session.id)
    await history.appendHistoryEntry(session.id, {
      preset: 'Agent',
      kind: 'agent',
      prompt: 'an agent maker turn',
      status: 'completed',
      artifacts: [],
      response: 'done',
      harnessSessionId: config.sessionId,
    })
    await history.appendHistoryEntry(session.id, chatTurn('a chat turn', 'chat reply'))

    await manager.startAgentTurn('t1', 'continue', config)

    const turns = conversation(bodies[0])
    expect(turns.slice(0, 2)).toEqual([
      { role: 'user', text: 'a chat turn' },
      { role: 'assistant', text: 'chat reply' },
    ])
    expect(JSON.stringify(turns)).not.toContain('an agent maker turn')
  }, 30000)

  it('leaves a Session with no earlier Assistant turns unaffected', async () => {
    const session = await sessions.createSession()

    await manager.startAgentTurn('t1', 'just this', await assistantConfig(session.id))

    expect(conversation(bodies[0])).toEqual([{ role: 'user', text: 'just this' }])
  }, 30000)
})
