// Local web ChannelAdapter — delivers replies to browsers on the LAN via SSE.
//
// Structurally identical to the Telegram / Slack adapters: every method funnels
// through `window.electronAPI.homeAgent.channel.send('local-web', …)`, i.e. the
// same generic IPC → Flask `/channel/local-web/send/<action>` path the other
// channels use. The Python `LocalWebChannel` turns each send into one SSE event.

import type { ChannelAdapter, DraftStream, RawPart } from './adapter'
import { successRef } from './adapter'
import { renderGenericToolMarker, stripAipgMediaReferences } from './adapterHelpers'

/** SSE can handle frequent updates (Telegram throttles more for Bot API limits). */
const LOCAL_WEB_DRAFT_THROTTLE_MS = 200

function send(
  action:
    | 'reply'
    | 'update'
    | 'photo'
    | 'video'
    | 'voice'
    | 'document'
    | 'typing'
    | 'keyboard'
    | 'editMessage',
  payload: Record<string, unknown>,
) {
  return window.electronAPI.homeAgent.channel.send('local-web', action, payload)
}

function renderParts(parts: RawPart[], tense: 'using' | 'used'): string {
  const lines: string[] = []
  for (const part of parts) {
    if (part.type === 'reasoning') {
      const txt = (part.text ?? '').trim()
      if (txt) lines.push(txt)
    } else if (part.type === 'text') {
      const cleaned = stripAipgMediaReferences(part.text ?? '').trim()
      if (cleaned) lines.push(cleaned)
    } else {
      const marker = renderGenericToolMarker(part, tense)
      if (marker) lines.push(marker)
    }
  }
  return lines.join('\n\n')
}

function createLocalWebDraftStream(): DraftStream {
  let last = ''
  let pending = ''
  let throttleId: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    throttleId = null
    if (pending) void send('update', { text: pending })
  }

  return {
    update: (text: string) => {
      last = text
      pending = text
      if (!throttleId) throttleId = setTimeout(flush, LOCAL_WEB_DRAFT_THROTTLE_MS)
    },
    finalize: async (finalText: string) => {
      if (throttleId) {
        clearTimeout(throttleId)
        throttleId = null
      }
      const text = finalText || last
      if (text) await send('reply', { text })
    },
    cancel: () => {
      if (throttleId) {
        clearTimeout(throttleId)
        throttleId = null
      }
      pending = ''
    },
  }
}

export function createLocalWebAdapter(): ChannelAdapter {
  return {
    kind: 'local-web',
    reply: async (text, _meta) => {
      await send('reply', { text })
      return successRef()
    },
    photo: async (imageBase64, caption, _meta) => {
      await send('photo', { base64: imageBase64, caption })
      return successRef()
    },
    video: async (videoBase64, caption, filename, _meta) => {
      await send('reply', { text: `[Video: ${filename}]\n${caption}` })
      void send('document', { base64: videoBase64, filename, caption })
      return successRef()
    },
    voice: async (audioBase64, mime, _meta) => {
      await send('voice', { base64: audioBase64, mime })
      return successRef()
    },
    document: async (documentBase64, filename, caption, _meta) => {
      await send('document', { base64: documentBase64, filename, caption })
      return successRef()
    },
    keyboard: async (text, buttons, _meta) => {
      await send('keyboard', { text, buttons })
      return successRef({ ts: String(Date.now()), channel: 'local-web' })
    },
    editKeyboardMessage: async (_ref, text, _meta) => {
      await send('reply', { text })
      return successRef()
    },
    startTypingHeartbeat: (_action, _meta) => {
      void send('typing', { action: 'typing' })
      return () => {}
    },
    createDraftStream: () => createLocalWebDraftStream(),
    formatMarkdown: (md) => md,
    formatRichSnippet: (html) =>
      html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&'),
    formatDraft: (parts) => renderParts(parts, 'using'),
    formatFinal: (parts) => renderParts(parts, 'used'),
    formatImgGenPhase: (input) => {
      const { presetName, state, step } = input
      if (state === 'generating') return step ? `Generating: ${step}` : 'Generating…'
      return `${presetName} — ${state}`
    },
    formatItalic: (t) => t,
    escapeInline: (t) => t,
  }
}

export type { KeyboardButton } from './types'
