import { generatedMediaOf, mediaToolNameOf } from '@/lib/agentTranscript'
import {
  runsOwnedBy,
  type ArtifactRunsState,
  type ArtifactRunView,
} from '@/lib/artifactRunProjection'
import { isChatMediaToolPart } from '@/lib/chatToolParts'
import { sessionMediaPathOf } from '@/lib/comfyWorkflow'
import type { ArtifactPhase } from '@/types/kernelEvents'
import {
  hasDisplayableMedia,
  isInFlight,
  type GenerationFailureRecord,
  type MediaItem,
} from '@/types/mediaItem'

export type ArtifactAction =
  'info' | 'zoom' | 'copy' | 'download' | 'openFolder' | 'sendToEdit' | 'sendToVideo' | 'delete'

export type ArtifactState = 'running' | 'done' | 'deleted' | 'failed' | 'cancelled'

export type ArtifactSize = { width: number; height: number }

export type ArtifactProgress = { current: number; max: number }

export type TurnArtifact = {
  id: string
  mediaType: MediaItem['type']
  state: ArtifactState
  url: string
  item: MediaItem
  actions: ArtifactAction[]
  /** The requested size: the box both the placeholder and the result take. */
  size?: ArtifactSize
  phase?: ArtifactPhase
  progress?: ArtifactProgress
  reason?: string
}

export type GenerationFailure = { state: 'failed' | 'cancelled'; reason?: string }

type LiveState = { phase: ArtifactPhase; progress?: ArtifactProgress }

export function mediaUrlOf(item: MediaItem): string {
  if (item.type === 'video') return item.videoUrl
  if (item.type === 'model3d') return item.model3dUrl
  return item.imageUrl
}

function actionsFor(item: MediaItem, url: string): ArtifactAction[] {
  const image = item.type === 'image'
  return [
    'info',
    'zoom',
    ...(image ? (['copy'] as const) : []),
    'download',
    'openFolder',
    ...(image ? (['sendToEdit', 'sendToVideo'] as const) : []),
    ...(sessionMediaPathOf(url) ? (['delete'] as const) : []),
  ]
}

function requestedSize(item: MediaItem): ArtifactSize | undefined {
  const { width, height } = item.settings ?? {}
  return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
    ? { width, height }
    : undefined
}

export function oneLine(text: string | undefined): string | undefined {
  const line = text
    ?.split('\n')
    .map((part) => part.trim())
    .find(Boolean)
  return line || undefined
}

export function generationFailure(record: GenerationFailureRecord): GenerationFailure {
  const reason = record.state === 'failed' ? oneLine(record.error) : undefined
  return { state: record.state, ...(reason ? { reason } : {}) }
}

function isUnfinished(item: MediaItem): boolean {
  return item.state === 'failed' || item.state === 'stopped'
}

export function turnArtifact(
  item: MediaItem,
  deletedUrls: readonly string[],
  live?: LiveState,
  error?: string,
): TurnArtifact {
  const url = mediaUrlOf(item)
  const size = requestedSize(item)
  const base = { id: item.id, mediaType: item.type, url, item, ...(size ? { size } : {}) }
  if (isUnfinished(item)) {
    const state = item.state === 'stopped' ? 'cancelled' : 'failed'
    return { ...base, ...generationFailure({ state, error }), actions: ['info'] }
  }
  if (deletedUrls.includes(url)) return { ...base, state: 'deleted', actions: ['info'] }
  if (isInFlight(item) || !hasDisplayableMedia(item)) {
    return { ...base, state: 'running', actions: [], ...live }
  }
  return { ...base, state: 'done', actions: actionsFor(item, url) }
}

function shown(item: MediaItem): boolean {
  return isInFlight(item) || hasDisplayableMedia(item)
}

/** Failed or stopped slots are only recorded for a run that had started generating. */
export function turnArtifacts(
  items: readonly MediaItem[],
  deletedUrls: readonly string[],
  error?: string,
): TurnArtifact[] {
  return items
    .filter((item) => shown(item) || isUnfinished(item))
    .map((item) => turnArtifact(item, deletedUrls, undefined, error))
}

/** A run that settled before generating keeps no slot: its Turn says why in one line. */
export function runArtifacts(
  runs: readonly ArtifactRunView[],
  deletedUrls: readonly string[],
): TurnArtifact[] {
  return runs.flatMap((run) => {
    const siblingGenerates = run.items.some((item) => item.state === 'generating')
    return run.items
      .filter((item) => (isUnfinished(item) ? !!run.started : shown(item)))
      .map((item) => {
        const waits = item.state === 'queued' && siblingGenerates
        const live: LiveState = waits
          ? { phase: 'queued' }
          : { phase: run.phase, ...(run.progress ? { progress: run.progress } : {}) }
        return turnArtifact(item, deletedUrls, live, run.error)
      })
  })
}

export function runFailure(run: ArtifactRunView | undefined): GenerationFailure | null {
  if (!run || run.started) return null
  if (run.phase !== 'failed' && run.phase !== 'cancelled') return null
  return generationFailure({ state: run.phase, error: run.error })
}

export function placeholderArtifacts(
  runId: string,
  mode: MediaItem['mode'],
  size: ArtifactSize | undefined,
  count: number,
): TurnArtifact[] {
  return Array.from({ length: count }, (_, index) =>
    turnArtifact(
      {
        id: `${runId}-${index}`,
        type: 'image',
        state: 'queued',
        mode,
        imageUrl: '',
        settings: size ? { ...size } : {},
      },
      [],
      { phase: 'queued' },
    ),
  )
}

type MediaToolRecord = {
  images?: unknown
  unfinished?: unknown
  success?: unknown
  state?: unknown
  error?: unknown
  message?: unknown
}

type PiToolDetails = { items?: unknown; failure?: GenerationFailureRecord }

type MediaToolCall = {
  state: 'running' | 'settled' | 'failed' | 'other'
  toolCallId?: string
  prompt?: string
  errorText?: string
  record?: MediaToolRecord
  // Pi answers `{ content, details }` with its record as JSON text; chat tools answer the record.
  pi?: { details: PiToolDetails }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function jsonTextOf(content: unknown): MediaToolRecord | undefined {
  const entry = (Array.isArray(content) ? content : [])
    .map(recordOf)
    .find((candidate) => candidate?.type === 'text')
  if (typeof entry?.text !== 'string') return undefined
  try {
    return recordOf(JSON.parse(entry.text)) ?? undefined
  } catch {
    return undefined
  }
}

function callState(state: unknown): MediaToolCall['state'] {
  if (state === 'input-streaming' || state === 'input-available') return 'running'
  if (state === 'output-available') return 'settled'
  return state === 'output-error' ? 'failed' : 'other'
}

function mediaToolCall(part: unknown): MediaToolCall | null {
  if (!isChatMediaToolPart(part) && !mediaToolNameOf(part)) return null
  const fields = recordOf(part) ?? {}
  const prompt = recordOf(fields.input)?.prompt
  const call: MediaToolCall = {
    state: callState(fields.state),
    ...(typeof fields.toolCallId === 'string' ? { toolCallId: fields.toolCallId } : {}),
    ...(typeof prompt === 'string' && prompt ? { prompt } : {}),
    ...(typeof fields.errorText === 'string' && fields.errorText
      ? { errorText: fields.errorText }
      : {}),
  }
  const output = recordOf(fields.output)
  if (call.state !== 'settled' || !output) return call
  if (!('details' in output) && !('content' in output)) return { ...call, record: output }
  const record = jsonTextOf(output.content)
  return {
    ...call,
    ...(record ? { record } : {}),
    pi: { details: (recordOf(output.details) ?? {}) as PiToolDetails },
  }
}

function unfinishedOf(value: unknown): MediaItem[] {
  return (Array.isArray(value) ? (value as MediaItem[]) : []).filter(
    (item) => typeof item === 'object' && item !== null && isUnfinished(item),
  )
}

function settledMedia(part: unknown, call: MediaToolCall): MediaItem[] {
  if (call.pi) {
    return [...(generatedMediaOf(part)?.items ?? []), ...unfinishedOf(call.pi.details.items)]
  }
  const images = Array.isArray(call.record?.images) ? (call.record.images as MediaItem[]) : []
  return [
    ...images.map((image) => ({ ...image, state: 'done' as const })),
    ...unfinishedOf(call.record?.unfinished),
  ]
}

export function toolPartMedia(part: unknown): MediaItem[] {
  const call = mediaToolCall(part)
  if (call?.state !== 'settled') return []
  const items = settledMedia(part, call)
  const prompt = call.prompt
  if (!prompt) return items
  return items.map((item) =>
    item.settings?.prompt ? item : { ...item, settings: { ...item.settings, prompt } },
  )
}

const CANCELLED_MESSAGE = 'Generation cancelled.'

function failureRecordOf(record: MediaToolRecord | undefined): GenerationFailureRecord | null {
  if (!record || record.success !== false) return null
  const message = typeof record.message === 'string' ? record.message : undefined
  if (record.state === 'cancelled' || message === CANCELLED_MESSAGE) return { state: 'cancelled' }
  const error = typeof record.error === 'string' ? record.error : message
  return { state: 'failed', ...(error ? { error } : {}) }
}

export function toolCallFailureRecord(part: unknown): GenerationFailureRecord | null {
  const call = mediaToolCall(part)
  if (call?.state === 'failed') {
    return { state: 'failed', ...(call.errorText ? { error: call.errorText } : {}) }
  }
  if (call?.state !== 'settled') return null
  return call.pi?.details.failure ?? failureRecordOf(call.record)
}

export function toolCallArtifacts(
  part: unknown,
  artifactRuns: ArtifactRunsState | undefined,
  deletedUrls: readonly string[],
): TurnArtifact[] {
  const call = mediaToolCall(part)
  if (call?.state === 'running' && call.toolCallId) {
    return artifactRuns ? runArtifacts(runsOwnedBy(artifactRuns, call.toolCallId), deletedUrls) : []
  }
  return turnArtifacts(toolPartMedia(part), deletedUrls, toolCallFailureRecord(part)?.error)
}

export function toolCallResultFailure(part: unknown): GenerationFailure | null {
  const record = toolCallFailureRecord(part)
  if (!record || toolPartMedia(part).some(isUnfinished)) return null
  return generationFailure(record)
}

/** Once loaded, the media's own size caps the box and sets its aspect, so it is never upscaled. */
export function artifactFrameSize(
  requested: ArtifactSize | undefined,
  natural: ArtifactSize | undefined,
): ArtifactSize | undefined {
  if (!natural) return requested
  const width = Math.min(natural.width, requested?.width ?? natural.width)
  return { width, height: Math.round((width * natural.height) / natural.width) }
}

export const ARTIFACT_GRID_GAP_PX = 12
const ARTIFACT_GRID_MIN_CELL_PX = 240

export type ArtifactGrid = { columns: number; maxWidth?: number }

export function artifactGrid(
  artifacts: readonly Pick<TurnArtifact, 'size'>[],
  width: number,
): ArtifactGrid {
  const count = Math.max(artifacts.length, 1)
  const fit = Math.floor(
    (width + ARTIFACT_GRID_GAP_PX) / (ARTIFACT_GRID_MIN_CELL_PX + ARTIFACT_GRID_GAP_PX),
  )
  const rows = Math.ceil(count / Math.min(Math.max(fit, 1), count))
  const columns = Math.ceil(count / rows)
  const widths = artifacts.flatMap((artifact) => (artifact.size ? [artifact.size.width] : []))
  if (widths.length === 0 || widths.length < artifacts.length) return { columns }
  return { columns, maxWidth: columns * Math.max(...widths) + (columns - 1) * ARTIFACT_GRID_GAP_PX }
}
