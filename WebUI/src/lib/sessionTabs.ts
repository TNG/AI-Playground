import { usesSessionSettings } from '@/lib/agentSessionSettings'

export type SessionTabId = 'viewport' | 'inferencing' | 'attributes' | 'artifacts' | 'schedules'

export const SESSION_TAB_LABELS = {
  viewport: 'SESSION_TAB_VIEWPORT',
  inferencing: 'SESSION_TAB_INFERENCING',
  attributes: 'SESSION_TAB_ATTRIBUTES',
  artifacts: 'SESSION_TAB_ARTIFACTS',
  schedules: 'SESSION_TAB_AGENTS',
} as const satisfies Record<SessionTabId, string>

export type SessionTabsOwner = 'session' | 'home-agent-thread'

export type SessionTabsPresetKind =
  | 'chat'
  | 'audio'
  | 'image'
  | 'edit'
  | 'video'
  | 'agent-maker'
  | 'agent-preset'
  | 'saved-agent-preset'

export type SchedulesAllowance = 'full' | 'run-only' | 'one-agent'

export type SessionTabLanding = 'open-session' | 'open-from-artifacts' | 'keep'

export type ArtifactsScope = 'this-session' | 'all-sessions'

export type SessionTabsInput = {
  owner: SessionTabsOwner
  presetKind: SessionTabsPresetKind
  /** The Session holds a Schedule, paused or not, or a running Agent Run. */
  holdsScheduleOrRun: boolean
  /** A saved Agent is picked in the Session's prompt bar. */
  agentPicked: boolean
  landing: SessionTabLanding
  current: SessionTabId
}

/** Whose settings Inferencing and Attributes show: the Session's, or the picked Agent's read-only. */
export type SessionTabsSettings = 'session' | 'picked-agent'

export type SessionTabsView = {
  tabs: SessionTabId[]
  settings: SessionTabsSettings
  schedules: SchedulesAllowance | null
  shown: SessionTabId
  /** Set only when the landing decides the Artifacts scope; otherwise the tab keeps its own. */
  artifactsScope: ArtifactsScope | null
}

function schedulesAllowance(input: SessionTabsInput): SchedulesAllowance | null {
  if (input.owner !== 'session') return null
  if (input.presetKind === 'agent-maker') return 'full'
  if (input.presetKind === 'saved-agent-preset') return 'one-agent'
  return input.holdsScheduleOrRun ? 'run-only' : null
}

export function sessionTabs(input: SessionTabsInput): SessionTabsView {
  const schedules = schedulesAllowance(input)
  const tabs: SessionTabId[] =
    input.owner === 'session'
      ? ['viewport', 'inferencing', 'attributes', 'artifacts']
      : ['viewport', 'inferencing', 'attributes']
  if (schedules) tabs.push('schedules')
  const wanted: SessionTabId =
    input.landing === 'open-session'
      ? 'viewport'
      : input.landing === 'open-from-artifacts'
        ? 'artifacts'
        : input.current
  const shown = tabs.includes(wanted) ? wanted : 'viewport'
  return {
    tabs,
    settings:
      input.owner === 'session' && input.presetKind === 'agent-maker' && input.agentPicked
        ? 'picked-agent'
        : 'session',
    schedules,
    shown,
    artifactsScope:
      shown === 'artifacts' && input.landing === 'open-from-artifacts' ? 'this-session' : null,
  }
}

export type SchedulesPanel = {
  /** The save bar and the Steps editor. */
  editSteps: boolean
  editNote: boolean
  agentList: {
    /** The whole library, the saved Agent Preset's own Agent, or what this Session holds. */
    listed: 'library' | 'preset-agent' | 'this-session'
    load: boolean
    saveAsPreset: boolean
    /** Rename and delete. */
    manage: boolean
    run: boolean
    /** Otherwise this Session's Schedule can only be removed. */
    editSchedule: boolean
  }
}

export function schedulesPanel(allowance: SchedulesAllowance): SchedulesPanel {
  switch (allowance) {
    case 'full':
      return {
        editSteps: true,
        editNote: false,
        agentList: {
          listed: 'library',
          load: true,
          saveAsPreset: true,
          manage: true,
          run: true,
          editSchedule: true,
        },
      }
    case 'run-only':
      return {
        editSteps: false,
        editNote: true,
        agentList: {
          listed: 'this-session',
          load: false,
          saveAsPreset: false,
          manage: false,
          run: false,
          editSchedule: false,
        },
      }
    case 'one-agent':
      return {
        editSteps: false,
        editNote: true,
        agentList: {
          listed: 'preset-agent',
          load: false,
          saveAsPreset: false,
          manage: false,
          run: true,
          editSchedule: true,
        },
      }
  }
}

const MODE_KINDS: Record<Exclude<ModeType, 'agent'>, SessionTabsPresetKind> = {
  chat: 'chat',
  audio: 'audio',
  imageGen: 'image',
  imageEdit: 'edit',
  video: 'video',
}

export function sessionTabsPresetKind(
  mode: ModeType,
  agentPreset: { name: string; agentPreset?: boolean; agentTaskId?: string } | null,
): SessionTabsPresetKind {
  if (mode !== 'agent') return MODE_KINDS[mode]
  if (!usesSessionSettings(agentPreset)) return 'agent-preset'
  return agentPreset?.agentTaskId !== undefined ? 'saved-agent-preset' : 'agent-maker'
}
