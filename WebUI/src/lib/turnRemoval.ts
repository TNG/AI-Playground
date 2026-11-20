import { hasDisplayableMedia, mediaUrlOf, type MediaItem } from '@/types/mediaItem'
import type { AudioTurn, MediaTurn, TurnRemoval } from '@/lib/turnTypes'

/** A turn's output files — its items' real media, never a failed or placeholder slot. */
export function mediaOutputUrls(items: MediaItem[]): string[] {
  return items.filter(hasDisplayableMedia).map(mediaUrlOf)
}

export function turnMessageIds(turn: MediaTurn | AudioTurn): string[] {
  return [turn.promptId, turn.id]
}

export function turnRemovalOf(turn: MediaTurn | AudioTurn): TurnRemoval {
  return {
    messageIds: turnMessageIds(turn),
    fileUrls:
      turn.kind === 'media'
        ? mediaOutputUrls(turn.media.items)
        : turn.audio.audioUrl
          ? [turn.audio.audioUrl]
          : [],
  }
}
