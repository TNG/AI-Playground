import type { GenerationFailureRecord, MediaItem } from './mediaItem'

/** A media tool's Pi `details`: saved with the session record, so it outlives the live run. */
export type AgentMediaDetails = {
  /** Finished items, and the failed or stopped slots of a run that had started generating. */
  items?: AgentMediaItem[]
  steps?: string[]
  audio?: AgentSpeechClip
  failure?: GenerationFailureRecord
}

/** `workspacePath` is relative to the workspace; the item's own URL is the app copy. */
export type AgentMediaItem = MediaItem & { workspacePath?: string }

export type AgentSpeechClip = {
  savedFilePath: string
  workspacePath: string
  message?: string
  /** The Session-Folder copy, when the session has one. */
  url?: string
}

/** A generated file in an agent session; `appCopy` is its `aipg-media://` URL or app audio path. */
export type AgentMediaFileRef = {
  sessionId: string
  workspacePath?: string
  appCopy: string
}

export type AgentMediaFileAction = 'open' | 'reveal' | 'drag' | 'saveAs'
