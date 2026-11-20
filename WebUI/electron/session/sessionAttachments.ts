import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'
import { sessionFolderPaths } from '../persist/sessionFiles'
import { moveLegacyAttachments } from '../persist/sessionLegacyFiles'
import { trialAttachmentsDir } from '../persist/trialRunFiles'
import {
  ATTACHMENTS_DIR,
  SANDBOX_ATTACHMENTS_DIR,
  type AttachmentsFolder,
} from '../agent/workspaceAttachments'
import { listSessions } from './sessions'
import type { AttachmentTarget } from '@/types/agentIpc'
import { isSessionWorkspace } from './sessionWorkspace'

export type { AttachmentTarget }

/** A Session's or Trial Run's attachments stay in app storage whichever folder it works in. */
export function attachmentsFolderFor(target: AttachmentTarget): AttachmentsFolder {
  const { sessionId, workspaceDir, trialAgentId } = target
  if (trialAgentId)
    return { dir: trialAttachmentsDir(trialAgentId), reference: SANDBOX_ATTACHMENTS_DIR }
  if (sessionId && isSessionWorkspace(sessionId, workspaceDir)) {
    return { dir: sessionFolderPaths(sessionId).attachmentsDir, reference: SANDBOX_ATTACHMENTS_DIR }
  }
  return { dir: path.join(workspaceDir, ATTACHMENTS_DIR), reference: ATTACHMENTS_DIR }
}

/** Moves attachments left in a Session's Workspace into its internal storage; idempotent. */
export async function migrateSessionAttachments(): Promise<void> {
  let moved = 0
  for (const session of await listSessions()) {
    try {
      moved += await moveLegacyAttachments(session.id)
    } catch (error) {
      appLoggerInstance.warn(
        `could not move the attachments of ${session.id}: ${String(error)}`,
        'session-attachments',
      )
    }
  }
  if (moved > 0) appLoggerInstance.info(`moved ${moved} attachment(s)`, 'session-attachments')
}
