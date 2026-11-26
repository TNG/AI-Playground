import type { ArtifactMediaType, HistoryEntry } from '@/types/sessionIpc'

// What one Session produced, folded from its whole History when the Overview page
// is written. Derived, never stored on the summary and never shown to the model.

export type OverviewWorkCounts = {
  images: number
  videos: number
  models3d: number
  audio: number
  transcriptions: number
  agentRuns: number
  failedTurns: number
}

export const OVERVIEW_WORK_COUNT_ORDER = [
  'images',
  'videos',
  'models3d',
  'audio',
  'transcriptions',
  'agentRuns',
  'failedTurns',
] as const

export type OverviewWorkCountCategory = (typeof OVERVIEW_WORK_COUNT_ORDER)[number]

const MEDIA_CATEGORY: Record<ArtifactMediaType, OverviewWorkCountCategory> = {
  image: 'images',
  video: 'videos',
  model3d: 'models3d',
  audio: 'audio',
}

/** A turn the app ran or continued for an Agent: a run names it by Task, a Follow-up by Agent. */
function namesAgent(entry: HistoryEntry): boolean {
  return entry.agentId !== undefined || entry.taskName !== undefined
}

export function foldOverviewWorkCounts(entries: readonly HistoryEntry[]): OverviewWorkCounts {
  const counts: OverviewWorkCounts = {
    images: 0,
    videos: 0,
    models3d: 0,
    audio: 0,
    transcriptions: 0,
    agentRuns: 0,
    failedTurns: 0,
  }
  const runs = new Set<string>()
  let preHarnessRuns = 0
  for (const entry of entries) {
    for (const artifact of entry.artifacts) counts[MEDIA_CATEGORY[artifact.mediaType]] += 1
    if (entry.kind === 'stt') counts.transcriptions += 1
    if (namesAgent(entry)) {
      if (entry.harnessSessionId) runs.add(entry.harnessSessionId)
      else preHarnessRuns += 1
    }
    if (entry.status !== 'completed') counts.failedTurns += 1
  }
  counts.agentRuns = runs.size + preHarnessRuns
  return counts
}
