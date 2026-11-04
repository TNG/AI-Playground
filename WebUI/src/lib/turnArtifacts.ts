import { generatedMediaOf } from '@/lib/agentTranscript'
import { isChatMediaToolPart } from '@/lib/chatToolParts'
import { sessionMediaPathOf } from '@/lib/comfyWorkflow'
import { hasDisplayableMedia, isInFlight, type MediaItem } from '@/types/mediaItem'

export type ArtifactAction =
  'info' | 'zoom' | 'copy' | 'download' | 'openFolder' | 'sendToEdit' | 'sendToVideo' | 'delete'

export type ArtifactState = 'running' | 'done' | 'deleted'

/** One image, video or 3D model a Turn shows, with what the card offers to do with it. */
export type TurnArtifact = {
  id: string
  mediaType: MediaItem['type']
  state: ArtifactState
  url: string
  item: MediaItem
  actions: ArtifactAction[]
}

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

export function turnArtifact(item: MediaItem, deletedUrls: readonly string[]): TurnArtifact {
  const url = mediaUrlOf(item)
  const base = { id: item.id, mediaType: item.type, url, item }
  if (deletedUrls.includes(url)) return { ...base, state: 'deleted', actions: ['info'] }
  if (isInFlight(item) || !hasDisplayableMedia(item)) {
    return { ...base, state: 'running', actions: [] }
  }
  return { ...base, state: 'done', actions: actionsFor(item, url) }
}

/** The card's artifacts: items in flight or with media; a failed or stopped empty slot is none. */
export function turnArtifacts(
  items: readonly MediaItem[],
  deletedUrls: readonly string[],
): TurnArtifact[] {
  return items
    .filter((item) => isInFlight(item) || hasDisplayableMedia(item))
    .map((item) => turnArtifact(item, deletedUrls))
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
