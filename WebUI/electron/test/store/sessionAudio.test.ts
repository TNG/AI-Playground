import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The audio turn driver against the real Session module in a temp dir; only the
// speech engines are faked.

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))
const speech = vi.hoisted(() => ({
  synthesizeClip: vi.fn(),
  transcribe: vi.fn(),
  readyTranscriptionForInput: vi.fn(),
}))
const activePreset = vi.hoisted(() => ({ name: 'Text to Speech' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getLegacySessionsDir: () => dirs.real,
  getAppWorkspacesDir: () => `${dirs.real}-workspaces`,
  getSessionsDemoDir: () => dirs.demo,
  getLegacySessionsDemoDir: () => dirs.demo,
  getAppWorkspacesDemoDir: () => `${dirs.demo}-workspaces`,
}))

vi.mock('../../adapters/trash', () => ({
  moveToTrash: (target: string) => fs.rm(target, { recursive: true }),
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/assets/js/toast', () => ({
  show: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/assets/js/speech/speechIO', () => speech)

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ langName: 'en-US', state: {} }),
}))

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    get activePresetName() {
      return activePreset.name
    },
  }),
}))

const sessionModule = await import('../../session/sessions')
const { sessionWorkspaceDir } = await import('../../session/sessionWorkspace')
const { settleWorkspaceRenames } = await import('../../session/appWorkspace')
const kernelBus = await import('../../kernel/kernelBus')
const { recordAudioTurn } = await import('../../session/sessionAudioTurn')
const { readHistoryEntries } = await import('../../session/sessionHistory')
const { removeTimelineMessages } = await import('../../session/sessionTimeline')
const { deleteArtifact } = await import('../../session/sessionArtifacts')
const { sessionWorkspaceEntry } = await import('../../session/sessionFolders')
const ledger = await import('../../session/sessionTurns')
const { sessionFolderMediaFile } = await import('../../session/sessionFolderMedia')
const { useSessions } = await import('@/assets/js/store/sessions')
const { useSessionAudio } = await import('@/assets/js/store/sessionAudio')

const WAV_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3])

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-audio-store-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  sessionModule.setSessionDeps({ isDemoMode: () => false })
  kernelBus.resetKernelBusForTest()
  ledger.resetSessionTurnsForTest()
  speech.synthesizeClip.mockReset()
  speech.transcribe.mockReset()
  speech.readyTranscriptionForInput.mockReset().mockResolvedValue({ ready: true })
  activePreset.name = 'Text to Speech'
  vi.stubGlobal('window', {
    electronAPI: {
      onKernelEvent: kernelBus.onKernelEvent,
      getKernelSnapshot: async () => kernelBus.getKernelSnapshot(),
      sessions: {
        list: async () => ({
          success: true,
          sessions: await sessionModule.listSessions(),
          groups: await sessionModule.listSessionGroups(),
          showMore: await sessionModule.readShowMore(),
        }),
        create: async () => ({ success: true, session: await sessionModule.createSession() }),
        open: async (id: string) => ({
          success: true,
          session: await sessionModule.openSession(id),
        }),
        recordAudioTurn: async (turn: Parameters<typeof recordAudioTurn>[0]) => ({
          success: true,
          session: await recordAudioTurn(structuredClone(turn)),
        }),
        beginTurn: async (id: string, turn: Parameters<typeof ledger.claimSessionTurn>[1]) =>
          ledger.claimSessionTurn(id, turn)
            ? { success: true }
            : { success: false, error: ledger.SESSION_BUSY_MESSAGE },
        endTurn: async (id: string, turnId: string) => {
          ledger.releaseSessionTurn(id, turnId)
          return { success: true }
        },
        removeTimelineMessages: async (id: string, messageIds: string[]) => {
          await removeTimelineMessages(id, messageIds)
          return { success: true }
        },
        deleteArtifact: async (id: string, relativePath: string) => {
          await deleteArtifact(id, relativePath)
          return { success: true }
        },
      },
      readAipgMediaAsBase64: async (url: string) => {
        const file = sessionFolderMediaFile(url)
        if (!file) return { success: false as const, error: `not a session url: ${url}` }
        try {
          const data = await fs.readFile(file)
          return { success: true as const, data: data.toString('base64') }
        } catch (error) {
          return { success: false as const, error: String(error) }
        }
      },
    },
  })
  setActivePinia(createPinia())
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await settleWorkspaceRenames()
  sessionModule.resetSessionsForTest()
  await fs.rm(path.dirname(dirs.real), { recursive: true, force: true })
})

async function openSession() {
  const sessions = useSessions()
  await sessions.init()
  return { sessions, id: sessions.openSessionId! }
}

describe('Text-to-Speech in a Session', () => {
  it('saves the clip into the open Session and shows the turn', async () => {
    const { sessions, id } = await openSession()
    speech.synthesizeClip.mockResolvedValue({
      audioBase64: Buffer.from(WAV_BYTES).toString('base64'),
      mediaType: 'audio/wav',
      voice: 'af_heart',
      engine: 'kokoro',
    })

    await useSessionAudio().synthesize('Read this aloud')

    const [entry] = await readHistoryEntries(id)
    expect(entry).toEqual(
      expect.objectContaining({ kind: 'tts', prompt: 'Read this aloud', status: 'completed' }),
    )
    await settleWorkspaceRenames()
    const saved = path.join(sessionWorkspaceDir(id), entry.artifacts[0].path)
    expect(new Uint8Array(await fs.readFile(saved))).toEqual(WAV_BYTES)
    expect(sessions.openTimeline).toHaveLength(2)
    expect(sessions.openSession?.title).toBe('Read this aloud')
  })

  it('records a failed synthesis as a failed turn', async () => {
    const { id } = await openSession()
    speech.synthesizeClip.mockRejectedValue(new Error('UR_RESULT_ERROR_DEVICE_LOST'))

    await useSessionAudio().synthesize('Read this aloud')

    expect(await readHistoryEntries(id)).toEqual([
      expect.objectContaining({ kind: 'tts', status: 'failed', artifacts: [] }),
    ])
  })

  it('is busy for the open Session while synthesizing', async () => {
    await openSession()
    let finish: (value: unknown) => void = () => {}
    speech.synthesizeClip.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const audio = useSessionAudio()

    const running = audio.synthesize('Read this aloud')
    await vi.waitFor(() => expect(audio.processing).toBe(true))
    expect(audio.pendingTurn?.prompt).toBe('Read this aloud')
    finish({ audioBase64: 'AAAA', mediaType: 'audio/wav', voice: 'v', engine: 'qwen3' })
    await running

    expect(audio.processing).toBe(false)
  })

  it('Stop abandons a running synthesis and records the Turn as Cancelled', async () => {
    const { sessions, id } = await openSession()
    speech.synthesizeClip.mockReturnValue(new Promise(() => {}))
    const audio = useSessionAudio()

    const running = audio.synthesize('Read this aloud')
    await vi.waitFor(() => expect(sessions.openTurn?.kind).toBe('audio'))
    const turnId = sessions.openTurn!.turnId
    sessions.markTurnStopping(turnId)
    expect(audio.cancel(id)).toBe(true)

    await running
    await vi.waitFor(() => expect(sessions.openTurn).toBeNull())

    expect(sessions.isTurnStopping(turnId)).toBe(false)
    expect(await readHistoryEntries(id)).toEqual([
      expect.objectContaining({ kind: 'tts', status: 'cancelled', artifacts: [] }),
    ])
  })

  it('holds the open Session as its one turn, and refuses to start while another holds it', async () => {
    const { sessions, id } = await openSession()
    let finish: (value: unknown) => void = () => {}
    speech.synthesizeClip.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const audio = useSessionAudio()

    const running = audio.synthesize('Read this aloud')
    await vi.waitFor(() => expect(sessions.openTurn?.kind).toBe('audio'))
    finish({ audioBase64: 'AAAA', mediaType: 'audio/wav', voice: 'v', engine: 'qwen3' })
    await running
    await vi.waitFor(() => expect(sessions.openTurn).toBeNull())

    ledger.claimSessionTurn(id, { turnId: 'agent-turn', kind: 'agent' })
    await audio.synthesize('Not now')
    expect(speech.synthesizeClip).toHaveBeenCalledTimes(1)
    expect((await readHistoryEntries(id)).map((entry) => entry.prompt)).toEqual(['Read this aloud'])
  })
})

describe('Speech-to-Text in a Session', () => {
  it('records the transcript and keeps the source audio in files/', async () => {
    activePreset.name = 'Speech to Text'
    const { sessions, id } = await openSession()
    speech.transcribe.mockResolvedValue({ text: 'Hello from the microphone' })

    await useSessionAudio().transcribeAudio(new Blob([WAV_BYTES], { type: 'audio/wav' }), {
      label: '🎤 Recording',
    })

    const [entry] = await readHistoryEntries(id)
    expect(entry).toEqual(
      expect.objectContaining({
        preset: 'Speech to Text',
        kind: 'stt',
        prompt: '🎤 Recording',
        response: 'Hello from the microphone',
        status: 'completed',
        artifacts: [expect.objectContaining({ mediaType: 'audio' })],
      }),
    )
    await settleWorkspaceRenames()
    const saved = path.join(sessionWorkspaceDir(id), entry.artifacts[0].path)
    expect(new Uint8Array(await fs.readFile(saved))).toEqual(WAV_BYTES)
    expect(sessions.openSession?.title).toBe('Hello from the microphone')
  })

  it('names an uploaded clip after its file', async () => {
    activePreset.name = 'Speech to Text'
    const { id } = await openSession()
    speech.transcribe.mockResolvedValue({ text: 'minutes' })

    await useSessionAudio().transcribeAudio(new Blob([WAV_BYTES]), {
      label: '🎤 standup.wav',
      fileName: 'standup.wav',
    })

    const [entry] = await readHistoryEntries(id)
    const { id: folderId } = await sessionWorkspaceEntry(id)
    expect(entry.artifacts).toEqual([{ folderId, path: 'standup.wav', mediaType: 'audio' }])
  })

  it('settles silence as a failed turn that still keeps the source audio', async () => {
    activePreset.name = 'Speech to Text'
    const { id } = await openSession()
    speech.transcribe.mockResolvedValue({ text: '   ' })

    await useSessionAudio().transcribeAudio(new Blob([WAV_BYTES]), { label: '🎤 Recording' })

    const [entry] = await readHistoryEntries(id)
    expect(entry).toEqual(expect.objectContaining({ kind: 'stt', status: 'failed' }))
    expect(entry.response).toBeUndefined()
    expect(entry.artifacts).toHaveLength(1)
  })
})

describe('Regenerate of a speech turn', () => {
  const audioDataOf = (timeline: unknown[]) => {
    const answer = timeline.find(
      (message) => (message as { role?: string }).role === 'assistant',
    ) as { parts: { type: string; data?: { audioUrl?: string; transcript?: string } }[] }
    return answer.parts.find((part) => part.type === 'data-audio')!.data!
  }
  const idsOf = (timeline: unknown[]) => timeline.map((message) => (message as { id: string }).id)
  const fileOf = (url: string) => sessionFolderMediaFile(url)!

  it('re-synthesizes the latest Text-to-Speech turn and replaces it', async () => {
    const { sessions, id } = await openSession()
    speech.synthesizeClip
      .mockResolvedValueOnce({
        audioBase64: 'AAAA',
        mediaType: 'audio/wav',
        voice: 'v',
        engine: 'qwen3',
      })
      .mockResolvedValueOnce({
        audioBase64: Buffer.from(WAV_BYTES).toString('base64'),
        mediaType: 'audio/wav',
        voice: 'v',
        engine: 'kokoro',
      })
    const audio = useSessionAudio()
    await audio.synthesize('Read this aloud')
    const replacedIds = idsOf(sessions.openTimeline)
    const replacedUrl = audioDataOf(sessions.openTimeline).audioUrl!

    // The user may have left the Audio preset; the redo records under the turn's own.
    activePreset.name = 'Assistant'
    await settleWorkspaceRenames()
    await expect(fs.access(fileOf(replacedUrl))).resolves.toBeUndefined()
    await audio.regenerate({
      kind: 'tts',
      preset: 'Text to Speech',
      prompt: 'Read this aloud',
      audioUrl: replacedUrl,
      messageIds: replacedIds,
    })

    expect(idsOf(sessions.openTimeline)).not.toEqual(replacedIds)
    expect(sessions.openTimeline).toHaveLength(2)
    const entries = await readHistoryEntries(id)
    expect(entries.findLast((entry) => entry.kind === 'tts')).toEqual(
      expect.objectContaining({
        preset: 'Text to Speech',
        prompt: 'Read this aloud',
        status: 'completed',
      }),
    )
    // The replaced clip's file left with its turn; the new one stayed.
    await settleWorkspaceRenames()
    await expect(fs.access(fileOf(replacedUrl))).rejects.toThrow()
    const freshUrl = audioDataOf(sessions.openTimeline).audioUrl!
    await expect(fs.access(fileOf(freshUrl))).resolves.toBeUndefined()
  })

  it('re-synthesizes the latest Text-to-Speech turn from an edited prompt', async () => {
    const { sessions, id } = await openSession()
    speech.synthesizeClip
      .mockResolvedValueOnce({
        audioBase64: 'AAAA',
        mediaType: 'audio/wav',
        voice: 'v',
        engine: 'qwen3',
      })
      .mockResolvedValueOnce({
        audioBase64: Buffer.from(WAV_BYTES).toString('base64'),
        mediaType: 'audio/wav',
        voice: 'v',
        engine: 'kokoro',
      })
    const audio = useSessionAudio()
    await audio.synthesize('Read this aloud')
    const replacedIds = idsOf(sessions.openTimeline)

    // The prompt bubble's editor re-runs the turn on the text it was given.
    await audio.regenerate({
      kind: 'tts',
      preset: 'Text to Speech',
      prompt: 'Read this louder',
      messageIds: replacedIds,
    })

    expect(sessions.openTimeline).toHaveLength(2)
    expect(
      (sessions.openTimeline[0] as { parts: { type: string; text?: string }[] }).parts.find(
        (part) => part.type === 'text',
      )!.text,
    ).toBe('Read this louder')
    const entries = await readHistoryEntries(id)
    expect(entries.findLast((entry) => entry.kind === 'tts')).toEqual(
      expect.objectContaining({
        preset: 'Text to Speech',
        prompt: 'Read this louder',
        status: 'completed',
      }),
    )
  })

  it('re-transcribes the latest Speech-to-Text turn from its kept source clip', async () => {
    activePreset.name = 'Speech to Text'
    const { sessions, id } = await openSession()
    speech.transcribe
      .mockResolvedValueOnce({ text: 'first pass' })
      .mockResolvedValueOnce({ text: 'second pass' })
    const audio = useSessionAudio()
    await audio.transcribeAudio(new Blob([WAV_BYTES], { type: 'audio/wav' }), {
      label: 'standup.wav',
      fileName: 'standup.wav',
    })
    const replacedIds = idsOf(sessions.openTimeline)
    const replacedUrl = audioDataOf(sessions.openTimeline).audioUrl!

    await settleWorkspaceRenames()
    await audio.regenerate({
      kind: 'stt',
      preset: 'Speech to Text',
      prompt: 'standup.wav',
      audioUrl: replacedUrl,
      messageIds: replacedIds,
    })

    expect(idsOf(sessions.openTimeline)).not.toEqual(replacedIds)
    expect(sessions.openTimeline).toHaveLength(2)
    expect(audioDataOf(sessions.openTimeline).transcript).toBe('second pass')
    const entries = await readHistoryEntries(id)
    expect(entries.findLast((entry) => entry.kind === 'stt')!.response).toBe('second pass')
    // The source clip was saved again for the new turn; the replaced copy left with it.
    await settleWorkspaceRenames()
    expect(await fs.readdir((await sessionWorkspaceEntry(id)).hostPath)).toEqual(['standup-1.wav'])
  })

  it('leaves the old turn when the redo could not even start (busy Session)', async () => {
    const { sessions, id } = await openSession()
    speech.synthesizeClip.mockResolvedValue({
      audioBase64: 'AAAA',
      mediaType: 'audio/wav',
      voice: 'v',
      engine: 'qwen3',
    })
    const audio = useSessionAudio()
    await audio.synthesize('Read this aloud')
    const before = [...sessions.openTimeline]
    const replacedIds = idsOf(before)

    ledger.claimSessionTurn(id, { turnId: 'agent-turn', kind: 'agent' })
    await audio.regenerate({
      kind: 'tts',
      preset: 'Text to Speech',
      prompt: 'Read this aloud',
      messageIds: replacedIds,
    })

    expect(sessions.openTimeline).toEqual(before)
    expect(speech.synthesizeClip).toHaveBeenCalledTimes(1)
    const entries = await readHistoryEntries(id)
    expect(entries).toHaveLength(1)
  })
})

describe('Delete of a speech turn', () => {
  const idsOf = (timeline: unknown[]) => timeline.map((message) => (message as { id: string }).id)
  const clipUrlOf = (timeline: unknown[]) => {
    const answer = timeline.find(
      (message) => (message as { role?: string }).role === 'assistant',
    ) as {
      parts: { type: string; data?: { audioUrl?: string } }[]
    }
    return answer.parts.find((part) => part.type === 'data-audio')!.data!.audioUrl!
  }

  it('takes the latest Text-to-Speech turn and its clip out of the Session', async () => {
    const { sessions } = await openSession()
    speech.synthesizeClip.mockResolvedValue({
      audioBase64: Buffer.from(WAV_BYTES).toString('base64'),
      mediaType: 'audio/wav',
      voice: 'v',
      engine: 'kokoro',
    })
    const audio = useSessionAudio()
    await audio.synthesize('Read this aloud')
    const deletedIds = idsOf(sessions.openTimeline)
    const deletedUrl = clipUrlOf(sessions.openTimeline)

    await settleWorkspaceRenames()
    await expect(fs.access(sessionFolderMediaFile(deletedUrl)!)).resolves.toBeUndefined()
    await audio.deleteTurn({ owner: 'audio', messageIds: deletedIds, fileUrls: [deletedUrl] })

    expect(sessions.openTimeline).toHaveLength(0)
    // The clip's file left with its turn.
    await expect(fs.access(sessionFolderMediaFile(deletedUrl)!)).rejects.toThrow()
  })

  it('takes a failed turn out, which has no clip to delete', async () => {
    const { sessions } = await openSession()
    speech.synthesizeClip.mockRejectedValue(new Error('UR_RESULT_ERROR_DEVICE_LOST'))
    const audio = useSessionAudio()
    await audio.synthesize('Read this aloud')
    expect(sessions.openTimeline).toHaveLength(2)

    await audio.deleteTurn({
      owner: 'audio',
      messageIds: idsOf(sessions.openTimeline),
      fileUrls: [],
    })

    expect(sessions.openTimeline).toHaveLength(0)
  })
})
