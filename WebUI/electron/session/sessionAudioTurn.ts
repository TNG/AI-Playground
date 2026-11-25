import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { writeIntoWorkspace, type WorkspaceFile } from './sessionWorkspace'
import { settleTurn } from './sessionSettlement'
import { appendTurnToTimeline } from './sessionMediaTurn'
import type { AudioTurnRequest, SessionDocument } from '@/types/sessionIpc'
import type { TimelineMessage } from '@/types/sessionTimeline'

function safeAudioName(fileName: string): string {
  const base = path.basename(fileName.replace(/\\/g, '/'))
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '')
  const named = cleaned || `audio-${Date.now()}`
  return path.extname(named) ? named : `${named}.wav`
}

function saveIntoFiles(
  sessionId: string,
  audio: NonNullable<AudioTurnRequest['audio']>,
): Promise<WorkspaceFile> {
  return writeIntoWorkspace(
    sessionId,
    safeAudioName(audio.fileName),
    Buffer.from(audio.base64, 'base64'),
  )
}

/**
 * Settles one Text-to-Speech or Speech-to-Text turn into its Session: the audio
 * (TTS output, STT source) is written into its Workspace, one History Entry is
 * appended, and the prompt plus an audio result join the display timeline.
 */
export async function recordAudioTurn(turn: AudioTurnRequest): Promise<SessionDocument> {
  const saved = turn.audio ? await saveIntoFiles(turn.sessionId, turn.audio) : undefined

  const written = await settleTurn(
    turn.sessionId,
    {
      preset: turn.preset,
      kind: turn.kind,
      prompt: turn.prompt,
      status: turn.status,
      response: turn.transcript,
      artifacts: saved ? [{ ...saved.artifact, mediaType: 'audio' }] : [],
    },
    { summariser: turn.summariser },
  )

  const now = Date.now()
  const metadata = written ? { metadata: { historyEntryId: written.id } } : {}
  const messages: TimelineMessage[] = [
    {
      id: `msg-${randomUUID()}`,
      role: 'user',
      createdAt: now,
      parts: [{ type: 'text', text: turn.prompt }],
      ...metadata,
    },
    {
      id: `msg-${randomUUID()}`,
      role: 'assistant',
      createdAt: now,
      ...metadata,
      parts: [
        {
          type: 'data-audio',
          data: {
            kind: turn.kind,
            preset: turn.preset,
            status: turn.status,
            error: turn.error,
            audioUrl: saved?.url,
            transcript: turn.transcript,
            engine: turn.engine,
          },
        },
      ],
    },
  ]
  return appendTurnToTimeline(turn.sessionId, {
    title: { kind: turn.kind, preset: turn.preset, prompt: turn.prompt, response: turn.transcript },
    messages,
    at: now,
  })
}
