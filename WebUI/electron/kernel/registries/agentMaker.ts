import type { AgentMakerInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { ipcErrorText, ipcFail } from '../typedIpc'
import { AgentTaskSchema } from '@/types/agentMakerIpc'
import type {
  bootstrapAgentMaker,
  deleteAgentTask,
  deleteRunWorkspace,
  mintRunWorkspace,
  saveAgentTask,
} from '../../persist/agentMakerFiles'
import type { saveAgentSession } from '../../persist/agentSessionFiles'
import { randomUUID } from 'node:crypto'

/**
 * The Agent Maker registry: task definitions are one-writer files under
 * `agent-maker/`; run sessions ride the existing agent-sessions collection
 * (tagged `origin: 'agentMaker'`). `startRun` mints the session record and
 * workspace here, then the renderer drives the step loop through the normal
 * `agentMode:startTurn` path.
 */

export type AgentMakerDeps = {
  bootstrapAgentMaker: typeof bootstrapAgentMaker
  saveAgentTask: typeof saveAgentTask
  deleteAgentTask: typeof deleteAgentTask
  deleteRunWorkspace: typeof deleteRunWorkspace
  mintRunWorkspace: typeof mintRunWorkspace
  saveAgentSession: typeof saveAgentSession
}

function mintRunSessionId(): string {
  return `aipg-agent-${randomUUID()}`
}

export function buildAgentMakerRegistry(deps: AgentMakerDeps) {
  return {
    'agentMaker:bootstrap': async () => {
      try {
        return await deps.bootstrapAgentMaker()
      } catch (e) {
        return { status: 'error' as const, error: ipcErrorText(e) }
      }
    },
    'agentMaker:save': async (_event, payload) => {
      try {
        const parsed = AgentTaskSchema.parse(payload)
        await deps.saveAgentTask(parsed)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMaker:delete': async (_event, taskId) => {
      try {
        if (typeof taskId !== 'string') throw new Error('task id must be a string')
        await deps.deleteAgentTask(taskId)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMaker:deleteRunWorkspace': async (_event, taskId, runId) => {
      try {
        if (typeof taskId !== 'string' || typeof runId !== 'string') {
          throw new Error('task and run ids must be strings')
        }
        await deps.deleteRunWorkspace(taskId, runId)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMaker:startRun': async (_event, taskId) => {
      try {
        if (typeof taskId !== 'string') throw new Error('task id must be a string')
        const bootstrap = await deps.bootstrapAgentMaker()
        if (bootstrap.status !== 'ok') throw new Error('Agent Maker not hydrated')
        const task = bootstrap.tasks.find((t) => t.id === taskId)
        if (!task) throw new Error(`Task not found: ${taskId}`)
        const sessionId = mintRunSessionId()
        const workspaceDir = await deps.mintRunWorkspace(task.slug, sessionId)
        // Save the run session record tagged with origin/taskId/running.
        await deps.saveAgentSession({
          id: sessionId,
          workspaceDir,
          title: task.name,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
          capabilities: [...task.capabilities],
          presetName: 'Agent',
          origin: 'agentMaker',
          taskId: task.id,
          taskRunStatus: 'running',
          taskRunStepIndex: 0,
        })
        return { success: true as const, sessionId, workspaceDir }
      } catch (e) {
        return ipcFail(e)
      }
    },
  } satisfies InvokeHandlerMap<AgentMakerInvokeName>
}
