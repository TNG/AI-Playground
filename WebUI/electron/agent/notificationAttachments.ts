import fs from 'node:fs/promises'
import path from 'node:path'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { CHANNEL_MEDIA_EXTENSIONS, channelMediaKind } from '@/lib/channelMediaKind'

export type AttachmentKind = 'photo' | 'video'

export type ChannelMedia = { kind: AttachmentKind; base64: string; filename: string }

export const ATTACHMENT_KINDS: readonly AttachmentKind[] = ['photo', 'video']

const MB = 1024 * 1024

/** The largest upload each channel accepts (Telegram's bot API caps uploads at 50 MB). */
const UPLOAD_LIMIT_BYTES: Record<ChannelKind, number> = {
  telegram: 50 * MB,
  slack: 1024 * MB,
  'local-web': 50 * MB,
  discord: 10 * MB,
}

export function allowedAttachmentExtensions(): string {
  return ATTACHMENT_KINDS.map(
    (kind) => `${kind}: ${CHANNEL_MEDIA_EXTENSIONS[kind].join(', ')}`,
  ).join('; ')
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function realPath(file: string): Promise<string | null> {
  return fs.realpath(file).catch(() => null)
}

type Checked = { file: string; kind: AttachmentKind } | { problem: string }

async function check(workspaceDir: string, ref: string, channel: ChannelKind): Promise<Checked> {
  const kind = channelMediaKind(ref)
  if (kind !== 'photo' && kind !== 'video') return { problem: 'unsupported file type' }
  const root = (await realPath(workspaceDir)) ?? path.resolve(workspaceDir)
  const file = path.resolve(root, ref)
  if (!isInside(root, file)) return { problem: 'outside the workspace' }
  const real = await realPath(file)
  if (!real) return { problem: 'file not found' }
  if (!isInside(root, real)) return { problem: 'outside the workspace' }
  const stat = await fs.stat(real)
  if (!stat.isFile()) return { problem: 'file not found' }
  const limit = UPLOAD_LIMIT_BYTES[channel]
  if (stat.size > limit) {
    return { problem: `larger than the ${limit / MB} MB ${channel} allows` }
  }
  return { file: real, kind }
}

/** Every attachment read for `channel`, or why one cannot be sent; nothing is read until all pass. */
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
    checked.map(async (result) => {
      const { file, kind } = result as { file: string; kind: AttachmentKind }
      const base64 = (await fs.readFile(file)).toString('base64')
      return { kind, base64, filename: path.basename(file) }
    }),
  )
  return { media }
}
