import type { UIMessage } from 'ai'
import { computed, type Ref } from 'vue'
import { currentPresetName } from '@/lib/presetRenames'
import { MCP_CAPABILITY_PREFIX } from '@/types/agentCapabilities'

export type AgentSessionRecord = {
  id: string
  workspaceDir: string
  /** Derived from the first user message (see deriveSessionTitle). */
  title: string
  messages: UIMessage[]
  createdAt: number
  updatedAt: number
  /**
   * Capability ids the session runs with. Frozen when the session starts, so
   * changing the defaults never re-equips an ongoing conversation behind the
   * user's back (it would also restart its Pi session).
   */
  capabilities?: string[]
  /**
   * The agent preset the conversation was held with (Agent, Game Agent). A
   * session only makes sense under it — the instructions, capabilities and
   * surrounding UI all come from the preset — so resuming one switches back to
   * it, and the Sessions panel only lists the active preset's own sessions.
   * Absent on sessions archived before presets drove Agent Mode.
   */
  presetName?: string
}

/**
 * The two agent presets sessions can predate `presetName` (see
 * `migrateSessionPresets`). Named rather than looked up, because the migration
 * runs on hydration, before the preset catalog is loaded.
 */
export const GAME_AGENT_PRESET = 'Game Agent'
export const AGENT_PRESET = 'Agent'

export function mintSessionId(): string {
  return `aipg-agent-${crypto.randomUUID()}`
}

export function deriveSessionTitle(sessionMessages: UIMessage[]): string {
  const firstUser = sessionMessages.find((m) => m.role === 'user')
  const text =
    firstUser?.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join(' ')
      .trim() ?? ''
  if (!text) return 'New session'
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

export function listPresetSessions(
  sessions: Record<string, AgentSessionRecord>,
  agentPresetName: string,
): AgentSessionRecord[] {
  return Object.values(sessions).filter(
    (session) => !session.presetName || session.presetName === agentPresetName,
  )
}

export function migrateMcpServerIdsIntoCapabilities(
  mcpServerIds: string[],
  defaultCapabilities: string[],
): { mcpServerIds: string[]; defaultCapabilities: string[] } {
  if (mcpServerIds.length === 0) {
    return { mcpServerIds, defaultCapabilities }
  }
  const migrated = mcpServerIds.map((serverId) => `${MCP_CAPABILITY_PREFIX}${serverId}`)
  return {
    mcpServerIds: [],
    defaultCapabilities: [...new Set([...defaultCapabilities, ...migrated])],
  }
}

/**
 * Name every session the preset it was really held with. Sessions archived
 * before presets drove Agent Mode name none; the workspace folder says which
 * they were: a folder in the game library was the game preset's, anything else
 * was the folder-picking Agent.
 */
export function applySessionPresetNames(
  sessions: Record<string, AgentSessionRecord>,
  gameFolders: Set<string>,
): Record<string, AgentSessionRecord> {
  const renamed = Object.values(sessions).filter(
    (session) => session.presetName && currentPresetName(session.presetName) !== session.presetName,
  )
  const legacy = Object.values(sessions).filter((session) => !session.presetName)
  if (legacy.length === 0 && renamed.length === 0) return sessions
  const next = { ...sessions }
  for (const session of renamed) {
    next[session.id] = {
      ...session,
      presetName: currentPresetName(session.presetName!),
    }
  }
  for (const session of legacy) {
    next[session.id] = {
      ...session,
      presetName: gameFolders.has(session.workspaceDir) ? GAME_AGENT_PRESET : AGENT_PRESET,
    }
  }
  return next
}

export function snapshotSession(options: {
  id: string
  workspaceDir: string
  messages: UIMessage[]
  existing?: AgentSessionRecord
  capabilities: string[]
  presetName: string
}): AgentSessionRecord | null {
  const plainMessages = JSON.parse(JSON.stringify(options.messages)) as UIMessage[]
  if (plainMessages.length === 0) return null
  return {
    id: options.id,
    workspaceDir: options.existing?.workspaceDir ?? options.workspaceDir,
    title: deriveSessionTitle(plainMessages),
    messages: plainMessages,
    createdAt: options.existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    capabilities: options.existing?.capabilities ?? [...options.capabilities],
    presetName: options.existing?.presetName ?? options.presetName,
  }
}

/**
 * Lift Agent Mode's planning-thinking switch out of chat `settingsPerPreset`.
 * Returns the value to keep (preferring `preferredKey`) and bags with the key
 * stripped so later hydrations do not overwrite the Agent Mode persist copy.
 */
export function takeLegacyPlanningThinkingOnly(
  bags: Record<string, Record<string, unknown>>,
  preferredKey: string,
): { value?: boolean; bags: Record<string, Record<string, unknown>> } {
  let value: boolean | undefined
  const preferred = bags[preferredKey]?.planningThinkingOnly
  if (typeof preferred === 'boolean') value = preferred
  else {
    for (const bag of Object.values(bags)) {
      if (typeof bag?.planningThinkingOnly === 'boolean') {
        value = bag.planningThinkingOnly
        break
      }
    }
  }
  let stripped = false
  const next: Record<string, Record<string, unknown>> = {}
  for (const [key, bag] of Object.entries(bags)) {
    if (bag && 'planningThinkingOnly' in bag) {
      const { planningThinkingOnly: _removed, ...rest } = bag
      next[key] = rest
      stripped = true
    } else {
      next[key] = bag
    }
  }
  return { value, bags: stripped ? next : bags }
}

export function toggleCapabilityIds(current: string[], id: string, enabled: boolean): string[] {
  return enabled ? [...new Set([...current, id])] : current.filter((entry) => entry !== id)
}

export function ensureSessionId(activeSessionId: Ref<string>): string {
  if (!activeSessionId.value) activeSessionId.value = mintSessionId()
  return activeSessionId.value
}

export function computedPresetSessions(
  sessions: Ref<Record<string, AgentSessionRecord>>,
  agentPresetName: Ref<string>,
) {
  return computed(() => listPresetSessions(sessions.value, agentPresetName.value))
}
