// Reading Agent Mode's transcript: what a UI message part *is*. Pi's dynamic tools are not
// in the app's tool union, so parts are inspected structurally instead of being cast.

import type {
  AgentMediaDetails,
  AgentMediaFileRef,
  AgentMediaItem,
  AgentSpeechClip,
} from '@/types/agentMediaDetails'
import type { MediaItem } from '@/types/mediaItem'

type PartShape = {
  type?: unknown
  state?: unknown
  toolName?: unknown
  output?: unknown
  toolCallId?: unknown
  input?: unknown
}

function shapeOf(part: unknown): PartShape {
  return typeof part === 'object' && part !== null ? (part as PartShape) : {}
}

/** Tool name of a tool part, in either encoding (`tool-bash` / `dynamic-tool`). */
export function toolPartNameOf(part: unknown): string | undefined {
  const { type, toolName } = shapeOf(part)
  if (type === 'dynamic-tool') return typeof toolName === 'string' ? toolName : undefined
  if (typeof type === 'string' && type.startsWith('tool-')) return type.slice('tool-'.length)
  return undefined
}

export function isReasoningPart(part: unknown): boolean {
  return shapeOf(part).type === 'reasoning'
}

/** Pi's context compaction, which the translator reports as a synthetic call. */
export type CompactionOutput = {
  trigger: 'manual' | 'threshold' | 'overflow'
  summary: string
  tokensBefore?: number
  tokensAfter?: number
}

export function compactionOutputOf(part: unknown): CompactionOutput | null {
  const { type, toolName, output } = shapeOf(part)
  if (type !== 'dynamic-tool' || toolName !== 'compaction') return null
  return output && typeof output === 'object' ? (output as CompactionOutput) : null
}

/** The bridged media tools, whose results render as images/video/3D models. */
const MEDIA_BRIDGE_TOOL_NAMES = new Set(['media', 'generateImage', 'editImage'])

export function mediaToolNameOf(part: unknown): string | undefined {
  const name = toolPartNameOf(part)
  return name && MEDIA_BRIDGE_TOOL_NAMES.has(name) ? name : undefined
}

/** What a finished media tool call produced, as Chat's media card renders it. */
export type GeneratedMedia = {
  items: AgentMediaItem[]
  steps?: string[]
  audio?: AgentSpeechClip
}

export function generatedMediaOf(part: unknown): GeneratedMedia | undefined {
  if (shapeOf(part).state !== 'output-available') return undefined
  const output = shapeOf(part).output as { details?: unknown } | undefined
  const details = (
    typeof output?.details === 'object' && output.details !== null ? output.details : {}
  ) as { [K in keyof AgentMediaDetails]?: unknown }
  const audio = details.audio as Partial<AgentSpeechClip> | undefined
  if (typeof audio?.savedFilePath === 'string' && audio.savedFilePath) {
    return { items: [], audio: audio as AgentSpeechClip }
  }
  if (!mediaToolNameOf(part)) return undefined
  const items = (Array.isArray(details.items) ? details.items : []).filter(isFinishedMedia)
  const steps = Array.isArray(details.steps) ? (details.steps as string[]) : undefined
  if (items.length === 0 && !steps) return undefined
  return { items, steps }
}

function isFinishedMedia(item: unknown): item is MediaItem {
  if (typeof item !== 'object' || item === null) return false
  const media = item as MediaItem
  return media.state === 'done' && hasMediaUrl(media)
}

function hasMediaUrl(item: MediaItem): boolean {
  return !!mediaUrlOf(item)
}

function mediaUrlOf(item: MediaItem): string | undefined {
  if (item.type === 'image') return item.imageUrl
  if (item.type === 'video') return item.videoUrl
  if (item.type === 'model3d') return item.model3dUrl
  return undefined
}

/** What a file action on generated media targets: the workspace copy, else the app copy. */
export function mediaFileRefOf(
  sessionId: string,
  target: AgentMediaItem | AgentSpeechClip,
): AgentMediaFileRef {
  const appCopy = 'savedFilePath' in target ? target.savedFilePath : (mediaUrlOf(target) ?? '')
  const workspacePath = typeof target.workspacePath === 'string' ? target.workspacePath : ''
  return { sessionId, ...(workspacePath ? { workspacePath } : {}), appCopy }
}

function truncate(value: unknown, max = 48): string {
  if (typeof value !== 'string') return ''
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export function objectInputOf(part: unknown): Record<string, unknown> | undefined {
  const input = shapeOf(part).input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

/** What a running agent tool is doing, where there is more to say than its name. */
export function toolActionLabel(name: string, input?: Record<string, unknown>): string | undefined {
  const filePath = truncate(input?.file_path)
  switch (name) {
    case 'read':
      return `Reading ${filePath}…`
    case 'edit':
      return `Editing ${filePath}…`
    case 'write':
      return `Writing ${filePath}…`
    case 'ls':
      return 'Listing files…'
    case 'bash':
      return `Running: ${truncate(input?.command)}`
    case 'navigate_page':
      return input?.url ? `Opening ${truncate(input.url)}…` : 'Navigating…'
    case 'list_console_messages':
      return 'Reading browser console…'
    case 'list_pages':
      return 'Listing browser pages…'
    case 'take_screenshot':
      return 'Taking screenshot…'
    case 'take_snapshot':
      return 'Snapshotting page…'
    case 'evaluate_script':
      return 'Running script in page…'
    default:
      return undefined
  }
}

type MessageShape = { parts?: readonly unknown[] }
type StreamingPartShape = {
  state?: unknown
  providerMetadata?: { aipg?: Record<string, unknown> } & Record<string, unknown>
}

/**
 * Mark text and reasoning parts still `streaming` as done. A stopped turn drops the closing
 * chunks main sends after the abort, so without this a reasoning timer counts on forever.
 * `finishedAt` stamps reasoning that has a start; without it no duration is invented.
 */
export function settleStreamingParts<M extends MessageShape>(
  messages: readonly M[],
  finishedAt?: number,
): M[] {
  return messages.map((message) => {
    if (!message.parts?.some((part) => shapeOf(part).state === 'streaming')) return message
    return { ...message, parts: message.parts.map((part) => settledPart(part, finishedAt)) }
  })
}

function settledPart(part: unknown, finishedAt: number | undefined): unknown {
  const shape = shapeOf(part)
  if (shape.state !== 'streaming') return part
  const { providerMetadata } = part as StreamingPartShape
  const aipg = providerMetadata?.aipg
  const stamp =
    shape.type === 'reasoning' &&
    finishedAt !== undefined &&
    typeof aipg?.reasoningStarted === 'number' &&
    aipg.reasoningFinished === undefined
  return {
    ...(part as object),
    state: 'done',
    ...(stamp
      ? {
          providerMetadata: {
            ...providerMetadata,
            aipg: { ...aipg, reasoningFinished: finishedAt },
          },
        }
      : {}),
  }
}
