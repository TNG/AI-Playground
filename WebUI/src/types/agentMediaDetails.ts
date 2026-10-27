import type { MediaItem } from './mediaItem'

/** A media tool's Pi `details`: saved with the session record, so it outlives the live run. */
export type AgentMediaDetails = {
  items?: MediaItem[]
  steps?: string[]
  audio?: AgentSpeechClip
}

export type AgentSpeechClip = {
  savedFilePath: string
  workspacePath: string
  message?: string
}
