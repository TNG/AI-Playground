// The files a Session's agent turns created, each with the timestamp of the
// message that last wrote it — the Artifacts tab's file cards order by it.

import { createdFilesOf } from '@/lib/answerFileLinks'
import { timelineTurns } from '@/lib/sessionTimeline'

export type SessionFileEntry = {
  file: string
  /** The harness session whose workspace holds the file. */
  sessionId: string
  /** When the file was last written. A message that settled before stamps
   * existed has no honest time, so it falls back — a static value, never the
   * Session's live last-activity, which would re-float the card on every turn. */
  createdAt: number
}

/** Files written by the timeline's agent turns, latest write per file wins. */
export function createdFileEntriesOf(
  timeline: readonly unknown[],
  fallbackCreatedAtOf: (harnessSessionId: string) => number,
): SessionFileEntry[] {
  const byKey = new Map<
    string,
    { file: string; sessionId: string; createdAt: number | undefined }
  >()
  for (const turn of timelineTurns([...timeline])) {
    if (turn.kind !== 'agent') continue
    for (const message of turn.answers) {
      const createdAt = (message as { createdAt?: number }).createdAt
      for (const file of createdFilesOf(message)) {
        byKey.set(`${turn.harnessSessionId}\u0000${file}`, {
          file,
          sessionId: turn.harnessSessionId,
          createdAt,
        })
      }
    }
  }
  return [...byKey.values()].map((entry) => ({
    file: entry.file,
    sessionId: entry.sessionId,
    createdAt: entry.createdAt ?? fallbackCreatedAtOf(entry.sessionId),
  }))
}
