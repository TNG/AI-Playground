import type { MediaItem } from './mediaItem'

/**
 * What an Agent Mode media tool hands the transcript next to the model's text, as
 * the Pi tool result's `details`. It is saved with the session record, so the
 * transcript can show the media after the live run is gone.
 */
export type AgentMediaDetails = {
  /** Generated images, videos and 3D models, as Chat's media card renders them. */
  items?: MediaItem[]
  /** The media specialist's step lines. */
  steps?: string[]
}
