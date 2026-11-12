import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Home Agent threads become Reachable Sessions, driven against real files in a temp dir: the
// conversation files and RAG documents as the Home Agent left them, Sessions, preferences.json.

const dirs = vi.hoisted(() => ({ root: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => path.join(dirs.root, 'sessions'),
  getSessionsDemoDir: () => path.join(dirs.root, 'sessions-demo'),
  getConversationsDir: () => path.join(dirs.root, 'conversations'),
  getConversationsDemoDir: () => path.join(dirs.root, 'conversations-demo'),
  getPreferencesFile: () => path.join(dirs.root, 'preferences.json'),
  getPreferencesDemoFile: () => path.join(dirs.root, 'preferences-demo.json'),
  getRagDocumentsFile: () => path.join(dirs.root, 'rag', 'documents.json'),
  getRagDocumentsDemoFile: () => path.join(dirs.root, 'rag', 'documents-demo.json'),
  getChannelMessageMapFile: () => path.join(dirs.root, 'channel-messages.json'),
  getChannelMessageMapDemoFile: () => path.join(dirs.root, 'channel-messages-demo.json'),
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../kernel/kernelBus', () => ({
  emitSessionChanged: vi.fn(),
  emitSessionGroupsChanged: vi.fn(),
  emitStored: vi.fn(),
}))

const sessions = await import('../../session/sessions')
const { readHistoryEntries } = await import('../../session/sessionHistory')
const { readSessionSettings } = await import('../../session/sessionSettings')
const { replayChatEngineTurns } = await import('../../agent/piHistoryReplay')
const { sessionDocuments } = await import('../../agent/sessionDocuments')
const preferences = await import('../../persist/preferencesFile')
const { migrateHomeAgentThreads, setHomeAgentThreadMigrationDeps } =
  await import('../../session/homeAgentThreadMigration')

type Message = { id: string; role: string; parts: unknown[]; metadata?: Record<string, unknown> }

function message(id: string, role: string, text: string, timestamp?: number): Message {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
    ...(timestamp === undefined ? {} : { metadata: { timestamp } }),
  }
}

async function writeThread(
  id: string,
  kind: 'main' | 'homeAgent' | null,
  messages: Message[],
  fields: { ragHashes?: string[]; updatedAt?: number } = {},
): Promise<void> {
  const dir = path.join(dirs.root, 'conversations')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      schemaVersion: 1,
      meta: kind ? { presetName: kind === 'homeAgent' ? 'Home Agent' : 'Chat', kind } : null,
      ragHashes: fields.ragHashes ?? [],
      messages,
      updatedAt: fields.updatedAt ?? 1000,
    }),
  )
}

async function writeRagDocuments(documents: { hash: string; filepath: string }[]) {
  await fs.mkdir(path.join(dirs.root, 'rag'), { recursive: true })
  await fs.writeFile(
    path.join(dirs.root, 'rag', 'documents.json'),
    JSON.stringify({
      schemaVersion: 1,
      documents: documents.map((doc) => ({
        ...doc,
        filename: path.basename(doc.filepath),
        type: path.extname(doc.filepath).slice(1),
        splitDB: [],
        isChecked: true,
      })),
    }),
  )
}

async function migratedSessions() {
  return (await sessions.listSessions()).filter((session) => session.reachable)
}

async function sessionTitled(title: string) {
  const found = (await sessions.listSessions()).find((session) => session.title === title)
  if (!found) throw new Error(`no Session titled ${title}`)
  return found
}

const ALL_CHANNELS = ['telegram', 'slack', 'discord', 'local-web']

beforeAll(async () => {
  dirs.root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-home-agent-threads-'))
})

beforeEach(async () => {
  await fs.mkdir(dirs.root, { recursive: true })
  sessions.setSessionDeps({ isDemoMode: () => false })
  setHomeAgentThreadMigrationDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  sessions.resetSessionsForTest()
  preferences.resetPreferencesFileForTest()
  await fs.rm(dirs.root, { recursive: true, force: true })
})

describe('Home Agent threads on upgrade', () => {
  it('each becomes a Reachable Session in no Session Group', async () => {
    await writeThread('ha-1', 'homeAgent', [
      message('u1', 'user', 'What is on my calendar?', 100),
      message('a1', 'assistant', 'A dentist appointment at 3.', 110),
    ])
    await writeThread('ha-2', 'homeAgent', [
      message('u2', 'user', 'Write a haiku'),
      message('a2', 'assistant', 'Autumn moonlight'),
    ])
    await writeThread('main-1', 'main', [message('u3', 'user', 'A desktop chat')])

    await migrateHomeAgentThreads({ routingKey: 'ha-2' })

    const migrated = await migratedSessions()
    expect(migrated.map((session) => session.title).sort()).toEqual([
      'What is on my calendar?',
      'Write a haiku',
    ])
    expect(await sessions.listSessions()).toHaveLength(2)
    expect(await sessions.listSessionGroups()).toEqual([])
    expect(migrated.every((session) => session.groupId === undefined)).toBe(true)
  })

  it('shows the transcript and replays it into the Assistant Harness Session', async () => {
    await writeThread('ha-1', 'homeAgent', [
      message('u1', 'user', 'What is on my calendar?', 100),
      message('a1', 'assistant', 'A dentist appointment at 3.', 110),
      message('u2', 'user', 'And tomorrow?', 120),
      message('a2', 'assistant', 'Nothing.', 130),
    ])

    await migrateHomeAgentThreads({ routingKey: 'ha-1' })

    const [session] = await migratedSessions()
    const file = await sessions.readSession(session.id)
    expect(file.timeline).toEqual([
      expect.objectContaining({ id: 'u1', metadata: expect.objectContaining({ chatTurn: true }) }),
      expect.objectContaining({ id: 'a1', metadata: expect.objectContaining({ chatTurn: true }) }),
      expect.objectContaining({ id: 'u2' }),
      expect.objectContaining({ id: 'a2' }),
    ])
    expect(file.presetsUsed).toEqual(['Assistant'])

    const appended: { role: string; content: unknown }[] = []
    await replayChatEngineTurns(
      {
        appendMessage: (entry: { role: string; content: unknown }) => appended.push(entry),
      } as never,
      {
        sessionRef: session.id,
        presetName: 'Assistant',
        workspaceDir: sessions.sessionPaths(session.id).filesDir,
        model: { api: 'openai-completions', provider: 'local', id: 'qwen' },
      },
    )
    expect(appended.map((entry) => [entry.role, entry.content])).toEqual([
      ['user', 'What is on my calendar?'],
      ['assistant', [{ type: 'text', text: 'A dentist appointment at 3.' }]],
      ['user', 'And tomorrow?'],
      ['assistant', [{ type: 'text', text: 'Nothing.' }]],
    ])
    expect((await readHistoryEntries(session.id)).map((entry) => entry.timestamp)).toEqual([
      110, 130,
    ])
  })

  it('lets the Session notify, as making it reachable by hand would', async () => {
    await writeThread('ha-1', 'homeAgent', [
      message('u1', 'user', 'hi'),
      message('a1', 'assistant', 'hello'),
    ])

    await migrateHomeAgentThreads({ routingKey: 'ha-1', defaultCapabilities: ['web', 'rag'] })

    const [session] = await migratedSessions()
    const settings = await readSessionSettings(session.id)
    expect(settings.Assistant?.bags.Assistant?.values.capabilities).toEqual([
      'web',
      'rag',
      'notify',
    ])
  })

  it("attaches the thread's RAG documents to the Session", async () => {
    const notes = path.join(dirs.root, 'notes.md')
    await fs.writeFile(notes, '# my notes')
    await writeRagDocuments([
      { hash: 'h-notes', filepath: notes },
      { hash: 'h-gone', filepath: path.join(dirs.root, 'deleted.pdf') },
      { hash: 'h-other', filepath: notes },
    ])
    await writeThread(
      'ha-1',
      'homeAgent',
      [message('u1', 'user', 'hi'), message('a1', 'assistant', 'hello')],
      {
        ragHashes: ['h-notes', 'h-gone'],
      },
    )

    await migrateHomeAgentThreads({ routingKey: 'ha-1' })

    const [session] = await migratedSessions()
    const filesDir = sessions.sessionPaths(session.id).filesDir
    expect(sessionDocuments(filesDir)).toEqual(['attachments/notes.md'])
    expect(await fs.readFile(path.join(filesDir, 'attachments', 'notes.md'), 'utf8')).toBe(
      '# my notes',
    )
  })

  it("makes the routing target every Channel's Channel Session, keeping other preferences", async () => {
    await writeThread('ha-1', 'homeAgent', [
      message('u1', 'user', 'first'),
      message('a1', 'assistant', 'one'),
    ])
    await writeThread('ha-2', 'homeAgent', [
      message('u2', 'user', 'second'),
      message('a2', 'assistant', 'two'),
    ])
    await preferences.writePreferenceSection('theme', { theme: 'dark' })

    const result = await migrateHomeAgentThreads({ routingKey: 'ha-1' })

    const target = await sessionTitled('first')
    expect(result.channelSession).toBe(target.id)
    const pointers = Object.fromEntries(ALL_CHANNELS.map((kind) => [kind, target.id]))
    expect(await preferences.readPreferenceSection('channelSessions')).toEqual({ pointers })
    expect(await preferences.readPreferenceSection('theme')).toEqual({ theme: 'dark' })
  })

  it('migrates the legacy singleton thread, and without a routing target picks the newest', async () => {
    await writeThread(
      '__aipg_home_agent__',
      null,
      [message('u1', 'user', 'old'), message('a1', 'assistant', 'x')],
      {
        updatedAt: 500,
      },
    )
    await writeThread(
      'ha-2',
      'homeAgent',
      [message('u2', 'user', 'newer'), message('a2', 'assistant', 'y')],
      {
        updatedAt: 900,
      },
    )

    const result = await migrateHomeAgentThreads({ routingKey: null })

    expect(await migratedSessions()).toHaveLength(2)
    expect(result.channelSession).toBe((await sessionTitled('newer')).id)
  })

  it('leaves out threads with nothing in them', async () => {
    await writeThread('ha-empty', 'homeAgent', [])

    const result = await migrateHomeAgentThreads({ routingKey: 'ha-empty' })

    expect(await sessions.listSessions()).toEqual([])
    expect(result.channelSession).toBeNull()
    expect(await preferences.readPreferenceSection('channelSessions')).toBeUndefined()
  })

  it('leaves a "Home Agent" Group the user already has as it is', async () => {
    const own = await sessions.createSession()
    const { group } = await sessions.createSessionGroup(own.id, 'Home Agent')
    await writeThread('ha-1', 'homeAgent', [
      message('u1', 'user', 'hi'),
      message('a1', 'assistant', 'yo'),
    ])

    await migrateHomeAgentThreads({ routingKey: 'ha-1' })

    expect(await sessions.listSessionGroups()).toEqual([group])
    const migrated = (await migratedSessions()).filter((session) => session.id !== own.id)
    expect(migrated).toHaveLength(1)
    expect(migrated[0].groupId).toBeUndefined()
  })

  it('resumes from a marker the grouped migration left, filing nothing', async () => {
    const earlier = await sessions.createSession()
    const { group } = await sessions.createSessionGroup(earlier.id, 'Home Agent')
    await preferences.writePreferenceSection('homeAgentThreadMigration', {
      done: false,
      sessions: { 'ha-1': earlier.id },
      groupId: group.id,
    })
    await writeThread('ha-1', 'homeAgent', [
      message('u1', 'user', 'first'),
      message('a1', 'assistant', 'one'),
    ])
    await writeThread('ha-2', 'homeAgent', [
      message('u2', 'user', 'second'),
      message('a2', 'assistant', 'two'),
    ])

    const result = await migrateHomeAgentThreads({ routingKey: 'ha-1' })

    expect(result.channelSession).toBe(earlier.id)
    expect(await sessions.listSessions()).toHaveLength(2)
    expect((await sessionTitled('second')).groupId).toBeUndefined()
    expect(await sessions.listSessionGroups()).toEqual([group])
  })

  it('does not run again after a grouped migration finished', async () => {
    await preferences.writePreferenceSection('homeAgentThreadMigration', {
      done: true,
      sessions: { 'ha-1': 'session-old' },
      groupId: 'group-old',
    })
    await writeThread('ha-1', 'homeAgent', [
      message('u1', 'user', 'first'),
      message('a1', 'assistant', 'one'),
    ])

    const result = await migrateHomeAgentThreads({ routingKey: 'ha-1' })

    expect(result.channelSession).toBeNull()
    expect(await sessions.listSessions()).toEqual([])
    expect(await preferences.readPreferenceSection('channelSessions')).toBeUndefined()
  })

  it('migrates a thread once when a reloaded window asks again mid-run', async () => {
    await writeThread('ha-1', 'homeAgent', [
      message('u1', 'user', 'first'),
      message('a1', 'assistant', 'one'),
    ])

    await Promise.all([
      migrateHomeAgentThreads({ routingKey: 'ha-1' }),
      migrateHomeAgentThreads({ routingKey: 'ha-1' }),
    ])

    expect(await sessions.listSessions()).toHaveLength(1)
  })

  it('runs once: a second boot changes nothing', async () => {
    await writeThread('ha-1', 'homeAgent', [
      message('u1', 'user', 'first'),
      message('a1', 'assistant', 'one'),
    ])
    await migrateHomeAgentThreads({ routingKey: 'ha-1' })
    const before = await sessions.listSessions()
    const moved = { pointers: { telegram: 'session-elsewhere' } }
    await preferences.writePreferenceSection('channelSessions', moved)
    await writeThread('ha-2', 'homeAgent', [
      message('u2', 'user', 'late'),
      message('a2', 'assistant', 'two'),
    ])

    const again = await migrateHomeAgentThreads({ routingKey: 'ha-2' })

    expect(again.channelSession).toBeNull()
    expect(await sessions.listSessions()).toEqual(before)
    expect(await preferences.readPreferenceSection('channelSessions')).toEqual(moved)
  })
})
