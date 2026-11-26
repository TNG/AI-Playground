import { resolveSessionFilePath } from '../agent/sessionFileAction'
import { sessionFileMounts } from '../agent/sessionWorkspace'
import { bootstrapAgentSessions } from '../persist/agentSessionFiles'
import { readSessionFile } from '../persist/sessionFiles'
import { listSessions } from './sessions'
import { createdFilesOf } from '@/lib/answerFileLinks'
import type { SessionCreatedFile } from '@/types/sessionIpc'
import type { SessionFileMounts } from '../agent/sessionWorkspace'

type TimelineMessage = {
  role?: unknown
  createdAt?: unknown
  metadata?: { agentTurn?: { harnessSessionId?: unknown } } | undefined
}

/**
 * Every file the Sessions' agent turns wrote, latest write per file winning:
 * the Artifacts tab lists these beside the media artifacts. A write whose
 * message settled before timestamps existed falls back to its Harness
 * Session's creation — a static value, so a later turn cannot re-float it.
 * `exists` is the disk-accurate word on the file right now: a file that is
 * gone stays listed with `exists: false` so the transcript chips can strike
 * it out; only the Artifacts tab filters to the existing ones.
 */
export async function listAllCreatedFiles(): Promise<SessionCreatedFile[]> {
  const [summaries, harness] = await Promise.all([listSessions(), bootstrapAgentSessions()])
  const harnessCreated = new Map(
    harness.status === 'ok'
      ? harness.sessions.map((record) => [record.id, record.createdAt] as const)
      : [],
  )
  const byKey = new Map<string, Omit<SessionCreatedFile, 'exists'>>()
  for (const summary of summaries) {
    const read = await readSessionFile(summary.id)
    if (read.status !== 'ok') continue
    for (const message of read.file.timeline as unknown[]) {
      const shaped = message as TimelineMessage | null
      const harnessSessionId = shaped?.metadata?.agentTurn?.harnessSessionId
      if (typeof harnessSessionId !== 'string' || shaped?.role !== 'assistant') continue
      const createdAt = shaped.createdAt
      const stamped = typeof createdAt === 'number' ? createdAt : undefined
      for (const file of createdFilesOf(message as Parameters<typeof createdFilesOf>[0])) {
        byKey.set(`${harnessSessionId}\u0000${file}`, {
          file,
          harnessSessionId,
          sessionRef: summary.id,
          sessionTitle: summary.title,
          createdAt: stamped ?? harnessCreated.get(harnessSessionId) ?? 0,
        })
      }
    }
  }
  const mountsByHarness = new Map<string, Promise<SessionFileMounts | null>>()
  const mountsOf = (harnessSessionId: string) => {
    let mounts = mountsByHarness.get(harnessSessionId)
    if (!mounts) {
      mounts = sessionFileMounts(harnessSessionId)
      mountsByHarness.set(harnessSessionId, mounts)
    }
    return mounts
  }
  const listed: SessionCreatedFile[] = []
  for (const entry of byKey.values()) {
    try {
      const mounts = await mountsOf(entry.harnessSessionId)
      if (mounts)
        listed.push({ ...entry, exists: resolveSessionFilePath(mounts, entry.file) !== null })
    } catch {
      // A stale path (mount gone, folder moved) drops its own card, never the listing.
    }
  }
  return listed
}
