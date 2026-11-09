import { usesSessionSettings } from '@/lib/agentSessionSettings'

export type SessionTabId = 'viewport' | 'inferencing' | 'attributes' | 'artifacts' | 'schedules'

export const SESSION_TAB_LABELS = {
  viewport: 'SESSION_TAB_VIEWPORT',
  inferencing: 'SESSION_TAB_INFERENCING',
  attributes: 'SESSION_TAB_ATTRIBUTES',
  artifacts: 'SESSION_TAB_ARTIFACTS',
  schedules: 'SESSION_TAB_SCHEDULES',
} as const satisfies Record<SessionTabId, string>

export type SessionTabsOwner = 'session' | 'home-agent-thread'

export type SessionTabsPresetKind =
  'chat' | 'audio' | 'image' | 'edit' | 'video' | 'agent-maker' | 'agent-preset'

export type SessionTabLanding = 'open-session' | 'open-from-artifacts' | 'keep'

export type ArtifactsScope = 'this-session' | 'all-sessions'

export type SessionTabsInput = {
  owner: SessionTabsOwner
  presetKind: SessionTabsPresetKind
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
  shown: SessionTabId
  /** Set only when the landing decides the Artifacts scope; otherwise the tab keeps its own. */
  artifactsScope: ArtifactsScope | null
}

export function sessionTabs(input: SessionTabsInput): SessionTabsView {
  const tabs: SessionTabId[] =
    input.owner === 'session'
      ? ['viewport', 'inferencing', 'attributes', 'artifacts', 'schedules']
      : ['viewport', 'inferencing', 'attributes']
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
    shown,
    artifactsScope:
      shown === 'artifacts' && input.landing === 'open-from-artifacts' ? 'this-session' : null,
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
  agentPreset: { name: string; agentPreset?: boolean } | null,
): SessionTabsPresetKind {
  if (mode !== 'agent') return MODE_KINDS[mode]
  return usesSessionSettings(agentPreset) ? 'agent-maker' : 'agent-preset'
}
