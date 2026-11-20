import { appLoggerInstance } from '../observability/logger'
import { emitSessionChanged } from '../kernel/kernelBus'
import { appendHistoryEntry, readHistoryEntries, removeHistoryEntry } from './sessionHistory'
import path from 'node:path'
import { adoptMediaFile } from './sessionMediaTurn'
import { copyIntoWorkspace } from './sessionWorkspace'
import { takeSessionUpdate } from './sessionUpdate'
import { mutateSession, readSession, sessionDocumentOf } from './sessions'
import { afterTurn } from './sessionTitle'
import {
  asChatTranscriptMessage as asChatMessage,
  chatTranscriptOf,
  type ChatTranscriptMessage,
} from '@/lib/sessionChat'
import type {
  ArtifactMediaType,
  HistoryArtifact,
  HistoryEntry,
  SessionDocument,
} from '@/types/sessionIpc'

const LOG_SCOPE = 'sessions'

/** The Session's shared chat transcript reads Session Updates under this cursor. */
export const CHAT_UPDATE_CONSUMER = {
  key: 'chat',
  isOwn: (entry: HistoryEntry) => entry.kind === 'chat',
}

export type { ChatTranscriptMessage }

function tagged(
  message: ChatTranscriptMessage,
  stored: ChatTranscriptMessage | undefined,
): ChatTranscriptMessage {
  const update = message.metadata?.sessionUpdate ?? stored?.metadata?.sessionUpdate
  return {
    ...message,
    metadata: { ...message.metadata, chatTurn: true, ...(update ? { sessionUpdate: update } : {}) },
  }
}

/**
 * Makes `messages` the timeline's chat transcript: chat messages it no longer
 * holds drop out, the rest are replaced where they stand, and a new reply lands
 * right after the prompt it answers (a regenerate), anything else at the end.
 */
export function mergeChatTranscript(
  timeline: readonly unknown[],
  messages: ChatTranscriptMessage[],
): unknown[] {
  const stored = new Map(chatTranscriptOf(timeline).map((message) => [message.id, message]))
  const incoming = new Map(
    messages.map((message) => [message.id, tagged(message, stored.get(message.id))]),
  )
  const next: unknown[] = []
  for (const value of timeline) {
    const message = asChatMessage(value)
    if (!message) next.push(value)
    else if (incoming.has(message.id)) next.push(incoming.get(message.id))
  }
  messages.forEach((message, index) => {
    if (stored.has(message.id)) return
    const previous = messages[index - 1]
    const at =
      previous?.role === 'user'
        ? next.findIndex((value) => (value as { id?: string } | null)?.id === previous.id)
        : -1
    if (at >= 0) next.splice(at + 1, 0, incoming.get(message.id))
    else next.push(incoming.get(message.id))
  })
  return next
}

/** Saves the Session's chat transcript, titling the Session from a settled turn's prompt. */
export async function saveChatTranscript(
  sessionId: string,
  messages: ChatTranscriptMessage[],
  settled?: { preset: string; prompt: string },
): Promise<SessionDocument> {
  const file = await mutateSession(sessionId, (current) => ({
    ...current,
    timeline: mergeChatTranscript(current.timeline, messages),
    ...(settled
      ? {
          ...afterTurn(current, { kind: 'chat', ...settled }),
          updatedAt: Math.max(Date.now(), current.updatedAt),
        }
      : {}),
  }))
  const document = sessionDocumentOf(file)
  emitSessionChanged(document)
  return document
}

/**
 * Brings the turn's messages up to the stored transcript's Session Updates and,
 * for a new prompt, attaches the update for what the chat missed. The renderer's
 * live copy never carries them, so they are read back here every turn.
 */
export async function beginChatTurnInSession(
  sessionId: string,
  messages: ChatTranscriptMessage[],
  trigger: 'submit-message' | 'regenerate-message',
): Promise<ChatTranscriptMessage[]> {
  try {
    const stored = new Map(
      chatTranscriptOf((await readSession(sessionId)).timeline).map((m) => [m.id, m]),
    )
    const merged = messages.map((message) => tagged(message, stored.get(message.id)))
    const last = merged.at(-1)
    if (trigger !== 'submit-message' || last?.role !== 'user' || last.metadata?.sessionUpdate) {
      return merged
    }
    const update = await takeSessionUpdate(sessionId, CHAT_UPDATE_CONSUMER)
    if (!update) return merged
    return [
      ...merged.slice(0, -1),
      { ...last, metadata: { ...last.metadata, sessionUpdate: update } },
    ]
  } catch (error) {
    appLoggerInstance.warn(`chat turn has no Session Update: ${error}`, LOG_SCOPE)
    return messages
  }
}

/** The model's view of a user message: its stored Session Update ahead of the prompt. */
export function withSessionUpdatesInPrompt<T extends ChatTranscriptMessage>(messages: T[]): T[] {
  return messages.map((message) => {
    const update = message.role === 'user' ? message.metadata?.sessionUpdate : undefined
    if (!update) return message
    const parts = [...(message.parts ?? [])] as Array<{ type?: string; text?: string }>
    const index = parts.findIndex((part) => part.type === 'text')
    if (index < 0) parts.unshift({ type: 'text', text: update })
    else parts[index] = { ...parts[index], text: `${update}\n\n${parts[index].text ?? ''}` }
    return { ...message, parts }
  })
}

export function textOfMessage(message: ChatTranscriptMessage | undefined): string {
  return ((message?.parts ?? []) as Array<{ type?: string; text?: string }>)
    .flatMap((part) => (part.type === 'text' && part.text ? [part.text] : []))
    .join('\n\n')
}

const URL_KEYS: Array<{
  key: 'imageUrl' | 'videoUrl' | 'model3dUrl'
  mediaType: ArtifactMediaType
}> = [
  { key: 'imageUrl', mediaType: 'image' },
  { key: 'videoUrl', mediaType: 'video' },
  { key: 'model3dUrl', mediaType: 'model3d' },
]

/**
 * Follows one chat turn of a Session: media its tools generated moves into
 * `files/` (the tool output then names it there), and settling appends the
 * turn's History Entry, replacing the attempt a regenerate redoes.
 */
export function trackChatTurnInSession(
  sessionId: string,
  localPathOf: (url: string) => string | null,
  trigger: 'submit-message' | 'regenerate-message' = 'submit-message',
) {
  const artifacts: HistoryArtifact[] = []

  // The clip stays in the audio folder too: the model was told that path.
  async function adoptSpeechClip(output: { savedFilePath: string }): Promise<unknown> {
    try {
      const copied = await copyIntoWorkspace(sessionId, output.savedFilePath)
      if (!copied) return output
      artifacts.push({ ...copied.artifact, mediaType: 'audio' })
      return { ...output, audioUrl: copied.url }
    } catch (error) {
      appLoggerInstance.warn(`speech clip not copied into its Session: ${error}`, LOG_SCOPE)
      return output
    }
  }

  async function adoptToolMedia(output: unknown): Promise<unknown> {
    const savedFilePath = (output as { savedFilePath?: unknown } | null)?.savedFilePath
    if (typeof savedFilePath === 'string' && path.isAbsolute(savedFilePath)) {
      return adoptSpeechClip({ ...(output as object), savedFilePath })
    }
    const images = (output as { images?: unknown } | null)?.images
    if (!Array.isArray(images)) return output
    const adopted = []
    for (const image of images as Array<Record<string, unknown>>) {
      const next = { ...image }
      for (const { key, mediaType } of URL_KEYS) {
        const url = image[key]
        if (typeof url !== 'string') continue
        const moved = await adoptMediaFile(sessionId, url, localPathOf)
        if (!moved) continue
        next[key] = moved.url
        artifacts.push({ ...moved.artifact, mediaType })
      }
      adopted.push(next)
    }
    return { ...(output as object), images: adopted }
  }

  /** Only the newest chat entry goes, and only when it holds the prompt the regenerate re-sends. */
  async function forgetReplacedAttempt(prompt: string): Promise<void> {
    const last = (await readHistoryEntries(sessionId))
      .filter((entry) => entry.kind === 'chat')
      .at(-1)
    if (!last || last.prompt !== prompt) return
    await removeHistoryEntry(sessionId, last.id)
  }

  async function settle(turn: {
    preset: string
    variant?: string
    prompt: string
    status: HistoryEntry['status']
    response?: string
  }): Promise<void> {
    try {
      if (trigger === 'regenerate-message') await forgetReplacedAttempt(turn.prompt)
      await appendHistoryEntry(sessionId, {
        preset: turn.preset,
        variant: turn.variant,
        kind: 'chat',
        prompt: turn.prompt,
        status: turn.status,
        artifacts,
        ...(turn.response ? { response: turn.response } : {}),
      })
    } catch (error) {
      appLoggerInstance.warn(`chat turn not recorded in its Session: ${error}`, LOG_SCOPE)
    }
  }

  return { adoptToolMedia, settle }
}
