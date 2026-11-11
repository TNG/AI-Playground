import type { AnswerRouterCopy } from '@/lib/answerRouterWording'
import { attachmentLine } from '@/lib/attachmentReferences'
import { fillTemplate } from '@/lib/fillTemplate'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import { DOCUMENT_EXTENSIONS } from '@/types/rag'
import type { ChannelAdapter } from './adapter'
import type { InboundChannelMessage, SessionPort, SessionTarget } from './answerRouter'
import type { ChannelKind, InboundMeta } from './types'

/** The largest file a Channel hands a Session. */
export const MAX_CHANNEL_FILE_BYTES = 25 * 1024 * 1024

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
}

/** An image or document a Channel sent, for a Session's attachments. */
export type ChannelFile = { kind: 'image' | 'document'; filename: string; dataBase64: string }

/** `images-unseen`: the target's model cannot see images, so the image was not stored. */
export type AttachResult =
  { ok: true; path: string } | { ok: false; reason: 'images-unseen' | 'error'; message: string }

type InboundFile = { file: ChannelFile; supported: boolean }

function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

function subtype(mime: string): string {
  return mime.split('/')[1]?.split(';')[0] || 'bin'
}

function filesOf(kind: ChannelKind, msg: InboundChannelMessage): InboundFile[] {
  const images = (msg.images ?? []).map((image) => ({
    file: {
      kind: 'image' as const,
      filename: `${kind}-image.${IMAGE_EXTENSIONS[image.mime] ?? subtype(image.mime)}`,
      dataBase64: image.data_base64,
    },
    supported: image.mime in IMAGE_EXTENSIONS,
  }))
  const documents = (msg.documents ?? []).map((document) => {
    const filename = document.filename || 'document'
    const extension = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
    return {
      file: { kind: 'document' as const, filename, dataBase64: document.data_base64 },
      supported: (DOCUMENT_EXTENSIONS as readonly string[]).includes(extension),
    }
  })
  return [...images, ...documents]
}

/** Why a message's files cannot go to any Session, or null when they all can. */
export function fileRefusal(
  kind: ChannelKind,
  msg: InboundChannelMessage,
  copy: AnswerRouterCopy,
): string | null {
  if (msg.refused) return msg.refused
  const audio = (msg.audio ?? []).map((clip) => ({
    filename: `${kind}-voice.${subtype(clip.mime)}`,
    dataBase64: clip.data_base64,
    supported: true,
  }))
  const lines = [
    ...filesOf(kind, msg).map(({ file, supported }) => ({ ...file, supported })),
    ...audio,
  ]
    .map(({ filename, dataBase64, supported }) =>
      !supported
        ? fillTemplate(copy.fileUnsupported, { file: filename })
        : decodedBytes(dataBase64) > MAX_CHANNEL_FILE_BYTES
          ? fillTemplate(copy.fileTooLarge, { file: filename })
          : null,
    )
    .filter((line): line is string => line !== null)
  return lines.length > 0 ? lines.join('\n') : null
}

/** Where a message came from, so its turn replies under it (and speaks, for a voice message). */
export function inboundOrigin(kind: ChannelKind, msg: InboundChannelMessage): AgentAnswerOrigin {
  return {
    channel: kind,
    ...(msg.replyTarget ? { replyTo: msg.replyTarget } : {}),
    ...(msg.voice ? { voice: true } : {}),
  }
}

/** A reply is answered in the thread it was sent in (Slack). */
export function answerMeta(
  msg: InboundChannelMessage,
  meta?: InboundMeta,
): InboundMeta | undefined {
  return msg.replyTarget ? { ...meta, threadTs: msg.replyTarget } : meta
}

export type InboundDeps = {
  copy: () => AnswerRouterCopy
  tell: (adapter: ChannelAdapter, text: string, meta?: InboundMeta) => Promise<void>
}

/** True when the Session a reply names takes it; else the Channel was told why. Null: deleted. */
export async function replyReachable(
  deps: InboundDeps,
  port: SessionPort,
  adapter: ChannelAdapter,
  target: SessionTarget | null,
  meta?: InboundMeta,
): Promise<boolean> {
  if (!target || !(await port.exists(target.sessionRef))) {
    await deps.tell(adapter, deps.copy().noSession, meta)
    return false
  }
  if (!(await port.isReachable(target.sessionRef))) {
    const title = port.label(target)
    await deps.tell(adapter, fillTemplate(deps.copy().unreachable, { title }), meta)
    return false
  }
  return true
}

/**
 * Stores the message's images and documents in `target`'s Session: the prompt to send (its text,
 * then the images it names), or null when no turn runs, the Channel told why.
 */
export async function attachedPrompt(
  deps: InboundDeps,
  port: SessionPort,
  adapter: ChannelAdapter,
  target: SessionTarget,
  msg: InboundChannelMessage,
  meta?: InboundMeta,
): Promise<string | null> {
  const text = msg.text?.trim() ?? ''
  const images: string[] = []
  const documents: string[] = []
  // Images first: one the model cannot see stops the message before a document is stored.
  const files = filesOf(adapter.kind, msg).map(({ file }) => file)
  for (const file of files) {
    const result = await attach(port, target, file)
    if (!result.ok) {
      const wording = deps.copy()
      const refusal =
        result.reason === 'images-unseen'
          ? fillTemplate(wording.imagesUnseen, { title: port.label(target) })
          : fillTemplate(wording.attachFailed, { file: file.filename, error: result.message })
      await deps.tell(adapter, refusal, meta)
      return null
    }
    if (file.kind === 'image') images.push(result.path)
    else documents.push(file.filename)
  }
  if (!text && images.length === 0) {
    if (documents.length > 0) {
      const title = port.label(target)
      const attached = fillTemplate(deps.copy().documentsAttached, {
        title,
        files: documents.join(', '),
      })
      await deps.tell(adapter, attached, meta)
    }
    return null
  }
  return [text, attachmentLine(images)].filter(Boolean).join('\n\n')
}

async function attach(
  port: SessionPort,
  target: SessionTarget,
  file: ChannelFile,
): Promise<AttachResult> {
  try {
    return await port.attach(target, file)
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}
