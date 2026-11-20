import type { InvokeHandlerMap, SessionsInvokeName } from '../ipcRegistries'
import { ipcFail } from '../typedIpc'
import type { recordAudioTurn } from '../../session/sessionAudioTurn'
import type { lastTurnPreset } from '../../session/sessionHistory'
import {
  SESSION_BUSY_MESSAGE,
  type claimSessionTurn,
  type releaseSessionTurn,
} from '../../session/sessionTurns'
import {
  ArtifactMediaTypeSchema,
  AudioTurnRequestSchema,
  HarnessGameWorkspaceSchema,
  SessionTurnSchema,
  type AssistantCapabilityDefaults,
  type SessionCreateOptions,
} from '@/types/sessionIpc'
import type {
  createSession,
  createSessionGroup,
  deleteSession,
  deleteSessionGroup,
  sessionDeletePreview,
  listSessionGroups,
  listSessions,
  moveSessionToGroup,
  openSession,
  readShowMore,
  setShowMore,
  pinSession,
  pickSessionAgent,
  renameSession,
  renameSessionGroup,
  setSessionGroupExpanded,
} from '../../session/sessions'
import type {
  deleteArtifact,
  listAllArtifacts,
  missingArtifactUrls,
  newestArtifact,
} from '../../session/sessionArtifacts'
import type { harnessSessionFor } from '../../session/sessionHarness'
import type { setRealShellFolders, setSessionReachable } from '../../session/sessionChannels'
import type { migrateHomeAgentThreads } from '../../session/homeAgentThreadMigration'
import type { taskRunHarnessFor } from '../../session/sessionTaskRuns'
import type {
  addHiddenMessages,
  clearAllHiddenMessages,
  clearHiddenMessages,
  removeTimelineMessages,
  upsertTimelineMessages,
} from '../../session/sessionTimeline'
import type {
  addSessionFolder,
  locateSessionWorkspace,
  removeSessionFolder,
  setSessionFolderAccess,
  starSessionFolder,
  startNewSessionWorkspace,
} from '../../session/sessionFolders'
import type {
  assertSessionWorkspacePresent,
  missingSessionWorkspace,
} from '../../session/sessionWorkspace'
import type { ChatTranscriptMessage, saveChatTranscript } from '../../session/sessionChatTurn'
import type { readSessionSettings, writePresetSettings } from '../../session/sessionSettings'
import { groupNameProblemOf } from '@/lib/sessionGroupName'
import { PresetSessionSettingsSchema } from '@/types/sessionSettings'

export type SessionsDeps = {
  listSessions: typeof listSessions
  createSession: typeof createSession
  openSession: typeof openSession
  renameSession: typeof renameSession
  pinSession: typeof pinSession
  setSessionReachable: typeof setSessionReachable
  setRealShellFolders: typeof setRealShellFolders
  migrateHomeAgentThreads: typeof migrateHomeAgentThreads
  pickSessionAgent: typeof pickSessionAgent
  addSessionFolder: typeof addSessionFolder
  removeSessionFolder: typeof removeSessionFolder
  setSessionFolderAccess: typeof setSessionFolderAccess
  starSessionFolder: typeof starSessionFolder
  missingSessionWorkspace: typeof missingSessionWorkspace
  locateSessionWorkspace: typeof locateSessionWorkspace
  startNewSessionWorkspace: typeof startNewSessionWorkspace
  assertSessionWorkspacePresent: typeof assertSessionWorkspacePresent
  /** Shows a listed folder in the OS file manager; the app-created Workspace is created first. */
  openSessionFolder: (id: string, folderId?: string) => Promise<void>
  listSessionGroups: typeof listSessionGroups
  createSessionGroup: typeof createSessionGroup
  moveSessionToGroup: typeof moveSessionToGroup
  renameSessionGroup: typeof renameSessionGroup
  deleteSessionGroup: typeof deleteSessionGroup
  setSessionGroupExpanded: typeof setSessionGroupExpanded
  readShowMore: typeof readShowMore
  setShowMore: typeof setShowMore
  deleteSession: typeof deleteSession
  sessionDeletePreview: typeof sessionDeletePreview
  recordAudioTurn: typeof recordAudioTurn
  listAllArtifacts: typeof listAllArtifacts
  missingArtifactUrls: typeof missingArtifactUrls
  deleteArtifact: typeof deleteArtifact
  readSessionSettings: typeof readSessionSettings
  writePresetSettings: typeof writePresetSettings
  newestArtifact: typeof newestArtifact
  harnessSessionFor: typeof harnessSessionFor
  taskRunHarnessFor: typeof taskRunHarnessFor
  upsertTimelineMessages: typeof upsertTimelineMessages
  removeTimelineMessages: typeof removeTimelineMessages
  addHiddenMessages: typeof addHiddenMessages
  clearHiddenMessages: typeof clearHiddenMessages
  clearAllHiddenMessages: typeof clearAllHiddenMessages
  lastTurnPreset: typeof lastTurnPreset
  claimSessionTurn: typeof claimSessionTurn
  releaseSessionTurn: typeof releaseSessionTurn
  saveChatTranscript: typeof saveChatTranscript
}

function timelineMessages(value: unknown): { id: string }[] {
  if (!Array.isArray(value)) throw new Error('timeline messages must be an array')
  for (const message of value) {
    if (typeof (message as { id?: unknown } | null)?.id !== 'string') {
      throw new Error('every timeline message needs an id')
    }
  }
  return value as { id: string }[]
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} must be a string`)
  return value
}

function defaultCapabilitiesOption(defaults: unknown): AssistantCapabilityDefaults {
  if (defaults === undefined) return {}
  if (!isStringArray(defaults)) throw new Error('default capabilities must be strings')
  return { defaultCapabilities: defaults }
}

function createOptions(options: unknown): SessionCreateOptions {
  const { defaultCapabilities, settingsFrom } = (options ?? {}) as Record<string, unknown>
  return {
    ...defaultCapabilitiesOption(defaultCapabilities),
    ...(settingsFrom === undefined
      ? {}
      : { settingsFrom: requireString(settingsFrom, 'source session id') }),
  }
}

function groupNameFail(e: unknown) {
  const nameProblem = groupNameProblemOf(e)
  return nameProblem ? { ...ipcFail(e), nameProblem } : ipcFail(e)
}

export function buildSessionsRegistry(deps: SessionsDeps) {
  return {
    'sessions:list': async () => {
      try {
        const [sessions, groups, showMore] = await Promise.all([
          deps.listSessions(),
          deps.listSessionGroups(),
          deps.readShowMore(),
        ])
        return { success: true as const, sessions, groups, showMore }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:create': async (_event, groupId, options) => {
      try {
        const session = await deps.createSession(
          groupId === undefined ? undefined : requireString(groupId, 'group id'),
          createOptions(options),
        )
        return { success: true as const, session }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:open': async (_event, id) => {
      try {
        const sessionId = requireString(id, 'session id')
        const [session, missingFiles, lastPreset] = await Promise.all([
          deps.openSession(sessionId),
          deps.missingArtifactUrls(sessionId),
          deps.lastTurnPreset(sessionId),
        ])
        return { success: true as const, session, missingFiles, lastPreset }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:rename': async (_event, id, title) => {
      try {
        const session = await deps.renameSession(
          requireString(id, 'session id'),
          requireString(title, 'title'),
        )
        return { success: true as const, session }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:setReachable': async (_event, id, reachable, options) => {
      try {
        if (typeof reachable !== 'boolean') throw new Error('reachable must be a boolean')
        const session = await deps.setSessionReachable(
          requireString(id, 'session id'),
          reachable,
          defaultCapabilitiesOption(options?.defaultCapabilities),
        )
        return { success: true as const, session }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:migrateHomeAgentThreads': async (_event, input) => {
      try {
        const routingKey = input?.routingKey ?? null
        if (routingKey !== null) requireString(routingKey, 'routing key')
        const { channelSession } = await deps.migrateHomeAgentThreads({
          routingKey,
          ...defaultCapabilitiesOption(input?.defaultCapabilities),
        })
        return { success: true as const, channelSession }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:setRealShellFolders': async (_event, folders) => {
      try {
        if (!isStringArray(folders)) throw new Error('folders must be strings')
        await deps.setRealShellFolders(folders)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:addFolder': async (_event, id, hostPath) => {
      try {
        const added = await deps.addSessionFolder(
          requireString(id, 'session id'),
          requireString(hostPath, 'folder'),
        )
        return { success: true as const, ...added }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:removeFolder': async (_event, id, folderId) => {
      try {
        const list = await deps.removeSessionFolder(
          requireString(id, 'session id'),
          requireString(folderId, 'folder id'),
        )
        return { success: true as const, list }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:setFolderAccess': async (_event, id, folderId, access) => {
      try {
        if (access !== 'read-only' && access !== 'read-write') {
          throw new Error('access must be read-only or read-write')
        }
        const list = await deps.setSessionFolderAccess(
          requireString(id, 'session id'),
          requireString(folderId, 'folder id'),
          access,
        )
        return { success: true as const, list }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:starFolder': async (_event, id, folderId) => {
      try {
        const starred = await deps.starSessionFolder(
          requireString(id, 'session id'),
          requireString(folderId, 'folder id'),
        )
        return { success: true as const, ...starred }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:missingWorkspace': async (_event, id) => {
      try {
        const missing = await deps.missingSessionWorkspace(requireString(id, 'session id'))
        return { success: true as const, missing }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:locateWorkspace': async (_event, id, hostPath) => {
      try {
        const located = await deps.locateSessionWorkspace(
          requireString(id, 'session id'),
          requireString(hostPath, 'folder'),
        )
        return { success: true as const, ...located }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:startNewWorkspace': async (_event, id) => {
      try {
        return {
          success: true as const,
          ...(await deps.startNewSessionWorkspace(requireString(id, 'session id'))),
        }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:openFolder': async (_event, id, folderId) => {
      try {
        await deps.openSessionFolder(
          requireString(id, 'session id'),
          folderId === undefined ? undefined : requireString(folderId, 'folder id'),
        )
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:pin': async (_event, id, pinned) => {
      try {
        if (typeof pinned !== 'boolean') throw new Error('pinned must be a boolean')
        const session = await deps.pinSession(requireString(id, 'session id'), pinned)
        return { success: true as const, session }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:pickAgent': async (_event, id, agentId) => {
      try {
        const session = await deps.pickSessionAgent(
          requireString(id, 'session id'),
          agentId === null ? null : requireString(agentId, 'agent id'),
        )
        return { success: true as const, session }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:createGroup': async (_event, id, name) => {
      try {
        const created = await deps.createSessionGroup(
          requireString(id, 'session id'),
          requireString(name, 'group name'),
        )
        return { success: true as const, ...created }
      } catch (e) {
        return groupNameFail(e)
      }
    },
    'sessions:moveToGroup': async (_event, id, groupId) => {
      try {
        const session = await deps.moveSessionToGroup(
          requireString(id, 'session id'),
          groupId === null ? null : requireString(groupId, 'group id'),
        )
        return { success: true as const, session }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:renameGroup': async (_event, groupId, name) => {
      try {
        const group = await deps.renameSessionGroup(
          requireString(groupId, 'group id'),
          requireString(name, 'group name'),
        )
        return { success: true as const, group }
      } catch (e) {
        return groupNameFail(e)
      }
    },
    'sessions:deleteGroup': async (_event, groupId) => {
      try {
        await deps.deleteSessionGroup(requireString(groupId, 'group id'))
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:setGroupExpanded': async (_event, groupId, expanded) => {
      try {
        if (typeof expanded !== 'boolean') throw new Error('expanded must be a boolean')
        const group = await deps.setSessionGroupExpanded(
          requireString(groupId, 'group id'),
          expanded,
        )
        return { success: true as const, group }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:setShowMore': async (_event, section, shown) => {
      try {
        if (section !== 'pinned' && section !== 'older') throw new Error('unknown section')
        if (typeof shown !== 'boolean') throw new Error('show more must be a boolean')
        await deps.setShowMore(section, shown)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:delete': async (_event, id) => {
      try {
        await deps.deleteSession(requireString(id, 'session id'))
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:deletePreview': async (_event, id) => {
      try {
        return {
          success: true as const,
          preview: await deps.sessionDeletePreview(requireString(id, 'session id')),
        }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:harnessSession': async (_event, id, presetName, game) => {
      try {
        const harness = await deps.harnessSessionFor(
          requireString(id, 'session id'),
          requireString(presetName, 'preset name'),
          game === undefined ? undefined : HarnessGameWorkspaceSchema.parse(game),
        )
        return { success: true as const, harness }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:taskRunHarness': async (_event, id) => {
      try {
        const harness = await deps.taskRunHarnessFor(requireString(id, 'session id'))
        return { success: true as const, harness }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:saveTimelineMessages': async (_event, id, messages) => {
      try {
        await deps.upsertTimelineMessages(
          requireString(id, 'session id'),
          timelineMessages(messages),
        )
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:removeTimelineMessages': async (_event, id, messageIds) => {
      try {
        if (!isStringArray(messageIds)) throw new Error('message ids must be strings')
        await deps.removeTimelineMessages(requireString(id, 'session id'), messageIds)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:addHiddenMessages': async (_event, id, messageIds) => {
      try {
        if (!isStringArray(messageIds)) throw new Error('message ids must be strings')
        await deps.addHiddenMessages(requireString(id, 'session id'), messageIds)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:clearHiddenMessages': async (_event, id) => {
      try {
        await deps.clearHiddenMessages(requireString(id, 'session id'))
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:clearAllHiddenMessages': async (_event) => {
      try {
        await deps.clearAllHiddenMessages()
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:saveChatTranscript': async (_event, id, messages) => {
      try {
        await deps.saveChatTranscript(
          requireString(id, 'session id'),
          timelineMessages(messages) as ChatTranscriptMessage[],
        )
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:recordAudioTurn': async (_event, turn) => {
      try {
        const session = await deps.recordAudioTurn(AudioTurnRequestSchema.parse(turn))
        return { success: true as const, session }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:listArtifacts': async () => {
      try {
        return { success: true as const, artifacts: await deps.listAllArtifacts() }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:deleteArtifact': async (_event, id, url) => {
      try {
        await deps.deleteArtifact(
          requireString(id, 'session id'),
          requireString(url, 'artifact url'),
        )
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:readSettings': async (_event, id) => {
      try {
        return {
          success: true as const,
          settings: await deps.readSessionSettings(requireString(id, 'session id')),
        }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:writePresetSettings': async (_event, id, presetName, entry) => {
      try {
        await deps.writePresetSettings(
          requireString(id, 'session id'),
          requireString(presetName, 'preset name'),
          PresetSessionSettingsSchema.parse(entry),
        )
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:beginTurn': async (_event, id, turn) => {
      try {
        await deps.assertSessionWorkspacePresent(requireString(id, 'session id'))
        const claimed = deps.claimSessionTurn(
          requireString(id, 'session id'),
          SessionTurnSchema.parse(turn),
        )
        return claimed
          ? { success: true as const }
          : { success: false as const, error: SESSION_BUSY_MESSAGE }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:endTurn': async (_event, id, turnId) => {
      try {
        deps.releaseSessionTurn(requireString(id, 'session id'), requireString(turnId, 'turn id'))
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:newestArtifact': async (_event, id, mediaType) => {
      try {
        const artifact = await deps.newestArtifact(
          requireString(id, 'session id'),
          ArtifactMediaTypeSchema.parse(mediaType),
        )
        return { success: true as const, artifact }
      } catch (e) {
        return ipcFail(e)
      }
    },
  } satisfies InvokeHandlerMap<SessionsInvokeName>
}
