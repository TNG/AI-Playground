import { appLoggerInstance } from '../observability/logger'
import {
  agentLibraryMigrated,
  markAgentLibraryMigrated,
  readAgentDrafts,
  readAgentTasks,
  saveAgentDraft,
  saveAgentTask,
} from '../persist/agentTaskFiles'
import {
  readAgentPresetFiles,
  removeAgentPresetFile,
  type AgentPresetFile,
} from '../persist/agentPresetFiles'
import { bootstrapAgentSessions, saveAgentSession } from '../persist/agentSessionFiles'
import { listSessions, pickSessionAgent } from '../session/sessions'
import { lastTurnPreset } from '../session/sessionHistory'
import { readSessionSettings } from '../session/sessionSettings'
import type { AgentSessionRecordWire, AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentTask } from '@/types/agentTaskIpc'
import { sameAgentSetup } from '@/lib/agentSetup'

/**
 * The one-time upgrade to the Agent Library (ADR 0007): Agent Presets fold into their Agents,
 * and an Agent loaded into an Agent Maker Harness Session with unsaved changes gets them as its
 * Draft. Runs before the window loads, so the renderer never sees the old shapes.
 */

const LOG_SCOPE = 'agent-library-migration'

export type AgentLibraryMigrationDeps = {
  /** The user presets folder (`Documents/AI Playground/presets`). */
  presetsDir: string
  /** Called after preset files were removed. */
  onPresetsChanged?: () => void
}

export async function migrateAgentLibrary(deps: AgentLibraryMigrationDeps): Promise<void> {
  if (await agentLibraryMigrated()) return
  const tasks = await readAgentTasks()
  const presets = await readAgentPresetFiles(deps.presetsDir)
  const harness = await editingHarnessSessions()

  for (const preset of presets) {
    const task = tasks.find((entry) => entry.id === preset.agentId)
    if (task) await saveAgentTask(withPresetDetails(task, preset))
  }
  await draftsFromHarnessSessions(await readAgentTasks(), harness)
  // Steps were the in-Session editor's; the Agent Library holds them now.
  for (const record of harness) await saveAgentSession(withoutAgentLink(record))
  await pickAgentsOfPresets(presets.filter((preset) => tasks.some((t) => t.id === preset.agentId)))
  for (const preset of presets) await removeAgentPresetFile(preset)
  if (presets.length > 0) deps.onPresetsChanged?.()
  await markAgentLibraryMigrated()
  appLoggerInstance.info(
    `migrated ${presets.length} agent preset(s), ${harness.length} harness session(s)`,
    LOG_SCOPE,
  )
}

/** What the Agent already has wins; a preset's default icon path is not an Agent image. */
function withPresetDetails(task: AgentTask, preset: AgentPresetFile): AgentTask {
  const description = preset.description?.trim()
  const image = preset.image?.startsWith('data:') ? preset.image : undefined
  return {
    ...task,
    ...(!task.description && description ? { description } : {}),
    ...(!task.image && image ? { image } : {}),
  }
}

/** Harness Session records of the in-Session editor; an Agent Run's are left alone. */
async function editingHarnessSessions(): Promise<AgentSessionRecordWire[]> {
  const boot = await bootstrapAgentSessions()
  if (boot.status !== 'ok') return []
  return boot.sessions.filter(
    (record) =>
      !record.taskRun &&
      record.workspaceDir !== '' &&
      (record.steps !== undefined || record.taskId !== undefined),
  )
}

async function draftsFromHarnessSessions(
  tasks: AgentTask[],
  harness: AgentSessionRecordWire[],
): Promise<void> {
  const drafted = new Set((await readAgentDrafts()).map((draft) => draft.agentId))
  const newestFirst = [...harness].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const record of newestFirst) {
    const task = tasks.find((entry) => entry.id === record.taskId)
    if (!task || drafted.has(task.id)) continue
    drafted.add(task.id)
    const settings = (await settingsOf(record)) ?? task.settingsTemplate
    const steps = record.steps ?? []
    if (sameAgentSetup({ settings: task.settingsTemplate, steps: task.steps }, { settings, steps }))
      continue
    await saveAgentDraft({
      agentId: task.id,
      name: task.name,
      ...(task.description ? { description: task.description } : {}),
      ...(task.image ? { image: task.image } : {}),
      settingsTemplate: settings,
      steps,
      updatedAt: Date.now(),
    })
  }
}

/** In a Session the settings are its bag for the preset, otherwise on the record. */
async function settingsOf(
  record: AgentSessionRecordWire,
): Promise<AgentSessionSettings | undefined> {
  if (record.settings) return record.settings
  if (!record.sessionRef || !record.presetName) return undefined
  try {
    const bags = (await readSessionSettings(record.sessionRef))[record.presetName]?.bags
    return bags?.[record.presetName]?.values as AgentSessionSettings | undefined
  } catch {
    return undefined
  }
}

function withoutAgentLink(record: AgentSessionRecordWire): AgentSessionRecordWire {
  const { steps: _steps, taskId: _taskId, ...rest } = record
  return rest
}

async function pickAgentsOfPresets(presets: AgentPresetFile[]): Promise<void> {
  if (presets.length === 0) return
  for (const session of await listSessions()) {
    if (session.unreadable) continue
    const last = await lastTurnPreset(session.id).catch(() => null)
    const preset = presets.find((entry) => entry.name === last?.preset)
    if (preset) await pickSessionAgent(session.id, preset.agentId)
  }
}
