// Slack ChannelAdapter — wraps the generic channel:send IPC and renders
// Slack mrkdwn / Block Kit.

import { markdownToSlackMrkdwn } from '@/lib/slackMrkdwn'
import type { InboundMeta } from './types'
import type { ChannelAdapter, RawPart } from './adapter'
import { renderGenericToolMarker, stripAipgMediaReferences } from './adapterHelpers'
import { reasoningElapsedMsFromParts } from '@/lib/reasoningTimings'

/** Lightweight HTML → Slack mrkdwn conversion for the hand-authored UI
 *  strings (HELP_MESSAGE, status banners). Limited to the set of tags those
 *  snippets actually use.
 */
function htmlSnippetToSlackMrkdwn(html: string): string {
  return html
    .replace(/<b>([\s\S]*?)<\/b>/gi, '*$1*')
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, '*$1*')
    .replace(/<i>([\s\S]*?)<\/i>/gi, '_$1_')
    .replace(/<em>([\s\S]*?)<\/em>/gi, '_$1_')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '<$1|$2>')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function renderImageToolPart(part: RawPart): string | null {
  const { workflow, prompt } = part.input ?? {}
  if (!workflow && !prompt) return null
  const phase = part.state === 'output-available' ? '✅' : '🎨'
  const titleBase = workflow ? `Generated using preset _${workflow}_` : 'Generated image'
  const noticeLines = [`${phase} ${titleBase}`]
  if (prompt) noticeLines.push(`_${prompt}_`)
  return noticeLines.join('\n')
}

function formatFinal(parts: RawPart[]): string {
  const lines: string[] = []
  const reasoningChunks: string[] = []
  for (const part of parts) {
    if (part.type !== 'reasoning') continue
    const txt = (part.text ?? '').trim()
    if (txt) reasoningChunks.push(txt)
  }
  if (reasoningChunks.length > 0) {
    const seconds = (reasoningElapsedMsFromParts(parts) / 1000).toFixed(1)
    // Slack has no expandable blockquote — emit a single quoted block with
    // the timing header at the top.
    const body = reasoningChunks.join('\n\n')
    const quoted = `💭 _Thought for ${seconds} seconds_\n\n${body}`
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n')
    lines.push(quoted)
  }
  for (const part of parts) {
    if (part.type === 'reasoning') {
      continue
    } else if (part.type === 'text') {
      const cleaned = stripAipgMediaReferences(part.text ?? '').trim()
      if (cleaned) lines.push(markdownToSlackMrkdwn(cleaned))
    } else if (part.type === 'tool-comfyUI' || part.type === 'tool-comfyUiImageEdit') {
      const marker = renderImageToolPart(part)
      if (marker) lines.push(marker)
    } else {
      const marker = renderGenericToolMarker(part)
      if (marker) lines.push(marker)
    }
  }
  return lines.join('\n\n')
}

/** Slack typing indicator via reactions.add/remove on the inbound message.
 *  Without an inbound message ref (no meta.ts / no meta.channel) this is a
 *  no-op stop function; the reply itself signals progress.
 */
function startTypingHeartbeat(_action: string, meta?: InboundMeta): () => void {
  const channel = meta?.channel
  const ts = meta?.ts
  const name = 'eyes'
  if (!channel || !ts) return () => {}
  void window.electronAPI.channels
    .send('slack', 'typing', { channel, ts, name, action: 'add' })
    .catch(() => {})
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    void window.electronAPI.channels
      .send('slack', 'typing', { channel, ts, name, action: 'remove' })
      .catch(() => {})
  }
}

/** A send's result with the ts/channel pair `chat.update` edits by. */
function withMessageRef(r: { success: boolean; error?: string; ts?: string; channel?: string }) {
  return {
    success: r.success,
    error: r.success ? undefined : r.error,
    ref: r.success && r.ts && r.channel ? { ts: r.ts, channel: r.channel } : undefined,
  }
}

export function createSlackAdapter(): ChannelAdapter {
  return {
    kind: 'slack',
    reply: async (text, meta) => {
      const r = await window.electronAPI.channels.send('slack', 'reply', {
        text,
        channel: meta?.channel,
        ...(meta?.threadTs ? { thread_ts: meta.threadTs } : {}),
      })
      return withMessageRef(r)
    },
    photo: async (imageBase64, caption, meta) => {
      return window.electronAPI.channels.send('slack', 'photo', {
        photo: imageBase64,
        caption,
        channel: meta?.channel,
      })
    },
    video: async (videoBase64, caption, filename, meta) => {
      return window.electronAPI.channels.send('slack', 'video', {
        video: videoBase64,
        caption,
        filename,
        channel: meta?.channel,
      })
    },
    voice: async (audioBase64, mime, meta) => {
      return window.electronAPI.channels.send('slack', 'voice', {
        audio: audioBase64,
        mime,
        channel: meta?.channel,
      })
    },
    document: async (documentBase64, filename, caption, meta) => {
      return window.electronAPI.channels.send('slack', 'document', {
        document: documentBase64,
        filename,
        caption,
        channel: meta?.channel,
      })
    },
    keyboard: async (text, buttons, meta) => {
      // Translate the channel-agnostic button matrix into Block Kit actions.
      // Slack limits 5 buttons per actions block and 25 elements per message,
      // so we break wide rows across multiple actions blocks. Action labels
      // truncate at 75 chars per Slack's spec.
      const blocks: Array<Record<string, unknown>> = [
        { type: 'section', text: { type: 'mrkdwn', text } },
      ]
      for (const row of buttons) {
        for (let i = 0; i < row.length; i += 5) {
          const slice = row.slice(i, i + 5)
          blocks.push({
            type: 'actions',
            elements: slice.map((b) => ({
              type: 'button',
              text: { type: 'plain_text', text: b.text.slice(0, 75) },
              action_id: b.callbackData.slice(0, 255),
              value: b.callbackData.slice(0, 2000),
            })),
          })
        }
      }
      const r = await window.electronAPI.channels.send('slack', 'keyboard', {
        text,
        blocks,
        channel: meta?.channel,
        ...(meta?.threadTs ? { thread_ts: meta.threadTs } : {}),
      })
      return withMessageRef(r)
    },
    post: async (text, meta) => {
      return withMessageRef(
        await window.electronAPI.channels.send('slack', 'post', {
          text,
          channel: meta?.channel,
          ...(meta?.threadTs ? { thread_ts: meta.threadTs } : {}),
        }),
      )
    },
    // Top-level, never in a thread: a reply in its own thread is how Slack answers it.
    askForReply: async (text, _request, meta) => {
      return withMessageRef(
        await window.electronAPI.channels.send('slack', 'post', { text, channel: meta?.channel }),
      )
    },
    editKeyboardMessage: async (ref, text) => {
      if (!ref.ts || !ref.channel) return { success: false, error: 'no message ref' }
      // chat.update with a single section block replaces the original message
      // (text + actions buttons) so the prompt no longer looks tappable.
      const r = await window.electronAPI.channels.send('slack', 'update', {
        channel: ref.channel,
        ts: ref.ts,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      })
      return { success: r.success, error: r.success ? undefined : r.error }
    },
    startTypingHeartbeat: (action, meta) => startTypingHeartbeat(action, meta),
    formatMarkdown: markdownToSlackMrkdwn,
    formatRichSnippet: htmlSnippetToSlackMrkdwn,
    formatFinal,
    formatItalic: (t) => `_${t}_`,
    // Slack mrkdwn has no formal escape, but `<` and `>` open entity links —
    // strip them to keep raw user-supplied text inert.
    escapeInline: (t) => t.replace(/[<>]/g, ''),
  }
}
