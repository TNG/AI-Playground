import type { ArtifactMediaType, HistoryEntry } from '@/types/sessionIpc'

// What one Session produced, folded from its History when the Overview page is written.

export const OVERVIEW_WORK_COUNT_ORDER = [
  'images',
  'videos',
  'models3d',
  'audio',
  'transcriptions',
  'agentRuns',
] as const

export type OverviewWorkCountCategory = (typeof OVERVIEW_WORK_COUNT_ORDER)[number]

export type OverviewWorkCounts = Record<OverviewWorkCountCategory, number>

function emptyCounts(): OverviewWorkCounts {
  return Object.fromEntries(
    OVERVIEW_WORK_COUNT_ORDER.map((category) => [category, 0]),
  ) as OverviewWorkCounts
}

const MEDIA_CATEGORY: Record<ArtifactMediaType, OverviewWorkCountCategory> = {
  image: 'images',
  video: 'videos',
  model3d: 'models3d',
  audio: 'audio',
}

/** A turn the app ran or continued for an Agent: a run names it by Task, a Follow-up by Agent. */
function isAgentRunTurn(entry: HistoryEntry): boolean {
  return entry.agentId !== undefined || entry.taskName !== undefined
}

export function foldOverviewWorkCounts(entries: readonly HistoryEntry[]): OverviewWorkCounts {
  const counts = emptyCounts()
  const runs = new Set<string>()
  let preHarnessRuns = 0
  for (const entry of entries) {
    for (const artifact of entry.artifacts) counts[MEDIA_CATEGORY[artifact.mediaType]] += 1
    if (entry.kind === 'stt' && entry.status === 'completed') counts.transcriptions += 1
    if (isAgentRunTurn(entry)) {
      if (entry.harnessSessionId) runs.add(entry.harnessSessionId)
      else preHarnessRuns += 1
    }
  }
  counts.agentRuns = runs.size + preHarnessRuns
  return counts
}
