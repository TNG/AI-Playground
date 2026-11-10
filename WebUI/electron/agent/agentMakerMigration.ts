import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'
import { bootstrapAgentSessions, saveAgentSession } from '../persist/agentSessionFiles'
import { agentMakerMerged, markAgentMakerMerged } from '../persist/agentTaskFiles'
import { listSessions, mutateSession, readSession, sessionPaths } from '../session/sessions'
import { sessionSettingsFromBag } from '@/lib/agentSessionSettings'
import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'
import { mountedFolderRefusal } from '@/lib/mountedFolders'
import { DEFAULT_CAPABILITY_IDS, FILES_CAPABILITY_ID } from '@/types/agentCapabilities'
import type {
  AgentSessionRecordWire,
  AgentSessionSettings,
  MountedFolder,
} from '@/types/agentSessionIpc'
import type { SessionFile } from '@/types/sessionIpc'
import {
  parseSessionSettings,
  type PresetSessionSettings,
  type SessionSettingsBag,
} from '@/types/sessionSettings'

/**
 * Agent Maker (`Agent`) merged into Assistant: its Harness Sessions, Session Settings and
 * records are refiled under Assistant, a folder a session worked in becomes a read-write
 * Mounted Folder, and everything it ran keeps the file and shell tools it always had (the
 * `files` capability). Runs before the window loads; every step but the Agents' is idempotent.
 */

const LOG_SCOPE = 'agent-maker-migration'

export const AGENT_MAKER_PRESET = 'Agent'

const AGENT_MAKER_DEFAULT_CAPABILITY_IDS = ['media', 'web-debug', 'rag', 'web', 'notify']

/** Keys only a chat-engine bag has; an agent-shaped bag never holds them. */
const CHAT_BAG_KEYS = ['selectedModels', 'selectedEmbeddingModels', 'requestedContextSize']

export async function migrateAgentMakerSessions(): Promise<void> {
  const records = await agentMakerRecords()
  let refiled = 0
  for (const session of await listSessions()) {
    if (session.unreadable) continue
    const file = await readSession(session.id)
    const own = records.filter((record) => record.sessionRef === session.id)
    const picked = await pickedFolders(file, own)
    if (!holdsAgentMaker(file, own) && picked.length === 0) continue
    await mutateSession(session.id, (current) => refiledSession(current, own, picked))
    refiled += 1
  }
  for (const record of records) await saveAgentSession(refiledRecord(record))
  if (!(await agentMakerMerged())) await markAgentMakerMerged(templateWithFiles)
  appLoggerInstance.info(
    `refiled ${refiled} session(s) and ${records.length} harness session(s) under ${HARNESS_CHAT_PRESET}`,
    LOG_SCOPE,
  )
}

async function agentMakerRecords(): Promise<AgentSessionRecordWire[]> {
  const boot = await bootstrapAgentSessions()
  if (boot.status !== 'ok') return []
  return boot.sessions.filter((record) => record.presetName === AGENT_MAKER_PRESET)
}

function holdsAgentMaker(file: SessionFile, records: AgentSessionRecordWire[]): boolean {
  return (
    records.length > 0 ||
    AGENT_MAKER_PRESET in file.harnessSessions ||
    AGENT_MAKER_PRESET in file.harnessWorkspaces ||
    AGENT_MAKER_PRESET in file.settings ||
    file.presetsUsed.includes(AGENT_MAKER_PRESET) ||
    chatShapedAssistantBag(parseSessionSettings(file.settings)[HARNESS_CHAT_PRESET]) !== undefined
  )
}

/** Folders a session of this Session worked in other than its Session Folder, still mountable. */
async function pickedFolders(
  file: SessionFile,
  records: AgentSessionRecordWire[],
): Promise<MountedFolder[]> {
  const paths = sessionPaths(file.id)
  const candidates = [
    ...records.filter((record) => !record.taskRun).map((record) => record.workspaceDir),
    file.harnessWorkspaces[AGENT_MAKER_PRESET] ?? '',
  ]
  const picked: MountedFolder[] = []
  for (const dir of candidates) {
    if (!dir || path.resolve(dir) === path.resolve(paths.filesDir)) continue
    const refusal = mountedFolderRefusal(dir, {
      homeFolder: os.homedir(),
      sessionFolder: paths.root,
      mountedFolders: picked,
    })
    if (refusal) {
      appLoggerInstance.warn(`not mounting ${dir} (${refusal.reason})`, LOG_SCOPE)
      continue
    }
    if (!(await isDirectory(dir))) continue
    picked.push({ hostPath: dir, access: 'read-write' })
  }
  return picked
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

export function refiledSession(
  file: SessionFile,
  records: AgentSessionRecordWire[],
  picked: MountedFolder[],
): SessionFile {
  const { [AGENT_MAKER_PRESET]: agentHarness, ...harnessSessions }: Record<string, string> =
    file.harnessSessions
  const { [AGENT_MAKER_PRESET]: _workspace, ...harnessWorkspaces } = file.harnessWorkspaces
  const retired = [...file.retiredHarnessSessions]
  if (agentHarness && harnessSessions[HARNESS_CHAT_PRESET]) retired.push(agentHarness)
  else if (agentHarness) harnessSessions[HARNESS_CHAT_PRESET] = agentHarness
  const interactive = records.find((record) => record.id === agentHarness)
  return {
    ...file,
    presetsUsed: [...new Set(file.presetsUsed.map(renamed))],
    timeline: file.timeline.map(retaggedMessage),
    settings: mergedSettings(file.settings, picked, interactive?.capabilities),
    harnessSessions,
    harnessWorkspaces,
    retiredHarnessSessions: retired,
  }
}

function renamed(presetName: string): string {
  return presetName === AGENT_MAKER_PRESET ? HARNESS_CHAT_PRESET : presetName
}

function retaggedMessage(message: unknown): unknown {
  const metadata = (message as { metadata?: { agentTurn?: { presetName?: string } } } | null)
    ?.metadata
  if (metadata?.agentTurn?.presetName !== AGENT_MAKER_PRESET) return message
  return {
    ...(message as object),
    metadata: {
      ...metadata,
      agentTurn: { ...metadata.agentTurn, presetName: HARNESS_CHAT_PRESET },
    },
  }
}

function chatShapedAssistantBag(
  entry: PresetSessionSettings | undefined,
): { key: string; bag: SessionSettingsBag } | undefined {
  const found = assistantBag(entry)
  if (!found) return undefined
  return CHAT_BAG_KEYS.some((key) => key in found.bag.values) ? found : undefined
}

/** The Assistant bag this Session last used: its variant's, else its own. */
function assistantBag(
  entry: PresetSessionSettings | undefined,
): { key: string; bag: SessionSettingsBag } | undefined {
  if (!entry) return undefined
  const keys = [entry.variant ? `${HARNESS_CHAT_PRESET}:${entry.variant}` : '', HARNESS_CHAT_PRESET]
  const key = keys.find((candidate) => candidate && entry.bags[candidate])
  return key ? { key, bag: entry.bags[key] } : undefined
}

function definedOnly(settings: AgentSessionSettings): AgentSessionSettings {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as AgentSessionSettings
}

/**
 * Assistant's settings win where both presets had one; what only Agent Maker had is kept,
 * and its capabilities gain `files`, the file and shell tools it always ran with.
 */
function mergedSettings(
  raw: Record<string, unknown>,
  picked: MountedFolder[],
  recordCapabilities: string[] | undefined,
): Record<string, unknown> {
  const parsed = parseSessionSettings(raw)
  const agentEntry = parsed[AGENT_MAKER_PRESET]
  const agentBag = agentEntry?.bags[AGENT_MAKER_PRESET]
  const assistantEntry = parsed[HARNESS_CHAT_PRESET]
  const assistant = assistantBag(assistantEntry)
  const chatShaped = chatShapedAssistantBag(assistantEntry) !== undefined
  if (!agentEntry && !chatShaped && picked.length === 0) return raw

  const agentValues = (agentBag?.values ?? {}) as AgentSessionSettings
  const agentCapabilities = agentValues.capabilities ?? recordCapabilities
  const fromAgent: AgentSessionSettings = {
    ...agentValues,
    ...(agentBag || picked.length > 0
      ? { capabilities: withFiles(agentCapabilities ?? [...DEFAULT_CAPABILITY_IDS]) }
      : {}),
  }
  const assistantValues = assistant
    ? chatShaped
      ? sessionSettingsFromBag(assistant.bag.values)
      : (assistant.bag.values as AgentSessionSettings)
    : {}
  const values: AgentSessionSettings = { ...fromAgent, ...definedOnly(assistantValues) }
  if (picked.length > 0) {
    const mounted = values.mountedFolders ?? []
    const known = new Set(mounted.map((folder) => path.resolve(folder.hostPath)))
    values.mountedFolders = [
      ...mounted,
      ...picked.filter((folder) => !known.has(path.resolve(folder.hostPath))),
    ]
  }
  const fromDefaults =
    (agentBag?.fromDefaults ?? true) && (assistant?.bag.fromDefaults ?? true) && !picked.length

  const { [AGENT_MAKER_PRESET]: _agent, ...rest } = raw
  const bags = { ...assistantEntry?.bags }
  if (assistant) delete bags[assistant.key]
  bags[HARNESS_CHAT_PRESET] = { values, fromDefaults }
  const merged: PresetSessionSettings = {
    ...(assistantEntry?.variant ? { variant: assistantEntry.variant } : {}),
    bags,
  }
  return { ...rest, [HARNESS_CHAT_PRESET]: merged }
}

function withFiles(capabilities: string[]): string[] {
  return capabilities.includes(FILES_CAPABILITY_ID)
    ? capabilities
    : [FILES_CAPABILITY_ID, ...capabilities]
}

function withFilesCapability(settings: AgentSessionSettings): AgentSessionSettings {
  return settings.capabilities
    ? { ...settings, capabilities: withFiles(settings.capabilities) }
    : settings
}

/** A template without capabilities followed Agent Maker's defaults, which are now lean. */
function templateWithFiles(settings: AgentSessionSettings): AgentSessionSettings {
  return {
    ...settings,
    capabilities: withFiles(settings.capabilities ?? [...AGENT_MAKER_DEFAULT_CAPABILITY_IDS]),
  }
}

/** In a Session a record works in its Session Folder; a picked folder is mounted instead. */
export function refiledRecord(record: AgentSessionRecordWire): AgentSessionRecordWire {
  return {
    ...record,
    presetName: HARNESS_CHAT_PRESET,
    ...(record.sessionRef ? { workspaceDir: sessionPaths(record.sessionRef).filesDir } : {}),
    ...(record.capabilities ? { capabilities: withFiles(record.capabilities) } : {}),
    ...(record.settings ? { settings: withFilesCapability(record.settings) } : {}),
  }
}
