import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecordWire } from '@/types/agentSessionIpc'
import type { AgentDraft, AgentTask } from '@/types/agentTaskIpc'

// The upgrade to the Agent Library, driven against real files in a temp dir: Agent Presets,
// Sessions, Harness Session records, the Agents file and the Drafts file.

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
const { appendHistoryEntry } = await import('../../session/sessionHistory')
const { writePresetSettings } = await import('../../session/sessionSettings')
const taskFiles = await import('../../persist/agentTaskFiles')
const agentSessionFiles = await import('../../persist/agentSessionFiles')
const { migrateAgentLibrary } = await import('../../agent/agentLibraryMigration')

const presetsDir = () => path.join(dirs.root, 'presets')

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

async function writeAgentsFileV1(tasks: AgentTask[]): Promise<void> {
  await fs.writeFile(
    path.join(dirs.root, 'agent-tasks.json'),
    JSON.stringify({ schemaVersion: 1, tasks }),
  )
}

async function writePreset(file: string, preset: Record<string, unknown>): Promise<void> {
  await fs.mkdir(presetsDir(), { recursive: true })
  await fs.writeFile(path.join(presetsDir(), file), JSON.stringify(preset))
}

function agentPreset(name: string, agentTaskId: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'chat',
    name,
    category: 'chat',
    description: `${name} preset`,
    image: 'data:image/png;base64,ICON',
    agentPreset: true,
    agentTaskId,
    ...extra,
  }
}

async function presetFiles(): Promise<string[]> {
  return (await fs.readdir(presetsDir()).catch(() => [])).sort()
}

function harnessRecord(
  id: string,
  fields: Partial<AgentSessionRecordWire> = {},
): AgentSessionRecordWire {
  return {
    id,
    workspaceDir: path.join(dirs.root, 'ws'),
    title: id,
    createdAt: 1,
    updatedAt: 10,
    messages: [],
    presetName: 'Agent',
    ...fields,
  }
}

async function record(id: string): Promise<AgentSessionRecordWire | undefined> {
  const boot = await agentSessionFiles.bootstrapAgentSessions()
  return boot.status === 'ok' ? boot.sessions.find((entry) => entry.id === id) : undefined
}

async function draftOf(agentId: string): Promise<AgentDraft | undefined> {
  return (await taskFiles.readAgentDrafts()).find((draft) => draft.agentId === agentId)
}

async function migrate(): Promise<void> {
  await migrateAgentLibrary({ presetsDir: presetsDir() })
}

beforeAll(async () => {
  dirs.root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-agent-library-migration-'))
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

describe('Agent Presets on upgrade', () => {
  it('become their Agent’s description and image, and the preset copy is removed', async () => {
    await writeAgentsFileV1([agent('t-news'), agent('t-other')])
    await writePreset('Morning_news.json', agentPreset('Morning news', 't-news'))
    await writePreset('My_chat.json', { type: 'chat', name: 'My chat', description: 'Mine' })

    await migrate()

    const tasks = await taskFiles.readAgentTasks()
    expect(tasks.find((task) => task.id === 't-news')).toMatchObject({
      description: 'Morning news preset',
      image: 'data:image/png;base64,ICON',
    })
    expect(tasks.find((task) => task.id === 't-other')?.description).toBeUndefined()
    expect(await presetFiles()).toEqual(['My_chat.json'])
  })

  it('keeps a description the Agent already has and an image that is not a data URI out', async () => {
    await writeAgentsFileV1([agent('t-news', { description: 'Already described' })])
    await writePreset(
      'Morning_news.json',
      agentPreset('Morning news', 't-news', { image: 'agent.png' }),
    )

    await migrate()

    const [task] = await taskFiles.readAgentTasks()
    expect(task.description).toBe('Already described')
    expect(task.image).toBeUndefined()
    expect(await presetFiles()).toEqual([])
  })

  it('removes a preset whose Agent no longer exists', async () => {
    await writeAgentsFileV1([])
    await writePreset('Gone.json', agentPreset('Gone', 't-gone'))

    await migrate()

    expect(await taskFiles.readAgentTasks()).toEqual([])
    expect(await presetFiles()).toEqual([])
  })

  it('picks the Agent in a Session whose last turn ran under its preset', async () => {
    await writeAgentsFileV1([agent('t-news')])
    await writePreset('Morning_news.json', agentPreset('Morning news', 't-news'))
    const underPreset = await sessions.createSession()
    const movedOn = await sessions.createSession()
    const neverUsed = await sessions.createSession()
    const turn = { kind: 'agent' as const, prompt: 'hi', status: 'completed' as const }
    await appendHistoryEntry(underPreset.id, { ...turn, preset: 'Morning news', artifacts: [] })
    await appendHistoryEntry(movedOn.id, { ...turn, preset: 'Morning news', artifacts: [] })
    await appendHistoryEntry(movedOn.id, { ...turn, preset: 'Agent', artifacts: [] })

    await migrate()

    const listed = Object.fromEntries(
      (await sessions.listSessions()).map((session) => [session.id, session.pickedAgentId]),
    )
    expect(listed).toEqual({
      [underPreset.id]: 't-news',
      [movedOn.id]: undefined,
      [neverUsed.id]: undefined,
    })
  })
})

describe('a loaded Agent’s unsaved changes on upgrade', () => {
  it('become its Draft when its Steps differ from the saved Agent', async () => {
    await writeAgentsFileV1([agent('t-news')])
    const steps = [{ id: 's1', prompt: 'Fetch the news and summarize it' }]
    await agentSessionFiles.saveAgentSession(
      harnessRecord('aipg-agent-1', {
        taskId: 't-news',
        steps,
        settings: { model: 'qwen', capabilities: ['media'] },
      }),
    )

    await migrate()

    expect(await draftOf('t-news')).toMatchObject({
      name: 't-news',
      steps,
      settingsTemplate: { model: 'qwen', capabilities: ['media'] },
    })
  })

  it('become its Draft when the Session holds different settings for it', async () => {
    await writeAgentsFileV1([agent('t-news')])
    const session = await sessions.createSession()
    await writePresetSettings(session.id, 'Agent', {
      bags: { Agent: { values: { model: 'llama', capabilities: ['media'] }, fromDefaults: false } },
    })
    await agentSessionFiles.saveAgentSession(
      harnessRecord('aipg-agent-1', {
        taskId: 't-news',
        steps: [{ id: 's1', prompt: 'Fetch the news' }],
        sessionRef: session.id,
      }),
    )

    await migrate()

    expect((await draftOf('t-news'))?.settingsTemplate).toEqual({
      model: 'llama',
      capabilities: ['media'],
    })
  })

  it('make no Draft when nothing differs, and never overwrite an existing Draft', async () => {
    await writeAgentsFileV1([agent('t-same'), agent('t-drafted')])
    const existing: AgentDraft = {
      agentId: 't-drafted',
      name: 'Edited in the library',
      settingsTemplate: {},
      steps: [{ id: 'd', prompt: 'Library edit' }],
      updatedAt: 5,
    }
    await taskFiles.saveAgentDraft(existing)
    await agentSessionFiles.saveAgentSession(
      harnessRecord('aipg-agent-1', {
        taskId: 't-same',
        steps: [{ id: 'other-id', prompt: 'Fetch the news' }],
        settings: { capabilities: ['media'], model: 'qwen' },
      }),
    )
    await agentSessionFiles.saveAgentSession(
      harnessRecord('aipg-agent-2', {
        taskId: 't-drafted',
        steps: [{ id: 's1', prompt: 'Session edit' }],
      }),
    )

    await migrate()

    expect(await draftOf('t-same')).toBeUndefined()
    expect(await draftOf('t-drafted')).toEqual(existing)
  })

  it('drops Steps from Harness Sessions, linked or not, and leaves Agent Runs alone', async () => {
    await writeAgentsFileV1([agent('t-news')])
    await agentSessionFiles.saveAgentSession(
      harnessRecord('aipg-agent-unlinked', { steps: [{ id: 'x', prompt: 'Loose step' }] }),
    )
    await agentSessionFiles.saveAgentSession(
      harnessRecord('aipg-agent-deleted', {
        taskId: 't-deleted',
        steps: [{ id: 'x', prompt: 'Step of a deleted Agent' }],
      }),
    )
    await agentSessionFiles.saveAgentSession(
      harnessRecord('aipg-agent-linked', {
        taskId: 't-news',
        steps: [{ id: 's1', prompt: 'Fetch the news' }],
      }),
    )
    const run = harnessRecord('aipg-agent-run', {
      taskId: 't-news',
      steps: [{ id: 's1', prompt: 'Fetch the news' }],
      taskRun: { taskName: 't-news', startedAt: 3 },
    })
    await agentSessionFiles.saveAgentSession(run)

    await migrate()

    for (const id of ['aipg-agent-unlinked', 'aipg-agent-deleted', 'aipg-agent-linked']) {
      const migrated = await record(id)
      expect(migrated?.steps).toBeUndefined()
      expect(migrated?.taskId).toBeUndefined()
    }
    expect(await record('aipg-agent-run')).toMatchObject({ taskId: 't-news', steps: run.steps })
    expect(await draftOf('t-deleted')).toBeUndefined()
  })
})

describe('the migration', () => {
  it('runs once: a second start changes nothing', async () => {
    await writeAgentsFileV1([agent('t-news')])
    await migrate()
    await writePreset('Morning_news.json', agentPreset('Morning news', 't-news'))
    await agentSessionFiles.saveAgentSession(
      harnessRecord('aipg-agent-1', {
        taskId: 't-news',
        steps: [{ id: 's1', prompt: 'Changed' }],
      }),
    )

    await migrate()

    expect(await presetFiles()).toEqual(['Morning_news.json'])
    expect((await taskFiles.readAgentTasks())[0].description).toBeUndefined()
    expect(await draftOf('t-news')).toBeUndefined()
    expect((await record('aipg-agent-1'))?.steps).toHaveLength(1)
  })

  it('runs on a machine that never saved an Agent', async () => {
    await writePreset('Gone.json', agentPreset('Gone', 't-gone'))

    await migrate()

    expect(await taskFiles.readAgentTasks()).toEqual([])
    expect(await presetFiles()).toEqual([])
  })
})
