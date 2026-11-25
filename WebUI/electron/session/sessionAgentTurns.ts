import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'
import { emitSessionChanged } from '../kernel/kernelBus'
import { onGeneratedMedia } from '../agent/generatedMedia'
import type { AgentTurnEnd } from '../agent/agentTurnOutcome'
import { artifactReferenceOf } from './historyArtifacts'
import { readSessionFolders } from './sessionFolders'
import { appendHistoryEntry } from './sessionHistory'
import { mutateSession, sessionDocumentOf } from './sessions'
import { afterTurn } from './sessionTitle'
import type { AgentFollowUpTag } from '@/types/agentSessionIpc'
import type { ArtifactMediaType, HistoryArtifact } from '@/types/sessionIpc'

const MEDIA_TYPES: Record<string, ArtifactMediaType> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.bmp': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.wav': 'audio',
  '.mp3': 'audio',
  '.ogg': 'audio',
  '.flac': 'audio',
  '.m4a': 'audio',
  '.glb': 'model3d',
  '.gltf': 'model3d',
  '.obj': 'model3d',
}

export type AgentTurnInSession = {
  sessionRef: string
  presetName: string
  workspaceDir: string
  prompt: string
  harnessSessionId: string
  /** The harness turn, stamped on the entry so delete/regenerate can remove it. */
  turnId: string
  taskRun?: { taskName: string; input?: string }
  followUp?: AgentFollowUpTag
}

/** An Agent Run is recorded as what was run, not as the run prompt holding every Step. */
function recordedPrompt(turn: AgentTurnInSession): string {
  if (!turn.taskRun) return turn.prompt
  const { taskName, input } = turn.taskRun
  return input?.trim() ? `Run Agent ${taskName}: ${input.trim()}` : `Run Agent ${taskName}`
}

async function artifactsOf(sessionId: string, files: string[]): Promise<HistoryArtifact[]> {
  const list = await readSessionFolders(sessionId)
  return files.flatMap((file) => {
    const mediaType = MEDIA_TYPES[path.extname(file).toLowerCase()]
    const reference = mediaType ? artifactReferenceOf(file, list) : null
    return reference && mediaType ? [{ ...reference, mediaType }] : []
  })
}

/** Collects an agent turn's media while it runs; only files in the Session's folders count. */
export function trackAgentTurnInSession(turn: AgentTurnInSession): {
  settle: (end: AgentTurnEnd) => Promise<void>
} {
  const workspace = path.resolve(turn.workspaceDir)
  const files: string[] = []
  const prompt = recordedPrompt(turn)
  const stop = onGeneratedMedia((workspaceDir, relativePaths, sessionCopies) => {
    if (path.resolve(workspaceDir) !== workspace) return
    const saved =
      sessionCopies.length > 0
        ? sessionCopies
        : relativePaths.map((relativePath) => path.resolve(workspace, relativePath))
    for (const file of saved.map((saved) => path.resolve(saved))) {
      if (!files.includes(file)) files.push(file)
    }
  })
  return {
    settle: async (end) => {
      stop()
      try {
        const artifacts = await artifactsOf(turn.sessionRef, files)
        await appendHistoryEntry(turn.sessionRef, {
          preset: turn.presetName,
          kind: 'agent',
          prompt,
          status: end.outcome,
          artifacts,
          ...(end.outcome === 'completed' && end.reply ? { response: end.reply } : {}),
          harnessSessionId: turn.harnessSessionId,
          turnId: turn.turnId,
          ...(turn.taskRun ? { taskName: turn.taskRun.taskName } : {}),
          ...(turn.followUp ? { ...turn.followUp, followUp: true } : {}),
        })
        const file = await mutateSession(turn.sessionRef, (current) => ({
          ...current,
          ...afterTurn(current, { kind: 'agent', preset: turn.presetName, prompt }),
          updatedAt: Math.max(Date.now(), current.updatedAt),
        }))
        emitSessionChanged(sessionDocumentOf(file))
      } catch (error) {
        appLoggerInstance.warn(`agent turn not recorded in its Session: ${error}`, 'sessions')
      }
    },
  }
}
