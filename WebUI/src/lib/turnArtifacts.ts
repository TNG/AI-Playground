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

/** One image, video or 3D model a Turn shows, with what the card offers to do with it. */
export type TurnArtifact = {
  id: string
  mediaType: MediaItem['type']
  state: ArtifactState
  url: string
  item: MediaItem
  actions: ArtifactAction[]
  /** The width and height the generation asked for: the box its placeholder and result take. */
  size?: ArtifactSize
  /** Where a running artifact's generation is; absent once it settled. */
  phase?: ArtifactPhase
  progress?: ArtifactProgress
  /** Why a failed artifact failed, in one line. */
  reason?: string
}

/** A generation that ended without its result, and why in one line. */
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

/** The first line of an error, which is all a card or a Result has room for. */
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

/**
 * The card's artifacts: items in flight or with media, and the failed or stopped slots that
 * are only recorded for a run that had started generating.
 */
export function turnArtifacts(
  items: readonly MediaItem[],
  deletedUrls: readonly string[],
  error?: string,
): TurnArtifact[] {
  return items
    .filter((item) => shown(item) || isUnfinished(item))
    .map((item) => turnArtifact(item, deletedUrls, undefined, error))
}

/**
 * A run's artifacts; an item waiting behind a sibling that generates shows as queued. A run
 * that settled before generating anything keeps no slot: its Turn says why in one line.
 */
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

/** Why a run settled before generating anything; null for one that started or did not fail. */
export function runFailure(run: ArtifactRunView | undefined): GenerationFailure | null {
  if (!run || run.started) return null
  if (run.phase !== 'failed' && run.phase !== 'cancelled') return null
  return generationFailure({ state: run.phase, error: run.error })
}

/** Placeholders for a ComfyUI run the runner has not registered yet. */
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

type ToolOutput = {
  images?: unknown
  unfinished?: unknown
  success?: unknown
  state?: unknown
  error?: unknown
  message?: unknown
  details?: { items?: unknown; failure?: GenerationFailureRecord }
  content?: unknown
}

function isMediaToolPart(part: unknown): boolean {
  return isChatMediaToolPart(part) || !!mediaToolNameOf(part)
}

function settledOutput(part: unknown): ToolOutput | null {
  const { state, output } = part as { state?: unknown; output?: unknown }
  if (state !== 'output-available' || typeof output !== 'object' || output === null) return null
  return output as ToolOutput
}

/** Pi answers `{ content, details }`; chat tools answer their record itself. */
function isAgentOutput(output: ToolOutput): boolean {
  return 'details' in output || 'content' in output
}

function unfinishedOf(value: unknown): MediaItem[] {
  return (Array.isArray(value) ? (value as MediaItem[]) : []).filter(
    (item) => typeof item === 'object' && item !== null && isUnfinished(item),
  )
}

/** What a settled chat or Agent Preset media tool call produced, and the slots that failed. */
export function toolPartMedia(part: unknown): MediaItem[] {
  if (!isMediaToolPart(part)) return []
  const output = settledOutput(part)
  if (!output) return []
  if (isAgentOutput(output)) {
    return [...(generatedMediaOf(part)?.items ?? []), ...unfinishedOf(output.details?.items)]
  }
  const images = Array.isArray(output.images) ? (output.images as MediaItem[]) : []
  return [
    ...images.map((image) => ({ ...image, state: 'done' as const })),
    ...unfinishedOf(output.unfinished),
  ]
}

const CANCELLED_MESSAGE = 'Generation cancelled.'

function failureRecordOf(record: ToolOutput | null | undefined): GenerationFailureRecord | null {
  if (!record || record.success !== false) return null
  const message = typeof record.message === 'string' ? record.message : undefined
  if (record.state === 'cancelled' || message === CANCELLED_MESSAGE) return { state: 'cancelled' }
  const error = typeof record.error === 'string' ? record.error : message
  return { state: 'failed', ...(error ? { error } : {}) }
}

function jsonTextOf(content: unknown): ToolOutput | null {
  const entry = (Array.isArray(content) ? content : []).find(
    (candidate) => (candidate as { type?: unknown } | null)?.type === 'text',
  ) as { text?: unknown } | undefined
  if (typeof entry?.text !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(entry.text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as ToolOutput) : null
  } catch {
    return null
  }
}

/** How a settled media tool call failed or was cancelled, with its full error; null if not. */
export function toolCallFailureRecord(part: unknown): GenerationFailureRecord | null {
  if (!isMediaToolPart(part)) return null
  const { state, errorText } = part as { state?: unknown; errorText?: unknown }
  if (state === 'output-error') {
    return typeof errorText === 'string' && errorText
      ? { state: 'failed', error: errorText }
      : { state: 'failed' }
  }
  const output = settledOutput(part)
  if (!output) return null
  if (!isAgentOutput(output)) return failureRecordOf(output)
  return output.details?.failure ?? failureRecordOf(jsonTextOf(output.content))
}

function isRunningMediaTool(part: unknown): part is { toolCallId: string } {
  const { state, toolCallId } = part as { state?: unknown; toolCallId?: unknown }
  return (
    (state === 'input-streaming' || state === 'input-available') &&
    typeof toolCallId === 'string' &&
    isMediaToolPart(part)
  )
}

/**
 * A chat or Agent Preset media tool call's artifacts: while it runs, the runs it owns
 * (directly or through the media specialist); once settled, the files its output names.
 */
export function toolCallArtifacts(
  part: unknown,
  artifactRuns: ArtifactRunsState | undefined,
  deletedUrls: readonly string[],
): TurnArtifact[] {
  if (isRunningMediaTool(part)) {
    return artifactRuns ? runArtifacts(runsOwnedBy(artifactRuns, part.toolCallId), deletedUrls) : []
  }
  return turnArtifacts(toolPartMedia(part), deletedUrls, toolCallFailureRecord(part)?.error)
}

/**
 * What a media tool call's Result says in one line in place of a card: why it failed, or that
 * it was cancelled, before generating anything. Null when it did not, or a card says so.
 */
export function toolCallResultFailure(part: unknown): GenerationFailure | null {
  const record = toolCallFailureRecord(part)
  if (!record || toolPartMedia(part).some(isUnfinished)) return null
  return generationFailure(record)
}

export const ARTIFACT_GRID_GAP_PX = 12
const ARTIFACT_GRID_MIN_CELL_PX = 240

export type ArtifactGrid = { columns: number; maxWidth?: number }

/** A batch in balanced rows that fit `width`, never wider than its artifacts asked to be. */
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
