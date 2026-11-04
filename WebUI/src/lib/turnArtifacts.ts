import { generatedMediaOf, mediaToolNameOf } from '@/lib/agentTranscript'
import {
  runsOwnedBy,
  type ArtifactRunsState,
  type ArtifactRunView,
} from '@/lib/artifactRunProjection'
import { isChatMediaToolPart } from '@/lib/chatToolParts'
import { sessionMediaPathOf } from '@/lib/comfyWorkflow'
import type { ArtifactPhase } from '@/types/kernelEvents'
import { hasDisplayableMedia, isInFlight, type MediaItem } from '@/types/mediaItem'

export type ArtifactAction =
  'info' | 'zoom' | 'copy' | 'download' | 'openFolder' | 'sendToEdit' | 'sendToVideo' | 'delete'

export type ArtifactState = 'running' | 'done' | 'deleted'

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
}

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

export function turnArtifact(
  item: MediaItem,
  deletedUrls: readonly string[],
  live?: LiveState,
): TurnArtifact {
  const url = mediaUrlOf(item)
  const size = requestedSize(item)
  const base = { id: item.id, mediaType: item.type, url, item, ...(size ? { size } : {}) }
  if (deletedUrls.includes(url)) return { ...base, state: 'deleted', actions: ['info'] }
  if (isInFlight(item) || !hasDisplayableMedia(item)) {
    return { ...base, state: 'running', actions: [], ...live }
  }
  return { ...base, state: 'done', actions: actionsFor(item, url) }
}

function shown(item: MediaItem): boolean {
  return isInFlight(item) || hasDisplayableMedia(item)
}

/** The card's artifacts: items in flight or with media; a failed or stopped empty slot is none. */
export function turnArtifacts(
  items: readonly MediaItem[],
  deletedUrls: readonly string[],
): TurnArtifact[] {
  return items.filter(shown).map((item) => turnArtifact(item, deletedUrls))
}

/** A run's artifacts; an item waiting behind a sibling that generates shows as queued. */
export function runArtifacts(
  runs: readonly ArtifactRunView[],
  deletedUrls: readonly string[],
): TurnArtifact[] {
  return runs.flatMap((run) => {
    const siblingGenerates = run.items.some((item) => item.state === 'generating')
    return run.items.filter(shown).map((item) => {
      const waits = item.state === 'queued' && siblingGenerates
      const live: LiveState = waits
        ? { phase: 'queued' }
        : { phase: run.phase, ...(run.progress ? { progress: run.progress } : {}) }
      return turnArtifact(item, deletedUrls, live)
    })
  })
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

/** What a settled chat or Agent Preset media tool call produced. */
export function toolPartMedia(part: unknown): MediaItem[] {
  const agentItems = generatedMediaOf(part)?.items
  if (agentItems?.length) return agentItems
  const { state, output } = part as { state?: unknown; output?: { images?: unknown } }
  if (state !== 'output-available' || !isChatMediaToolPart(part)) return []
  const images = Array.isArray(output?.images) ? (output.images as MediaItem[]) : []
  return images.map((image) => ({ ...image, state: 'done' as const }))
}

function isRunningMediaTool(part: unknown): part is { toolCallId: string } {
  const { state, toolCallId } = part as { state?: unknown; toolCallId?: unknown }
  return (
    (state === 'input-streaming' || state === 'input-available') &&
    typeof toolCallId === 'string' &&
    (isChatMediaToolPart(part) || !!mediaToolNameOf(part))
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
  return turnArtifacts(toolPartMedia(part), deletedUrls)
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
