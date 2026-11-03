import fs from 'node:fs/promises'
import path from 'node:path'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import {
  CHANNEL_MEDIA_EXTENSIONS,
  channelMediaKind,
  type ChannelMediaKind,
} from '@/lib/channelMediaKind'
import type { Render3dThumbnailResult } from '@/types/chatRequests'
import { askRenderer } from '../chat/chatAsk.ts'
import { appLoggerInstance } from '../observability/logger.ts'

export type ChannelMedia = {
  kind: Exclude<ChannelMediaKind, 'model3d'> | 'document'
  base64: string
  filename: string
}

const MB = 1024 * 1024

/** The largest upload each channel accepts (Telegram's bot API caps uploads at 50 MB). */
const UPLOAD_LIMIT_BYTES: Record<ChannelKind, number> = {
  telegram: 50 * MB,
  slack: 1024 * MB,
  'local-web': 50 * MB,
  discord: 10 * MB,
}

const KIND_LABELS: Partial<Record<ChannelMediaKind, string>> = { model3d: '3D model' }

export function allowedAttachmentExtensions(): string {
  return Object.entries(CHANNEL_MEDIA_EXTENSIONS)
    .map(
      ([kind, extensions]) =>
        `${KIND_LABELS[kind as ChannelMediaKind] ?? kind}: ${extensions.join(', ')}`,
    )
    .join('; ')
}

/** A channel photo of a `.glb`, rendered by the window like the Chat turn's, named `<model>.jpg`. */
async function model3dScreenshot(model: Buffer, filename: string): Promise<ChannelMedia> {
  const { base64 } = await askRenderer<Render3dThumbnailResult>({
    kind: 'render-3d-thumbnail',
    modelBase64: model.toString('base64'),
  })
  const name = `${path.basename(filename, path.extname(filename))}.jpg`
  return { kind: 'photo', base64, filename: name }
}

/** What a file is sent to a channel as; a 3D model goes as its screenshot, then the file as a document. */
export async function channelMediaOf(file: string): Promise<ChannelMedia[]> {
  const kind = channelMediaKind(file)
  if (!kind) return []
  const bytes = await fs.readFile(file)
  const base64 = bytes.toString('base64')
  const filename = path.basename(file)
  if (kind !== 'model3d') return [{ kind, base64, filename }]
  const document: ChannelMedia = { kind: 'document', base64, filename }
  try {
    return [await model3dScreenshot(bytes, filename), document]
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    appLoggerInstance.warn(`3D screenshot not rendered: ${reason}`, 'notifier')
    return [document]
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function realPath(file: string): Promise<string | null> {
  return fs.realpath(file).catch(() => null)
}

type Checked = { file: string } | { problem: string }

async function check(workspaceDir: string, ref: string, channel: ChannelKind): Promise<Checked> {
  const kind = channelMediaKind(ref)
  if (!kind) return { problem: 'unsupported file type' }
  const root = (await realPath(workspaceDir)) ?? path.resolve(workspaceDir)
  const file = path.resolve(root, ref)
  if (!isInside(root, file)) return { problem: 'outside the workspace' }
  const real = await realPath(file)
  if (!real) return { problem: 'file not found' }
  if (!isInside(root, real)) return { problem: 'outside the workspace' }
  const stat = await fs.stat(real)
  if (!stat.isFile()) return { problem: 'file not found' }
  // The platform refuses an oversized 3D file at send time; its screenshot still goes.
  const limit = UPLOAD_LIMIT_BYTES[channel]
  if (kind !== 'model3d' && stat.size > limit) {
    return { problem: `larger than the ${limit / MB} MB ${channel} allows` }
  }
  return { file: real }
}

/** Nothing is read until every attachment passes its checks. */
export async function readAttachments(
  workspaceDir: string,
  refs: string[],
  channel: ChannelKind,
): Promise<{ media: ChannelMedia[] } | { error: string }> {
  const checked = await Promise.all(refs.map((ref) => check(workspaceDir, ref, channel)))
  const problems = checked.flatMap((result, index) =>
    'problem' in result ? [`${refs[index]}: ${result.problem}`] : [],
  )
  if (problems.length > 0) {
    return {
      error: `${problems.join('; ')}. Allowed attachments: ${allowedAttachmentExtensions()}`,
    }
  }
  const media = await Promise.all(
    checked.map((result) => channelMediaOf((result as { file: string }).file)),
  )
  return { media: media.flat() }
}
