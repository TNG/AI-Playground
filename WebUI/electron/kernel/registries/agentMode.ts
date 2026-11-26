import {
  AgentModeTurnConfigSchema,
  DeleteAgentTurnsRequestSchema,
  SESSION_FILE_ACTIONS,
} from '@/types/agentIpc'
import { AgentSessionRecordSchema, LegacyAgentSessionStateSchema } from '@/types/agentSessionIpc'
import type { AgentModeInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { ipcErrorText, ipcFail } from '../typedIpc'
import type {
  cancelAgentTurn,
  deleteAgentSession,
  deleteAgentTurns,
  listAgentCapabilities,
  resetAgentSession,
  startAgentTurn,
  submitAgentToolResult,
} from '../../agent/piAgentManager'
import type { importAttachment } from '../../agent/workspaceAttachments'
import type { attachmentsFolderFor } from '../../session/sessionAttachments'
import type {
  indexSessionDocument,
  removeSessionDocument,
  sessionDocuments,
} from '../../agent/sessionDocuments'
import type { workspaceMediaFileActions } from '../../agent/workspaceMediaFile'
import type { sessionFileActions, sessionFileReader } from '../../agent/sessionFileAction'
import type {
  bootstrapAgentSessions,
  deleteAgentSessionRecord,
  migrateLegacyAgentSessions,
  saveAgentSession,
  saveAgentSessionActiveId,
} from '../../persist/agentSessionFiles'
import type {
  migrateAgentWorkspaceState,
  readAgentWorkspaceState,
  writeAgentWorkspaceState,
} from '../../persist/workspaceStateFiles'
import type {
  deleteAgentDraft,
  deleteAgentTask,
  readAgentDrafts,
  readAgentTasks,
  saveAgentDraft,
  saveAgentTask,
} from '../../persist/agentTaskFiles'
import type { openAgentTaskFolder } from '../../agent/agentTaskFolders'
import type { forgetHarnessSessionMessages } from '../../persist/channelMessageMap'
import type {
  discardTrialRun,
  readTrialRuns,
  saveTrialRun,
  trialRunHarnessFor,
} from '../../agent/trialRuns'
import type { appLoggerInstance } from '../../observability/logger'

/** The Pi manager, session-record, workspace-state and Tasks seams the agentMode handlers close over. */
export type AgentModeDeps = {
  startAgentTurn: typeof startAgentTurn
  cancelAgentTurn: typeof cancelAgentTurn
  resetAgentSession: typeof resetAgentSession
  deleteAgentSession: typeof deleteAgentSession
  deleteAgentTurns: typeof deleteAgentTurns
  submitAgentToolResult: typeof submitAgentToolResult
  listAgentCapabilities: typeof listAgentCapabilities
  importAttachment: typeof importAttachment
  attachmentsFolderFor: typeof attachmentsFolderFor
  sessionDocuments: typeof sessionDocuments
  indexSessionDocument: typeof indexSessionDocument
  removeSessionDocument: typeof removeSessionDocument
  mediaFileAction: ReturnType<typeof workspaceMediaFileActions>
  sessionFileAction: ReturnType<typeof sessionFileActions>
  readSessionFile: ReturnType<typeof sessionFileReader>
  openWorkspaceFolder: (dir: string) => Promise<void>
  bootstrapAgentSessions: typeof bootstrapAgentSessions
  migrateLegacyAgentSessions: typeof migrateLegacyAgentSessions
  saveAgentSession: typeof saveAgentSession
  saveAgentSessionActiveId: typeof saveAgentSessionActiveId
  deleteAgentSessionRecord: typeof deleteAgentSessionRecord
  readAgentWorkspaceState: typeof readAgentWorkspaceState
  migrateAgentWorkspaceState: typeof migrateAgentWorkspaceState
  writeAgentWorkspaceState: typeof writeAgentWorkspaceState
  readAgentTasks: typeof readAgentTasks
  saveAgentTask: typeof saveAgentTask
  deleteAgentTask: typeof deleteAgentTask
  openAgentTaskFolder: typeof openAgentTaskFolder
  readAgentDrafts: typeof readAgentDrafts
  saveAgentDraft: typeof saveAgentDraft
  deleteAgentDraft: typeof deleteAgentDraft
  trialRunHarnessFor: typeof trialRunHarnessFor
  discardTrialRun: typeof discardTrialRun
  readTrialRuns: typeof readTrialRuns
  saveTrialRun: typeof saveTrialRun
  forgetHarnessSessionMessages: typeof forgetHarnessSessionMessages
  appLogger: typeof appLoggerInstance
}

export function buildAgentModeRegistry(deps: AgentModeDeps) {
  // Agent Mode (Pi coding agent) — see agent/piAgentManager.ts. Stream chunks
  // and live tool output cross the kernel event bus (electron/kernel/kernelBus.ts)
  // as 'agent-chunk' / 'agent-tool-progress' / 'agent-tool-image' /
  // 'agent-turn-done' events.
  return {
    // Agent-session records (step 8, §6.1): same one-writer contract as the
    // conversations family — the record file and its index entry live here,
    // Pi's own session files stay with Pi. Deletes fold into
    // `agentMode:deleteSession`, next to the Pi-side teardown.
    'agentMode:bootstrapSessions': async () => {
      try {
        return await deps.bootstrapAgentSessions()
      } catch (e) {
        return { status: 'error' as const, error: ipcErrorText(e) }
      }
    },
    'agentMode:migrateSessions': async (_event, payload) => {
      try {
        return await deps.migrateLegacyAgentSessions(LegacyAgentSessionStateSchema.parse(payload))
      } catch (e) {
        return { status: 'error' as const, error: ipcErrorText(e) }
      }
    },
    'agentMode:saveSession': async (_event, payload) => {
      try {
        await deps.saveAgentSession(AgentSessionRecordSchema.parse(payload))
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:saveActiveSessionId': async (_event, id) => {
      try {
        if (typeof id !== 'string' && id !== null) {
          throw new Error('activeSessionId must be a string or null')
        }
        await deps.saveAgentSessionActiveId(id)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:startTurn': async (_event, turnId, prompt, config) => {
      const parsed = AgentModeTurnConfigSchema.safeParse(config)
      if (!parsed.success) {
        return { success: false, error: parsed.error.message }
      }
      return await deps.startAgentTurn(turnId, prompt, parsed.data)
    },
    'agentMode:cancel': (_event, sessionId, turnId) => {
      if (typeof sessionId !== 'string') return
      deps.cancelAgentTurn(sessionId, typeof turnId === 'string' ? turnId : undefined)
    },
    'agentMode:resetSession': async () => {
      await deps.resetAgentSession()
    },
    // Step 8 (§6.1): the last-used workspace pointers are kernel-owned
    // (agent-workspace.json); the store becomes a live projection.
    'agentMode:readWorkspaceState': async () => {
      try {
        return { success: true as const, section: await deps.readAgentWorkspaceState() }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:migrateWorkspaceState': async (_event, payload) => {
      try {
        await deps.migrateAgentWorkspaceState(payload)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:writeWorkspaceState': async (_event, value) => {
      try {
        await deps.writeAgentWorkspaceState(value)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:readTasks': async () => {
      try {
        return { success: true as const, tasks: await deps.readAgentTasks() }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:saveTask': async (_event, task) => {
      try {
        await deps.saveAgentTask(task)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:deleteTask': async (_event, id) => {
      try {
        await deps.deleteAgentTask(id)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:openTaskFolder': async (_event, taskId, hostPath) => {
      try {
        await deps.openAgentTaskFolder(taskId, hostPath)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:readDrafts': async () => {
      try {
        return { success: true as const, drafts: await deps.readAgentDrafts() }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:saveDraft': async (_event, draft) => {
      try {
        await deps.saveAgentDraft(draft)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:deleteDraft': async (_event, agentId) => {
      try {
        await deps.deleteAgentDraft(agentId)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:trialRunHarness': async (_event, agentId) => {
      try {
        return { success: true as const, harness: await deps.trialRunHarnessFor(agentId) }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:discardTrialRun': async (_event, agentId) => {
      try {
        await deps.discardTrialRun(agentId)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:readTrialRuns': async () => {
      try {
        return { success: true as const, trialRuns: await deps.readTrialRuns() }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:saveTrialRun': async (_event, run) => {
      try {
        await deps.saveTrialRun(run)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:deleteTurns': async (_event, request) => {
      try {
        await deps.deleteAgentTurns(DeleteAgentTurnsRequestSchema.parse(request))
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:deleteSession': async (_event, sessionId) => {
      // Both halves run even if one fails. Invalid ids return `{success:false}`.
      try {
        if (typeof sessionId !== 'string') throw new Error('session id must be a string')
        const record = await deps.deleteAgentSessionRecord(sessionId)
        const live = await deps.deleteAgentSession(sessionId)
        if (!record.success) return record
        if (!live.success) return live
        // A tombstone, not a removal: an Answer to its messages is told the session is gone.
        await deps
          .forgetHarnessSessionMessages(sessionId)
          .catch((e) =>
            deps.appLogger.warn(
              `channel messages of deleted session ${sessionId} not forgotten: ${ipcErrorText(e)}`,
              'agent-mode',
            ),
          )
        return live
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:importAttachment': (_event, target, name, bytes) => {
      try {
        const folder = deps.attachmentsFolderFor(target)
        return { success: true as const, ...deps.importAttachment(folder, name, bytes) }
      } catch (error) {
        return ipcFail(error)
      }
    },
    'agentMode:sessionDocuments': (_event, target) =>
      deps.sessionDocuments(deps.attachmentsFolderFor(target)),
    'agentMode:indexDocument': async (_event, target, relativePath, embedding) => {
      try {
        await deps.indexSessionDocument(deps.attachmentsFolderFor(target), relativePath, embedding)
        return { success: true as const }
      } catch (error) {
        return ipcFail(error)
      }
    },
    'agentMode:removeSessionDocument': async (_event, target, relativePath) => {
      try {
        await deps.removeSessionDocument(deps.attachmentsFolderFor(target), relativePath)
        return { success: true as const }
      } catch (error) {
        return ipcFail(error)
      }
    },
    // File actions on a transcript's generated media (see agent/workspaceMediaFile.ts).
    'agentMode:mediaFileAction': (event, ref, action) => {
      const valid =
        typeof ref?.sessionId === 'string' &&
        typeof ref.appCopy === 'string' &&
        (ref.workspacePath === undefined || typeof ref.workspacePath === 'string') &&
        ['open', 'reveal', 'drag', 'saveAs'].includes(action)
      if (!valid) return { success: false, error: 'invalid media file request' }
      return deps.mediaFileAction(event.sender, ref, action)
    },
    'agentMode:openWorkspaceFolder': async (_event, dir) => {
      if (typeof dir !== 'string' || !dir) return { success: false, error: 'invalid folder' }
      try {
        await deps.openWorkspaceFolder(dir)
        return { success: true }
      } catch (error) {
        return ipcFail(error)
      }
    },
    // Open, reveal or delete a file an agent turn wrote, as its answer references it
    // (see agent/sessionFileAction.ts).
    'agentMode:sessionFileAction': (_event, sessionId, filePath, action) => {
      const valid =
        typeof sessionId === 'string' &&
        typeof filePath === 'string' &&
        (SESSION_FILE_ACTIONS as readonly string[]).includes(action)
      if (!valid) return { success: false, error: 'invalid file request' }
      return deps.sessionFileAction(sessionId, filePath, action)
    },
    // Read a written file as text for the transcript's inline preview
    // (see agent/sessionFileAction.ts).
    'agentMode:readSessionFile': (_event, sessionId, filePath, full) => {
      const valid =
        typeof sessionId === 'string' &&
        typeof filePath === 'string' &&
        !!filePath &&
        (full === undefined || typeof full === 'boolean')
      if (!valid) return { success: false, error: 'invalid file request' }
      return deps.readSessionFile(sessionId, filePath, full)
    },
    // What the agent can be equipped with, for the Capabilities checkboxes in
    // Agent Settings (availability depends on the turn's tool specs / MCP config).
    'agentMode:listCapabilities': (_event, options) => {
      return deps.listAgentCapabilities(options ?? {})
    },
    // Renderer answers a main→renderer 'agentMode:executeTool' dispatch (bridged
    // host tool execution, e.g. image generation) with the tool result or error.
    'agentMode:toolResult': (_event, requestId, result, error) => {
      return deps.submitAgentToolResult(requestId, result, error)
    },
  } satisfies InvokeHandlerMap<AgentModeInvokeName>
}
