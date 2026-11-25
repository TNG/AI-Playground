import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Panel media and audio turns reach the Overview Summary through the same
// settlement seam as a text turn: they carry the renderer-resolved local model
// and reply language, they wait for the update before they settle, and a cloud
// or failing update leaves the entry pending/failed without failing the turn.

const dirs = vi.hoisted(() => ({ real: '', demo: '', games: '', mediaRecords: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getLegacySessionsDir: () => dirs.real,
  getAppWorkspacesDir: () => `${dirs.real}-workspaces`,
  getSessionsDemoDir: () => dirs.demo,
  getLegacySessionsDemoDir: () => dirs.demo,
  getAppWorkspacesDemoDir: () => `${dirs.demo}-workspaces`,
  getGamesDir: () => dirs.games,
  getMediaRecordsDir: () => dirs.mediaRecords,
  getMediaRecordsDemoDir: () => `${dirs.mediaRecords}-demo`,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../kernel/kernelBus', () => ({
  emitSessionChanged: vi.fn(),
  emitSessionGroupsChanged: vi.fn(),
  emitFailure: vi.fn(),
}))

const { createSession, mutateSession, openSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { appendHistoryEntry, readHistoryEntries } = await import('../../session/sessionHistory')
const { recordMediaTurn } = await import('../../session/sessionMediaTurn')
const { recordAudioTurn } = await import('../../session/sessionAudioTurn')
const summary = await import('../../session/overviewSummary')
import type { ChatModelConfig } from '@/types/chatIpc'
import type { AudioTurnRequest, HistoryEntry } from '@/types/sessionIpc'

type CompleteArgs = Parameters<
  NonNullable<Parameters<typeof summary.setOverviewSummaryComplete>[0]>
>[0]

const MODEL: ChatModelConfig = {
  backend: 'llamaCPP',
  modelId: 'qwen-test',
  readiness: { serviceName: 'llamacpp-backend', llmModelName: 'qwen-test' },
}
const REQUEST = { model: MODEL, language: 'de' }
const SUMMARISER = {
  readiness: { serviceName: 'llamacpp-backend', llmModelName: 'qwen-test' },
  replyLanguage: 'de',
}

let calls: CompleteArgs[] = []
let reply: (
  args: CompleteArgs,
) => Promise<{ text: string; pictureMatches: boolean; tokens?: number }> = async () => ({
  text: 'A short account of the Session.',
  pictureMatches: false,
  tokens: 12,
})

const WAV = Buffer.from('RIFF fake wav bytes').toString('base64')

function tts(sessionId: string, overrides: Partial<AudioTurnRequest> = {}): AudioTurnRequest {
  return {
    sessionId,
    kind: 'tts',
    preset: 'Text to Speech',
    prompt: 'Hello there',
    status: 'completed',
    engine: 'Kokoro',
    audio: { base64: WAV, fileName: 'tts-hello.wav' },
    ...overrides,
  }
}

function mediaTurn(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    runId: 'run-1',
    mode: 'imageGen' as const,
    preset: 'Draft Image',
    prompt: 'a red fox',
    status: 'completed' as const,
    items: [],
    localPathOf: () => null,
    ...overrides,
  }
}

async function included(): Promise<string> {
  const session = await createSession()
  await mutateSession(session.id, (file) => ({ ...file, title: 'Kitchen renovation' }))
  await appendHistoryEntry(session.id, entry({ prompt: 'set up the project' }))
  await summary.applyOverviewInclusion(session.id, true, REQUEST)
  await vi.waitFor(async () => {
    expect((await openSession(session.id)).overviewSummary?.state).toBe('ready')
  })
  calls = []
  return session.id
}

function entry(overrides: Partial<HistoryEntry> = {}): Omit<HistoryEntry, 'id' | 'timestamp'> {
  return {
    preset: 'Assistant',
    kind: 'chat',
    prompt: 'a prompt',
    status: 'completed',
    artifacts: [],
    ...overrides,
  }
}

function lastEntry(entries: HistoryEntry[]): HistoryEntry {
  const last = entries.at(-1)
  if (!last) throw new Error('no entries')
  return last
}

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-overview-media-audio-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.games = path.join(root, 'games')
  dirs.mediaRecords = path.join(root, 'media-records')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
  calls = []
  reply = async () => ({
    text: 'A short account of the Session.',
    pictureMatches: false,
    tokens: 12,
  })
  summary.setOverviewSummaryComplete(async (args) => {
    calls.push(args)
    return reply(args)
  })
})

afterEach(async () => {
  summary.resetOverviewSummaryForTest()
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.mediaRecords, { recursive: true, force: true })
  await fs.rm(dirs.games, { recursive: true, force: true })
})

describe('a settled panel media turn updates the summary', () => {
  it('writes the account and records the outcome on the media entry', async () => {
    const sessionId = await included()

    await recordMediaTurn(mediaTurn(sessionId), { summariser: SUMMARISER })

    const entries = await readHistoryEntries(sessionId)
    const written = lastEntry(entries)
    const stored = (await openSession(sessionId)).overviewSummary
    expect(written.kind).toBe('image')
    expect(written.overviewUpdate).toMatchObject({
      state: 'ready',
      model: 'qwen-test',
      text: 'A short account of the Session.',
      coveredEntryId: stored?.coveredEntryId,
    })
    expect(stored?.state).toBe('ready')
    expect(calls).toHaveLength(1)
    expect(calls[0].prompt).toContain('a red fox')
    expect(calls[0].prompt).toContain('Reply language: de')
  })

  it('waits for the update before the media settlement resolves', async () => {
    const sessionId = await included()
    let release: (value: { text: string; pictureMatches: boolean }) => void = () => {}
    reply = () => new Promise((resolve) => (release = resolve))

    let done = false
    const settling = recordMediaTurn(mediaTurn(sessionId), { summariser: SUMMARISER }).then(() => {
      done = true
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(done).toBe(false)
    release({ text: 'A later account.', pictureMatches: false })
    await settling
    expect(done).toBe(true)
  })

  it('releases the GPU and loads the chat model before the update runs', async () => {
    const sessionId = await included()
    const order: string[] = []

    await recordMediaTurn(mediaTurn(sessionId), {
      summariser: SUMMARISER,
      beforeSummary: async () => {
        order.push('before-summary')
      },
    })

    expect(order).toEqual(['before-summary'])
    expect(calls).toHaveLength(1)
  })

  it('leaves a cloud media turn pending without calling a model', async () => {
    const sessionId = await included()

    await recordMediaTurn(mediaTurn(sessionId), {
      summariser: { replyLanguage: 'de' },
    })

    const entries = await readHistoryEntries(sessionId)
    expect(lastEntry(entries).overviewUpdate?.state).toBe('pending')
    const stored = (await openSession(sessionId)).overviewSummary
    expect(stored?.state).toBe('pending')
    expect(stored?.text).toBe('A short account of the Session.')
    expect(calls).toEqual([])
  })

  it('records a failed update without failing the media turn', async () => {
    const sessionId = await included()
    reply = async () => {
      throw new Error('the model went away')
    }

    await recordMediaTurn(mediaTurn(sessionId), { summariser: SUMMARISER })

    const written = lastEntry(await readHistoryEntries(sessionId))
    expect(written.kind).toBe('image')
    expect(written.overviewUpdate).toMatchObject({
      state: 'failed',
      failureReason: expect.stringContaining('the model went away'),
    })
    expect((await openSession(sessionId)).overviewSummary?.state).toBe('failed')
  })

  it('does not touch a media turn in a Session that is not included', async () => {
    const session = await createSession()

    await recordMediaTurn(mediaTurn(session.id), { summariser: SUMMARISER })

    const written = lastEntry(await readHistoryEntries(session.id))
    expect(written.overviewUpdate).toBeUndefined()
    expect(calls).toEqual([])
  })
})

describe('a settled audio turn updates the summary', () => {
  it('writes the account and records the outcome on the audio entry', async () => {
    const sessionId = await included()

    await recordAudioTurn(tts(sessionId, { summariser: SUMMARISER }))

    const written = lastEntry(await readHistoryEntries(sessionId))
    const stored = (await openSession(sessionId)).overviewSummary
    expect(written.kind).toBe('tts')
    expect(written.overviewUpdate).toMatchObject({
      state: 'ready',
      text: 'A short account of the Session.',
      coveredEntryId: stored?.coveredEntryId,
    })
    expect(stored?.state).toBe('ready')
    expect(calls).toHaveLength(1)
    expect(calls[0].prompt).toContain('Hello there')
  })

  it('waits for the update before the audio settlement resolves', async () => {
    const sessionId = await included()
    let release: (value: { text: string; pictureMatches: boolean }) => void = () => {}
    reply = () => new Promise((resolve) => (release = resolve))

    let done = false
    const settling = recordAudioTurn(tts(sessionId, { summariser: SUMMARISER })).then(() => {
      done = true
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(done).toBe(false)
    release({ text: 'A later account.', pictureMatches: false })
    await settling
    expect(done).toBe(true)
  })

  it('leaves a no-local-model audio turn pending without calling a model', async () => {
    const sessionId = await included()

    await recordAudioTurn(tts(sessionId, { summariser: { replyLanguage: 'de' } }))

    const written = lastEntry(await readHistoryEntries(sessionId))
    expect(written.kind).toBe('tts')
    expect(written.overviewUpdate?.state).toBe('pending')
    expect(calls).toEqual([])
  })

  it('records a failed update without failing the audio turn', async () => {
    const sessionId = await included()
    reply = async () => {
      throw new Error('the model went away')
    }

    await recordAudioTurn(tts(sessionId, { summariser: SUMMARISER }))

    const written = lastEntry(await readHistoryEntries(sessionId))
    expect(written.kind).toBe('tts')
    expect(written.overviewUpdate?.state).toBe('failed')
  })
})

describe('a media or audio entry keeps its own update row', () => {
  it('carries the update on the entry the timeline row reads', async () => {
    const sessionId = await included()

    await recordMediaTurn(mediaTurn(sessionId), { summariser: SUMMARISER })
    await recordAudioTurn(tts(sessionId, { prompt: 'Speak this', summariser: SUMMARISER }))

    const { historyOverviewUpdates } = await import('../../session/sessionHistory')
    const rows = await historyOverviewUpdates(sessionId)
    expect(rows.map((row) => row.kind)).toEqual(['image', 'tts'])
    expect(rows.every((row) => row.update.state === 'ready')).toBe(true)
  })
})
