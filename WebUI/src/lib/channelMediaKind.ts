export type ChannelMediaKind = 'voice' | 'photo' | 'video'

export const CHANNEL_MEDIA_EXTENSIONS: Record<ChannelMediaKind, readonly string[]> = {
  voice: ['wav', 'mp3', 'ogg'],
  photo: ['png', 'jpg', 'jpeg', 'webp'],
  video: ['mp4', 'webm'],
}

const MIME_KINDS: Record<string, ChannelMediaKind> = {
  'audio/wav': 'voice',
  'audio/x-wav': 'voice',
  'audio/wave': 'voice',
  'audio/mpeg': 'voice',
  'audio/mp3': 'voice',
  'audio/ogg': 'voice',
  'image/png': 'photo',
  'image/jpeg': 'photo',
  'image/webp': 'photo',
  'video/mp4': 'video',
  'video/webm': 'video',
}

const EXTENSION_KINDS = new Map<string, ChannelMediaKind>(
  (Object.entries(CHANNEL_MEDIA_EXTENSIONS) as [ChannelMediaKind, readonly string[]][]).flatMap(
    ([kind, extensions]) => extensions.map((extension) => [extension, kind] as const),
  ),
)

const MIME_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/

/** The channel media kind of a file name, path, URL, mime type or data URI; `null` when a channel cannot carry it. */
export function channelMediaKind(ref: string): ChannelMediaKind | null {
  const value = ref.trim().toLowerCase()
  if (value.startsWith('data:')) return MIME_KINDS[value.slice(5).split(/[;,]/)[0]] ?? null
  if (MIME_TYPE.test(value)) return MIME_KINDS[value] ?? null
  const name = value.split(/[?#]/)[0].split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? (EXTENSION_KINDS.get(name.slice(dot + 1)) ?? null) : null
}
