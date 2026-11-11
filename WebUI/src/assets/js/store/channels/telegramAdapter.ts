// Telegram ChannelAdapter — wraps the generic channel:send IPC and renders
// Telegram-native HTML (parse_mode=HTML).

import { markdownToTelegramHtml } from '../../telegramMarkdown'
import type { ChannelAdapter, RawPart } from './adapter'
import { escapeHtml, renderGenericToolMarker, stripAipgMediaReferences } from './adapterHelpers'
import { reasoningElapsedMsFromParts } from '@/lib/reasoningTimings'

const PARSE_MODE = 'HTML' as const

function sendTelegramReply(text: string) {
  return window.electronAPI.channels.send('telegram', 'reply', {
    text,
    parse_mode: PARSE_MODE,
  })
}

/** A send's result with the message id the edit action needs. */
function withMessageRef(r: { success: boolean; error?: string; messageId?: number }) {
  return {
    success: r.success,
    error: r.success ? undefined : r.error,
    ref: r.success && typeof r.messageId === 'number' ? { messageId: r.messageId } : undefined,
  }
}

function sendTelegramChatAction(action: string) {
  return window.electronAPI.channels.send('telegram', 'typing', { action })
}

/** Render one tool-comfyUI / tool-comfyUiImageEdit part as Telegram HTML. */
function renderImageToolPart(part: RawPart): string | null {
  const { workflow, prompt } = part.input ?? {}
  if (!workflow && !prompt) return null
  const phase = part.state === 'output-available' ? '✅' : '🎨'
  const titleBase = workflow
    ? `Generated using preset <i>${escapeHtml(workflow)}</i>`
    : 'Generated image'
  const noticeLines = [`${phase} ${titleBase}`]
  if (prompt) noticeLines.push(`<i>${escapeHtml(prompt)}</i>`)
  return noticeLines.join('\n')
}

function formatFinal(parts: RawPart[]): string {
  const lines: string[] = []
  // Coalesce all reasoning parts into one expandable blockquote with a
  // "Thought for X.X seconds" header above the full transcript.
  const reasoningChunks: string[] = []
  for (const part of parts) {
    if (part.type !== 'reasoning') continue
    const txt = (part.text ?? '').trim()
    if (txt) reasoningChunks.push(txt)
  }
  if (reasoningChunks.length > 0) {
    const seconds = (reasoningElapsedMsFromParts(parts) / 1000).toFixed(1)
    const header = `💭 <i>Thought for ${seconds} seconds</i>`
    const body = reasoningChunks.map((t) => escapeHtml(t)).join('\n\n')
    lines.push(`<blockquote expandable>${header}\n\n${body}</blockquote>`)
  }
  for (const part of parts) {
    if (part.type === 'reasoning') {
      continue
    } else if (part.type === 'text') {
      const cleaned = stripAipgMediaReferences(part.text ?? '').trim()
      if (cleaned) lines.push(markdownToTelegramHtml(cleaned))
    } else if (part.type === 'tool-comfyUI' || part.type === 'tool-comfyUiImageEdit') {
      const marker = renderImageToolPart(part)
      if (marker) lines.push(marker)
    } else {
      const marker = renderGenericToolMarker(part)
      if (marker) lines.push(escapeHtml(marker))
    }
  }
  return lines.join('\n\n')
}

/** Persistent "typing…" indicator via Telegram chat actions. Telegram
 *  chat actions auto-expire after ~5 s on the client so we fire one
 *  immediately and refresh every 4 s until stopped.
 */
function startTypingHeartbeat(action: string = 'typing'): () => void {
  let stopped = false
  void sendTelegramChatAction(action)
  const intervalId = setInterval(() => {
    if (stopped) return
    void sendTelegramChatAction(action)
  }, 4000)
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(intervalId)
  }
}

export function createTelegramAdapter(): ChannelAdapter {
  return {
    kind: 'telegram',
    reply: async (text) => {
      const r = await sendTelegramReply(text)
      return {
        success: r.success,
        error: r.success ? undefined : r.error,
        ref: r.success ? { draftId: 0 } : undefined,
      }
    },
    photo: async (imageBase64, caption) => {
      return window.electronAPI.channels.send('telegram', 'photo', {
        photo: imageBase64,
        caption,
      })
    },
    video: async (videoBase64, caption, filename) => {
      return window.electronAPI.channels.send('telegram', 'video', {
        video: videoBase64,
        caption,
        filename,
      })
    },
    voice: async (audioBase64, mime) => {
      return window.electronAPI.channels.send('telegram', 'voice', {
        audio: audioBase64,
        mime,
      })
    },
    document: async (documentBase64, filename, caption) => {
      return window.electronAPI.channels.send('telegram', 'document', {
        document: documentBase64,
        filename,
        caption,
      })
    },
    keyboard: async (text, buttons) => {
      const r = await window.electronAPI.channels.send('telegram', 'keyboard', {
        text,
        parse_mode: PARSE_MODE,
        // Translate the channel-agnostic button matrix to snake_case Telegram-style
        // payload so the Python side does not need to know about camelCase
        // adapter keys.
        buttons: buttons.map((row) =>
          row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })),
        ),
      })
      return withMessageRef(r)
    },
    post: async (text) => {
      return withMessageRef(
        await window.electronAPI.channels.send('telegram', 'post', {
          text,
          parse_mode: PARSE_MODE,
        }),
      )
    },
    askForReply: async (text, request) => {
      return withMessageRef(
        await window.electronAPI.channels.send('telegram', 'post', {
          text,
          parse_mode: PARSE_MODE,
          force_reply_placeholder: request.placeholder,
        }),
      )
    },
    editKeyboardMessage: async (ref, text) => {
      if (typeof ref.messageId !== 'number') return { success: false, error: 'no message id' }
      const r = await window.electronAPI.channels.send('telegram', 'editMessage', {
        message_id: ref.messageId,
        text,
        parse_mode: PARSE_MODE,
      })
      return { success: r.success, error: r.success ? undefined : r.error }
    },
    startTypingHeartbeat,
    formatMarkdown: markdownToTelegramHtml,
    formatRichSnippet: (s) => s, // Telegram already speaks HTML
    formatFinal,
    formatItalic: (t) => `<i>${escapeHtml(t)}</i>`,
    escapeInline: escapeHtml,
  }
}
