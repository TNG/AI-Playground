import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The stored Overview Summary, driven against real Session files in a temp
// user-data directory with an injected fake completion: activation, the whole
// history, the picture, opt-out and re-enable are all observed through the
// Session record the caller reads.

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

const {
  createSession,
  mutateSession,
  openSession,
  resetSessionsForTest,
  sessionPaths,
  setSessionDeps,
} = await import('../../session/sessions')
const { appendHistoryEntry } = await import('../../session/sessionHistory')
const summary = await import('../../session/overviewSummary')
const { createGame, updateGame } = await import('../../agent/games/gameLibrary')
const { emitFailure, emitSessionChanged } = await import('../../kernel/kernelBus')
const { sessionFolderMediaUrl } = await import('@/lib/comfyWorkflow')
const { ensureWorkspaceEntry } = await import('../../session/appWorkspace')
import type { ChatModelConfig } from '@/types/chatIpc'
import type { HistoryEntry } from '@/types/sessionIpc'

type CompleteArgs = Parameters<
  NonNullable<Parameters<typeof summary.setOverviewSummaryComplete>[0]>
>[0]

const MODEL: ChatModelConfig = {
  backend: 'llamaCPP',
  modelId: 'qwen-test',
  readiness: { serviceName: 'llamacpp-backend', llmModelName: 'qwen-test' },
}
const REQUEST = { model: MODEL, language: 'de' }

let calls: CompleteArgs[] = []
let reply: (
  args: CompleteArgs,
) => Promise<{ text: string; pictureMatches: boolean }> = async () => ({
  text: 'A short account of the Session.',
  pictureMatches: false,
})

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

async function addEntry(sessionId: string, overrides: Partial<HistoryEntry> = {}) {
  return appendHistoryEntry(sessionId, entry(overrides))
}

async function writeImage(sessionId: string, name: string): Promise<string> {
  const file = path.join(sessionPaths(sessionId).filesDir, name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, 'png')
  return `files/${name}`
}

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-overview-summary-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.games = path.join(root, 'games')
  dirs.mediaRecords = path.join(root, 'media-records')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
  calls = []
  reply = async () => ({ text: 'A short account of the Session.', pictureMatches: false })
  summary.setOverviewSummaryComplete(async (args) => {
    calls.push(args)
    return reply(args)
  })
  vi.mocked(emitSessionChanged).mockClear()
  vi.mocked(emitFailure).mockClear()
})

afterEach(async () => {
  summary.resetOverviewSummaryForTest()
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.games, { recursive: true, force: true })
})

describe('the Session record and panel row', () => {
  it('starts with no Overview Summary, and an old file reads the same', async () => {
    const session = await createSession()

    expect(session.includedInOverviews).toBe(false)
    expect(session.overviewSummaryState).toBeUndefined()
    expect(await openSession(session.id)).not.toHaveProperty('overviewSummary')

    const file = path.join(dirs.real, session.id, 'session.json')
    const { overviewSummary: _summary, ...legacy } = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(file, JSON.stringify(legacy))

    expect((await openSession(session.id)).overviewSummaryState).toBeUndefined()
  })

  it('carries the inclusion flag and the summary state on the panel row and the document', async () => {
    const session = await createSession()
    await addEntry(session.id)
    await summary.applyOverviewInclusion(session.id, true, REQUEST)
    await vi.waitFor(async () => {
      expect((await openSession(session.id)).overviewSummary?.state).toBe('ready')
    })

    const document = await openSession(session.id)
    const { timeline: _timeline, ...row } = document
    expect(row).toMatchObject({
      includedInOverviews: true,
      overviewSummaryState: 'ready',
    })
    expect(row.overviewSummary).toMatchObject({
      text: 'A short account of the Session.',
      language: 'de',
      model: 'qwen-test',
      contractVersion: summary.OVERVIEW_SUMMARY_CONTRACT_VERSION,
    })
  })
})

describe('enabling a Session', () => {
  it('writes nothing for a Session with no History Entries', async () => {
    const session = await createSession()

    await summary.applyOverviewInclusion(session.id, true, REQUEST)

    const document = await openSession(session.id)
    expect(document.includedInOverviews).toBe(true)
    expect(document).not.toHaveProperty('overviewSummary')
    expect(document.overviewSummaryState).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('summarises the whole history and records it ready', async () => {
    const session = await createSession()
    const first = await addEntry(session.id, { prompt: 'set up the project' })
    const newest = await addEntry(session.id, { prompt: 'fixed the last bug' })

    await summary.applyOverviewInclusion(session.id, true, REQUEST)
    await vi.waitFor(async () => {
      expect((await openSession(session.id)).overviewSummary?.state).toBe('ready')
    })

    const stored = (await openSession(session.id)).overviewSummary
    expect(stored?.text).toBe('A short account of the Session.')
    expect(stored?.coveredEntryId).toBe(newest.id)
    expect(calls).toHaveLength(1)
    expect(calls[0].prompt).toContain('set up the project')
    expect(calls[0].prompt).toContain('fixed the last bug')
    expect(calls[0]).not.toHaveProperty('tools')

    const file = JSON.parse(
      await fs.readFile(path.join(dirs.real, session.id, 'session.json'), 'utf8'),
    )
    expect(file.overviewSummary.coveredEntryId).toBe(newest.id)
    expect(file.overviewSummary.coveredEntryId).not.toBe(first.id)
  })

  it('chunks a long history and combines the chunks', async () => {
    const session = await createSession()
    for (let index = 0; index < 12; index++) {
      await addEntry(session.id, {
        prompt: `turn ${index} ${'x'.repeat(900)}`,
        response: `answer ${index} ${'y'.repeat(900)}`,
      })
    }
    reply = async (args) =>
      args.final
        ? { text: 'Combined account of all turns.', pictureMatches: false }
        : { text: `chunk note ${calls.length}`, pictureMatches: false }

    await summary.applyOverviewInclusion(session.id, true, REQUEST)
    await vi.waitFor(async () => {
      expect((await openSession(session.id)).overviewSummary?.state).toBe('ready')
    })

    expect(calls.length).toBeGreaterThan(1)
    expect(calls.filter((call) => call.final)).toHaveLength(1)
    expect(calls.at(-1)?.final).toBe(true)
    expect(calls.at(-1)?.prompt).toContain('chunk note')
    expect((await openSession(session.id)).overviewSummary?.text).toBe(
      'Combined account of all turns.',
    )
  })

  it('chunks by a token budget rather than a character count', () => {
    expect(summary.estimateTokens('x'.repeat(4000))).toBe(1000)
    const sized = (index: number): HistoryEntry => ({
      id: `sized-${index}`,
      timestamp: Date.now(),
      preset: 'Assistant',
      kind: 'chat',
      prompt: `turn ${index} ${'x'.repeat(1200)}`,
      status: 'completed',
      artifacts: [],
      response: 'y'.repeat(1200),
    })

    const small = summary.overviewSummaryPrompts('A Session', [sized(0)], 'en-US')
    expect(small).toHaveLength(1)

    const huge = summary.overviewSummaryPrompts('A Session', [0, 1, 2, 3].map(sized), 'en-US')
    expect(huge.length).toBeGreaterThan(1)
    expect(huge.at(-1)?.prompt).toContain('at most 600 characters')
  })

  it('keeps the summary in its own context: Title and History Entries only', async () => {
    const session = await createSession()
    await mutateSession(session.id, (file) => ({
      ...file,
      title: 'Kitchen renovation',
      timeline: [
        {
          id: 'message-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'HARNESS-MESSAGE-MUST-NOT-APPEAR' }],
        },
      ],
    }))
    await addEntry(session.id, {
      prompt: 'measure the cabinets',
      response: 'The cabinets are 80cm.',
      artifacts: [{ path: 'files/plan.png', mediaType: 'image' }],
    })

    await summary.applyOverviewInclusion(session.id, true, REQUEST)
    await vi.waitFor(async () => {
      expect((await openSession(session.id)).overviewSummary?.state).toBe('ready')
    })

    const prompt = calls[0].prompt
    expect(prompt).toContain('Kitchen renovation')
    expect(prompt).toContain('measure the cabinets')
    expect(prompt).toContain('The cabinets are 80cm.')
    expect(prompt).not.toContain('HARNESS-MESSAGE-MUST-NOT-APPEAR')
    expect(prompt.toLowerCase()).not.toContain('tool_call')
    expect(calls[0]).not.toHaveProperty('tools')
  })

  it('freezes the reply language once and ignores a later UI language', async () => {
    const session = await createSession()
    await addEntry(session.id, { prompt: 'set up the project' })

    await summary.applyOverviewInclusion(session.id, true, REQUEST)
    await vi.waitFor(async () => {
      expect((await openSession(session.id)).overviewSummary?.state).toBe('ready')
    })
    expect((await openSession(session.id)).responseLocale).toBe('de')
    calls = []

    await summary.refreshOverviewSummary(session.id, { model: MODEL, language: 'fr' })
    await vi.waitFor(async () => {
      expect(calls).toHaveLength(1)
      expect((await openSession(session.id)).overviewSummary?.state).toBe('ready')
    })

    expect(calls[0].prompt).toContain('Reply language: de')
    expect((await openSession(session.id)).overviewSummary?.language).toBe('de')
    expect((await openSession(session.id)).responseLocale).toBe('de')
  })

  it('does not move the Session updatedAt', async () => {
    const session = await createSession()
    await addEntry(session.id)
    const before = (await openSession(session.id)).updatedAt
    await new Promise((resolve) => setTimeout(resolve, 5))

    await summary.applyOverviewInclusion(session.id, true, REQUEST)
    await vi.waitFor(async () => {
      expect((await openSession(session.id)).overviewSummary?.state).toBe('ready')
    })

    expect((await openSession(session.id)).updatedAt).toBe(before)
  })

  it('pushes session-changed when the summary settles', async () => {
    const session = await createSession()
    await addEntry(session.id)

    await summary.applyOverviewInclusion(session.id, true, REQUEST)
    await vi.waitFor(async () => {
      const documents = vi.mocked(emitSessionChanged).mock.calls.map(([document]) => document)
      expect(documents.some((document) => document.overviewSummaryState === 'ready')).toBe(true)
    })
  })
})

describe('local-only', () => {
  it('leaves the summary pending and calls no model without a local model', async () => {
    const session = await createSession()
    await addEntry(session.id)

    await summary.applyOverviewInclusion(session.id, true, { language: 'de' })

    expect((await openSession(session.id)).overviewSummaryState).toBe('pending')
    expect(calls).toEqual([])
  })

  it('never sends a cloud model to write a summary', async () => {
    const session = await createSession()
    await addEntry(session.id)

    await summary.applyOverviewInclusion(session.id, true, {
      model: { backend: 'cloud', modelId: 'remote-model' },
      language: 'de',
    })

    expect((await openSession(session.id)).overviewSummaryState).toBe('pending')
    expect(calls).toEqual([])
  })

  it('leaves the summary pending when no local model is selected', async () => {
    const session = await createSession()
    await addEntry(session.id)

    await summary.applyOverviewInclusion(session.id, true, {
      model: {
        backend: 'llamaCPP',
        modelId: 'qwen-test',
        readiness: { serviceName: 'llamacpp-backend', llmModelName: '' },
      },
      language: 'de',
    })

    expect((await openSession(session.id)).overviewSummaryState).toBe('pending')
    expect(calls).toEqual([])
  })
})

describe('opt-out and re-enable', () => {
  it('deletes the text, picture and state, and cancels a running update', async () => {
    const session = await createSession()
    await addEntry(session.id)

    let release: (value: { text: string; pictureMatches: boolean }) => void = () => {}
    reply = () => new Promise((resolve) => (release = resolve))

    await summary.applyOverviewInclusion(session.id, true, REQUEST)
    await vi.waitFor(async () => {
      expect((await openSession(session.id)).overviewSummaryState).toBe('pending')
    })

    await summary.applyOverviewInclusion(session.id, false, { language: 'de' })
    release({ text: 'This must never be stored.', pictureMatches: true })

    await new Promise((resolve) => setTimeout(resolve, 10))
    const document = await openSession(session.id)
    expect(document.includedInOverviews).toBe(false)
    expect(document).not.toHaveProperty('overviewSummary')
    expect(document.overviewSummaryState).toBeUndefined()
  })

  it('rebuilds from the whole history when re-enabled', async () => {
    const session = await createSession()
    await addEntry(session.id, { prompt: 'first turn' })
    await summary.applyOverviewInclusion(session.id, true, REQUEST)
    await vi.waitFor(async () => {
      expect((await openSession(session.id)).overviewSummary?.state).toBe('ready')
    })
    await summary.applyOverviewInclusion(session.id, false, { language: 'de' })
    expect((await openSession(session.id)).overviewSummaryState).toBeUndefined()

    calls = []
    reply = async () => ({ text: 'Rebuilt account.', pictureMatches: false })
    await summary.applyOverviewInclusion(session.id, true, REQUEST)
    await vi.waitFor(async () => {
      expect((await openSession(session.id)).overviewSummary?.text).toBe('Rebuilt account.')
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].prompt).toContain('first turn')
  })
})

describe('the picture', () => {
  async function imageSession(name = 'cat.png') {
    const session = await createSession()
    const artifactPath = await writeImage(session.id, name)
    await addEntry(session.id, {
      kind: 'image',
      preset: 'Image Gen',
      prompt: 'a cat in a hat',
      artifacts: [{ path: artifactPath, mediaType: 'image' }],
    })
    return session.id
  }

  it('stores the newest visual Artifact when the update judges it still matches', async () => {
    const sessionId = await imageSession()
    reply = async () => ({ text: 'A cat picture.', pictureMatches: true })

    await summary.applyOverviewInclusion(sessionId, true, REQUEST)
    await vi.waitFor(async () => {
      expect((await openSession(sessionId)).overviewSummary?.state).toBe('ready')
    })

    const stored = (await openSession(sessionId)).overviewSummary
    expect(stored?.picture).toMatchObject({ path: 'files/cat.png', mediaType: 'image' })
    expect(calls[0].prompt).toContain('a cat in a hat')
  })

  it('stores no picture when the update does not match it', async () => {
    const sessionId = await imageSession()
    reply = async () => ({ text: 'Something else entirely.', pictureMatches: false })

    await summary.applyOverviewInclusion(sessionId, true, REQUEST)
    await vi.waitFor(async () => {
      expect((await openSession(sessionId)).overviewSummary?.state).toBe('ready')
    })

    expect((await openSession(sessionId)).overviewSummary?.picture).toBeUndefined()
  })

  it('stores no older picture when the newest visual Artifact file has gone', async () => {
    const session = await createSession()
    const older = await writeImage(session.id, 'older.png')
    await addEntry(session.id, {
      kind: 'image',
      preset: 'Image Gen',
      prompt: 'an older picture',
      artifacts: [{ path: older, mediaType: 'image' }],
    })
    await addEntry(session.id, {
      kind: 'image',
      preset: 'Image Gen',
      prompt: 'the newest picture',
      artifacts: [{ path: 'files/gone.png', mediaType: 'image' }],
    })
    reply = async () => ({ text: 'A picture.', pictureMatches: true })

    await summary.applyOverviewInclusion(session.id, true, REQUEST)
    await vi.waitFor(async () => {
      expect((await openSession(session.id)).overviewSummary?.state).toBe('ready')
    })

    expect((await openSession(session.id)).overviewSummary?.picture).toBeUndefined()
  })

  it('uses a video poster and a game icon, and no picture for audio or 3D', async () => {
    const video = await createSession()
    const workspace = await ensureWorkspaceEntry(video.id)
    const posterRel = 'clip-thumb.png'
    await fs.mkdir(workspace.hostPath, { recursive: true })
    await fs.writeFile(path.join(workspace.hostPath, 'clip.mp4'), 'mp4')
    await fs.writeFile(path.join(workspace.hostPath, posterRel), 'png')
    await addEntry(video.id, {
      kind: 'video',
      preset: 'Video',
      prompt: 'a wave breaking',
      artifacts: [{ folderId: workspace.id, path: 'clip.mp4', mediaType: 'video' }],
    })
    await mutateSession(video.id, (file) => ({
      ...file,
      timeline: [
        {
          id: 'msg-1',
          role: 'assistant',
          parts: [
            {
              type: 'data-media',
              data: {
                runId: 'run-1',
                mode: 'video',
                preset: 'Video',
                status: 'completed',
                items: [
                  {
                    id: 'item-1',
                    state: 'done',
                    mode: 'video',
                    settings: {},
                    type: 'video',
                    videoUrl: sessionFolderMediaUrl(video.id, workspace.id, 'clip.mp4'),
                    thumbnailUrl: sessionFolderMediaUrl(video.id, workspace.id, posterRel),
                  },
                ],
              },
            },
          ],
        },
      ],
    }))

    const game = await createSession()
    const created = createGame({ name: 'Space Dodger' }, dirs.games)
    await fs.writeFile(path.join(created.dir, 'icon.png'), 'png')
    updateGame(created.dir, { icon: 'icon.png' })
    await addEntry(game.id, { kind: 'agent', preset: 'Game Agent', prompt: 'make a game' })
    await mutateSession(game.id, (file) => ({
      ...file,
      harnessWorkspaces: { 'Game Agent': created.dir },
    }))

    const audio = await createSession()
    await addEntry(audio.id, {
      kind: 'tts',
      preset: 'Text to Speech',
      artifacts: [{ path: 'files/speech.wav', mediaType: 'audio' }],
    })

    const model3d = await createSession()
    await addEntry(model3d.id, {
      kind: 'edit',
      preset: 'Image To 3D Model',
      artifacts: [{ path: 'files/model.glb', mediaType: 'model3d' }],
    })

    reply = async () => ({ text: 'A Session account.', pictureMatches: true })
    for (const session of [video, game, audio, model3d]) {
      await summary.applyOverviewInclusion(session.id, true, REQUEST)
    }
    await vi.waitFor(async () => {
      for (const session of [video, game, audio, model3d]) {
        expect((await openSession(session.id)).overviewSummary?.state).toBe('ready')
      }
    })

    expect((await openSession(video.id)).overviewSummary?.picture).toMatchObject({
      folderId: workspace.id,
      path: posterRel,
      mediaType: 'image',
    })
    expect((await openSession(game.id)).overviewSummary?.picture?.path).toBe(
      path.join(created.dir, 'icon.png'),
    )
    expect((await openSession(audio.id)).overviewSummary?.picture).toBeUndefined()
    expect((await openSession(model3d.id)).overviewSummary?.picture).toBeUndefined()
  })
})

describe('failure', () => {
  it('records failed and keeps the Session included', async () => {
    const session = await createSession()
    await addEntry(session.id)
    reply = async () => {
      throw new Error('the model went away')
    }

    await summary.applyOverviewInclusion(session.id, true, REQUEST)
    await vi.waitFor(async () => {
      expect((await openSession(session.id)).overviewSummaryState).toBe('failed')
    })

    const document = await openSession(session.id)
    expect(document.includedInOverviews).toBe(true)
    expect(document.overviewSummary).toMatchObject({
      state: 'failed',
      failureReason: expect.stringContaining('the model went away'),
    })
    expect(vi.mocked(emitFailure)).toHaveBeenCalled()
  })
})

describe('the model reply', () => {
  it('keeps the summary and reads the picture judgement', () => {
    expect(
      summary.parseOverviewSummaryReply('MATCH: yes\nSUMMARY:\nA cat in a hat.', true),
    ).toEqual({ text: 'A cat in a hat.', pictureMatches: true })
    expect(
      summary.parseOverviewSummaryReply('MATCH: no\nSUMMARY:\nA different account.', true),
    ).toEqual({ text: 'A different account.', pictureMatches: false })
  })

  it('treats an intermediate chunk as plain text with no picture', () => {
    expect(summary.parseOverviewSummaryReply('MATCH: yes\nPart one', false)).toEqual({
      text: 'MATCH: yes\nPart one',
      pictureMatches: false,
    })
  })
})
