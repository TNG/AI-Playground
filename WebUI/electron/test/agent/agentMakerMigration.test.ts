import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecordWire } from '@/types/agentSessionIpc'
import type { AgentTask } from '@/types/agentTaskIpc'

// Agent Maker merged into Assistant, driven against real files in a temp dir: Sessions, their
// Session Settings, Harness Session records and the Agents file.

const dirs = vi.hoisted(() => ({ root: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => path.join(dirs.root, 'sessions'),
  getSessionsDemoDir: () => path.join(dirs.root, 'sessions-demo'),
  getAgentSessionsDir: () => path.join(dirs.root, 'agent-sessions'),
  getAgentSessionsDemoDir: () => path.join(dirs.root, 'agent-sessions-demo'),
  getAgentTasksFile: () => path.join(dirs.root, 'agent-tasks.json'),
  getAgentTasksDemoFile: () => path.join(dirs.root, 'agent-tasks-demo.json'),
  getAgentDraftsFile: () => path.join(dirs.root, 'agent-drafts.json'),
  getAgentDraftsDemoFile: () => path.join(dirs.root, 'agent-drafts-demo.json'),
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const sessions = await import('../../session/sessions')
const { harnessSessionFor } = await import('../../session/sessionHarness')
const { readSessionSettings, writePresetSettings } = await import('../../session/sessionSettings')
const taskFiles = await import('../../persist/agentTaskFiles')
const agentSessionFiles = await import('../../persist/agentSessionFiles')
const { migrateAgentLibrary } = await import('../../agent/agentLibraryMigration')
const { migrateAgentMakerSessions } = await import('../../agent/agentMakerMigration')

async function migrate(): Promise<void> {
  await migrateAgentLibrary({ presetsDir: path.join(dirs.root, 'presets') })
  await migrateAgentMakerSessions()
}

function harnessRecord(
  id: string,
  fields: Partial<AgentSessionRecordWire> = {},
): AgentSessionRecordWire {
  return {
    id,
    workspaceDir: '',
    title: id,
    createdAt: 1,
    updatedAt: 10,
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    presetName: 'Agent',
    ...fields,
  }
}

async function record(id: string): Promise<AgentSessionRecordWire | undefined> {
  const boot = await agentSessionFiles.bootstrapAgentSessions()
  return boot.status === 'ok' ? boot.sessions.find((entry) => entry.id === id) : undefined
}

/** A Session with an Agent Maker Harness Session, as the Session-era app wrote it. */
async function agentMakerSession(fields: Partial<AgentSessionRecordWire> = {}) {
  const session = await sessions.createSession()
  const { harnessSessionId, workspaceDir } = await harnessSessionFor(session.id, 'Agent')
  await sessions.mutateSession(session.id, (file) => ({
    ...file,
    presetsUsed: ['Agent', 'Draft Image'],
    timeline: [
      {
        id: 'u1',
        role: 'user',
        parts: [],
        metadata: { agentTurn: { presetName: 'Agent', harnessSessionId } },
      },
    ],
  }))
  await agentSessionFiles.saveAgentSession(
    harnessRecord(harnessSessionId, {
      sessionRef: session.id,
      workspaceDir,
      capabilities: ['media', 'web'],
      ...fields,
    }),
  )
  return { session, harnessSessionId }
}

async function assistantSettings(sessionId: string) {
  return (await readSessionSettings(sessionId)).Assistant?.bags.Assistant
}

function agent(id: string, fields: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    name: id,
    settingsTemplate: { model: 'qwen', capabilities: ['media'] },
    steps: [{ id: 's1', prompt: 'Fetch the news' }],
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  }
}

async function writeAgentsFile(schemaVersion: number, tasks: AgentTask[]): Promise<void> {
  await fs.writeFile(
    path.join(dirs.root, 'agent-tasks.json'),
    JSON.stringify({ schemaVersion, tasks }),
  )
}

beforeAll(async () => {
  dirs.root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-agent-maker-migration-'))
})

beforeEach(async () => {
  await fs.mkdir(dirs.root, { recursive: true })
  sessions.setSessionDeps({ isDemoMode: () => false })
  taskFiles.setAgentTaskFilesDeps({ isDemoMode: () => false })
  agentSessionFiles.setAgentSessionFileDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  sessions.resetSessionsForTest()
  taskFiles.resetAgentTaskFilesForTest()
  agentSessionFiles.resetAgentSessionFilesForTest()
  await fs.rm(dirs.root, { recursive: true, force: true })
})

describe('an Agent Maker Session on upgrade', () => {
  it('opens as an Assistant Session: same Harness Session, renamed everywhere', async () => {
    const { session, harnessSessionId } = await agentMakerSession()

    await migrate()

    const file = await sessions.readSession(session.id)
    expect(file.harnessSessions).toEqual({ Assistant: harnessSessionId })
    expect(file.presetsUsed).toEqual(['Assistant', 'Draft Image'])
    expect(file.timeline).toEqual([
      expect.objectContaining({
        metadata: { agentTurn: { presetName: 'Assistant', harnessSessionId } },
      }),
    ])
    expect((await harnessSessionFor(session.id, 'Assistant')).harnessSessionId).toBe(
      harnessSessionId,
    )
    expect(await record(harnessSessionId)).toMatchObject({
      presetName: 'Assistant',
      capabilities: ['files', 'media', 'web'],
    })
  })

  it('keeps an Assistant Harness Session the Session already has and retires Agent Maker’s', async () => {
    const { session, harnessSessionId } = await agentMakerSession()
    const assistant = await harnessSessionFor(session.id, 'Assistant')

    await migrate()

    const file = await sessions.readSession(session.id)
    expect(file.harnessSessions).toEqual({ Assistant: assistant.harnessSessionId })
    expect(file.retiredHarnessSessions).toEqual([harnessSessionId])
  })

  it('mounts the folder it worked in read-write and works in the Session Folder', async () => {
    const picked = path.join(dirs.root, 'my project')
    await fs.mkdir(picked)
    const { session, harnessSessionId } = await agentMakerSession({ workspaceDir: picked })

    await migrate()

    expect(await assistantSettings(session.id)).toEqual({
      values: {
        capabilities: ['files', 'media', 'web'],
        mountedFolders: [{ hostPath: picked, access: 'read-write' }],
      },
      fromDefaults: false,
    })
    expect((await record(harnessSessionId))?.workspaceDir).toBe(
      sessions.sessionPaths(session.id).filesDir,
    )
  })

  it('mounts no folder it cannot: one that is gone, or the home folder', async () => {
    const gone = await agentMakerSession({ workspaceDir: path.join(dirs.root, 'gone') })
    const home = await agentMakerSession({ workspaceDir: os.homedir() })

    await migrate()

    for (const { session } of [gone, home]) {
      expect((await assistantSettings(session.id))?.values.mountedFolders).toBeUndefined()
    }
  })

  it('merges its Session Settings into Assistant’s: Assistant wins, Agent-only keys stay', async () => {
    const notes = path.join(dirs.root, 'notes')
    const { session } = await agentMakerSession()
    await writePresetSettings(session.id, 'Agent', {
      bags: {
        Agent: {
          values: {
            backend: 'llamaCPP',
            model: 'Agent-27B',
            contextSize: 131072,
            capabilities: ['web', 'mcp:blender'],
            planningThinkingOnly: true,
            mountedFolders: [{ hostPath: notes }],
          },
          fromDefaults: false,
        },
      },
    })
    await writePresetSettings(session.id, 'Assistant', {
      bags: {
        Assistant: {
          values: {
            backend: 'openVINO',
            selectedModels: { llamaCPP: 'Chat-9B', openVINO: 'Chat-OV' },
            contextSize: 32768,
            thinkingEnabled: false,
            temperature: 0.7,
          },
          fromDefaults: true,
        },
      },
    })

    await migrate()

    const settings = await readSessionSettings(session.id)
    expect(settings.Agent).toBeUndefined()
    expect(settings.Assistant.bags.Assistant).toEqual({
      values: {
        backend: 'openVINO',
        model: 'Chat-OV',
        contextSize: 32768,
        thinkingEnabled: false,
        capabilities: ['files', 'web', 'mcp:blender'],
        planningThinkingOnly: true,
        mountedFolders: [{ hostPath: notes }],
      },
      fromDefaults: false,
    })
  })

  it('moves its Session Settings over unchanged when Assistant had none', async () => {
    const { session } = await agentMakerSession()
    await writePresetSettings(session.id, 'Agent', {
      bags: {
        Agent: { values: { model: 'Agent-27B', capabilities: ['files'] }, fromDefaults: true },
      },
    })

    await migrate()

    expect(await assistantSettings(session.id)).toEqual({
      values: { model: 'Agent-27B', capabilities: ['files'] },
      fromDefaults: true,
    })
  })

  it('reads an old chat Assistant’s Session Settings as Assistant’s on the harness', async () => {
    const session = await sessions.createSession()
    await writePresetSettings(session.id, 'Assistant', {
      bags: {
        Assistant: {
          values: { backend: 'llamaCPP', selectedModels: { llamaCPP: 'Chat-9B' } },
          fromDefaults: false,
        },
      },
    })

    await migrate()

    expect(await assistantSettings(session.id)).toEqual({
      values: { backend: 'llamaCPP', model: 'Chat-9B' },
      fromDefaults: false,
    })
  })

  it('refiles an Agent Run under Assistant, keeping its file and shell tools', async () => {
    const session = await sessions.createSession()
    await agentSessionFiles.saveAgentSession(
      harnessRecord('aipg-agent-run', {
        sessionRef: session.id,
        workspaceDir: sessions.sessionPaths(session.id).filesDir,
        settings: { capabilities: ['media'] },
        taskRun: { taskId: 't-news', taskName: 'News', startedAt: 3 },
      }),
    )

    await migrate()

    expect(await record('aipg-agent-run')).toMatchObject({
      presetName: 'Assistant',
      settings: { capabilities: ['files', 'media'] },
      taskRun: { taskId: 't-news' },
    })
  })

  it('runs again harmlessly', async () => {
    const picked = path.join(dirs.root, 'project')
    await fs.mkdir(picked)
    const { session, harnessSessionId } = await agentMakerSession({ workspaceDir: picked })
    await migrate()
    const once = await sessions.readSession(session.id)

    await migrate()

    expect(await sessions.readSession(session.id)).toEqual(once)
    expect((await record(harnessSessionId))?.capabilities).toEqual(['files', 'media', 'web'])
  })
})

describe('the Agent Library on upgrade', () => {
  it('keeps Settings Templates and Schedules, which gain the file and shell tools once', async () => {
    const session = await sessions.createSession()
    const schedule = {
      every: 1,
      unit: 'days' as const,
      startAt: 5,
      enabled: true,
      sessionRef: session.id,
      nextRunAt: 50,
    }
    await writeAgentsFile(2, [agent('t-news', { schedules: [schedule] }), agent('t-bare')])
    await taskFiles.saveAgentDraft({
      agentId: 't-news',
      name: 'News, edited',
      settingsTemplate: { capabilities: ['web'] },
      steps: [],
      updatedAt: 2,
    })

    await migrate()

    const tasks = await taskFiles.readAgentTasks()
    expect(tasks.find((task) => task.id === 't-news')).toMatchObject({
      settingsTemplate: { model: 'qwen', capabilities: ['files', 'media'] },
      schedules: [schedule],
    })
    expect((await taskFiles.readAgentDrafts())[0].settingsTemplate).toEqual({
      capabilities: ['files', 'web'],
    })

    await taskFiles.saveAgentTask({
      ...tasks[0],
      settingsTemplate: { model: 'qwen', capabilities: ['media'] },
    })
    await migrate()
    expect((await taskFiles.readAgentTasks())[0].settingsTemplate.capabilities).toEqual(['media'])
  })

  it('gives Agents of a pre-Library install the tools too, after the Library migration', async () => {
    await writeAgentsFile(1, [agent('t-news')])

    await migrate()

    expect((await taskFiles.readAgentTasks())[0].settingsTemplate.capabilities).toEqual([
      'files',
      'media',
    ])
  })
})
