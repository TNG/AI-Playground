export type ChannelMediaKind = 'voice' | 'photo' | 'video'

const MEDIA_TYPES: Record<ChannelMediaKind, Record<string, string>> = {
  voice: { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg' },
  photo: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' },
  video: { mp4: 'video/mp4', webm: 'video/webm' },
}

// Other spellings of the same audio types that platforms send.
const MIME_ALIASES: Record<string, ChannelMediaKind> = {
  'audio/x-wav': 'voice',
  'audio/wave': 'voice',
  'audio/mp3': 'voice',
}

const kinds = Object.entries(MEDIA_TYPES) as [ChannelMediaKind, Record<string, string>][]

export const CHANNEL_MEDIA_EXTENSIONS: Record<ChannelMediaKind, readonly string[]> = {
  voice: Object.keys(MEDIA_TYPES.voice),
  photo: Object.keys(MEDIA_TYPES.photo),
  video: Object.keys(MEDIA_TYPES.video),
}

const MIME_KINDS: Record<string, ChannelMediaKind> = {
  ...Object.fromEntries(
    kinds.flatMap(([kind, types]) => Object.values(types).map((mime) => [mime, kind])),
  ),
  ...MIME_ALIASES,
}

const EXTENSION_TYPES = new Map<string, { kind: ChannelMediaKind; mime: string }>(
  kinds.flatMap(([kind, types]) =>
    Object.entries(types).map(([extension, mime]) => [extension, { kind, mime }] as const),
  ),
)

const MIME_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/

function extensionType(ref: string) {
  const name = ref.trim().toLowerCase().split(/[?#]/)[0].split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? EXTENSION_TYPES.get(name.slice(dot + 1)) : undefined
}

/** The channel media kind of a file name, path, URL, mime type or data URI; `null` when a channel cannot carry it. */
export function channelMediaKind(ref: string): ChannelMediaKind | null {
  const value = ref.trim().toLowerCase()
  if (value.startsWith('data:')) return MIME_KINDS[value.slice(5).split(/[;,]/)[0]] ?? null
  if (MIME_TYPE.test(value) && !value.includes('.')) return MIME_KINDS[value] ?? null
  return extensionType(value)?.kind ?? null
}

/** The mime type of a channel-carried file name; `null` when a channel cannot carry it. */
export function channelMediaType(filename: string): string | null {
  return extensionType(filename)?.mime ?? null
}
