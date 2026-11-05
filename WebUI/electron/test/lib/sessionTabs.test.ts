import { describe, expect, it } from 'vitest'
import enUS from '../../../src/assets/i18n/en-US.json'
import {
  SESSION_TAB_LABELS,
  schedulesPanel,
  sessionTabs,
  sessionTabsPresetKind,
  type SessionTabsInput,
} from '@/lib/sessionTabs'

const chatSession: SessionTabsInput = {
  owner: 'session',
  presetKind: 'chat',
  holdsScheduleOrRun: false,
  landing: 'keep',
  current: 'viewport',
}

describe('sessionTabs', () => {
  it('shows Viewport, Inferencing, Attributes and Artifacts for a plain Session', () => {
    expect(sessionTabs(chatSession).tabs).toEqual([
      'viewport',
      'inferencing',
      'attributes',
      'artifacts',
    ])
  })

  it('shows the same tabs for every preset kind that is not an Agent Preset', () => {
    for (const presetKind of ['chat', 'audio', 'image', 'edit', 'video', 'agent-preset'] as const) {
      const view = sessionTabs({ ...chatSession, presetKind })
      expect(view.tabs).toEqual(['viewport', 'inferencing', 'attributes', 'artifacts'])
      expect(view.schedules).toBeNull()
    }
  })

  it('calls the Agents tab "Agents"', () => {
    expect(enUS[SESSION_TAB_LABELS.schedules]).toBe('Agents')
  })

  it('adds Agents with full editing under Agent Maker', () => {
    const view = sessionTabs({ ...chatSession, presetKind: 'agent-maker' })
    expect(view.tabs).toEqual(['viewport', 'inferencing', 'attributes', 'artifacts', 'schedules'])
    expect(view.schedules).toBe('full')
  })

  it('keeps a reduced Agents tab under any other preset when the Session holds a Schedule or a run', () => {
    for (const presetKind of ['chat', 'audio', 'image', 'edit', 'video', 'agent-preset'] as const) {
      const view = sessionTabs({ ...chatSession, presetKind, holdsScheduleOrRun: true })
      expect(view.tabs.at(-1)).toBe('schedules')
      expect(view.schedules).toBe('run-only')
    }
  })

  it('keeps full editing under Agent Maker when the Session holds a Schedule or a run', () => {
    expect(
      sessionTabs({ ...chatSession, presetKind: 'agent-maker', holdsScheduleOrRun: true })
        .schedules,
    ).toBe('full')
  })

  it('limits Agents to one Agent under a saved Agent Preset', () => {
    for (const holdsScheduleOrRun of [false, true]) {
      const view = sessionTabs({
        ...chatSession,
        presetKind: 'saved-agent-preset',
        holdsScheduleOrRun,
      })
      expect(view.tabs.at(-1)).toBe('schedules')
      expect(view.schedules).toBe('one-agent')
    }
  })

  it('gives a Home Agent thread Viewport, Inferencing and Attributes only', () => {
    for (const presetKind of ['chat', 'agent-maker'] as const) {
      const view = sessionTabs({
        ...chatSession,
        owner: 'home-agent-thread',
        presetKind,
        holdsScheduleOrRun: true,
      })
      expect(view.tabs).toEqual(['viewport', 'inferencing', 'attributes'])
      expect(view.schedules).toBeNull()
    }
  })

  it('lands on the Viewport when a Session is opened or started, whatever tab was shown', () => {
    const view = sessionTabs({ ...chatSession, landing: 'open-session', current: 'attributes' })
    expect(view.shown).toBe('viewport')
    expect(view.artifactsScope).toBeNull()
  })

  it('lands on Artifacts showing This Session when opened from an Artifact', () => {
    const view = sessionTabs({
      ...chatSession,
      landing: 'open-from-artifacts',
      current: 'inferencing',
    })
    expect(view.shown).toBe('artifacts')
    expect(view.artifactsScope).toBe('this-session')
  })

  it('falls back to the Viewport when an Artifact opens a Home Agent thread', () => {
    const view = sessionTabs({
      ...chatSession,
      owner: 'home-agent-thread',
      landing: 'open-from-artifacts',
    })
    expect(view.shown).toBe('viewport')
    expect(view.artifactsScope).toBeNull()
  })

  it('keeps the current tab otherwise', () => {
    for (const current of ['viewport', 'inferencing', 'attributes', 'artifacts'] as const) {
      const view = sessionTabs({ ...chatSession, current })
      expect(view.shown).toBe(current)
      expect(view.artifactsScope).toBeNull()
    }
  })

  it('falls back to the Viewport when the current tab is no longer visible', () => {
    expect(sessionTabs({ ...chatSession, current: 'schedules' }).shown).toBe('viewport')
    expect(
      sessionTabs({ ...chatSession, owner: 'home-agent-thread', current: 'artifacts' }).shown,
    ).toBe('viewport')
  })

  it('keeps Agents shown while it stays visible after a preset switch', () => {
    expect(
      sessionTabs({ ...chatSession, holdsScheduleOrRun: true, current: 'schedules' }).shown,
    ).toBe('schedules')
  })
})

describe('sessionTabsPresetKind', () => {
  it('names the kind of each mode', () => {
    expect(sessionTabsPresetKind('chat', null)).toBe('chat')
    expect(sessionTabsPresetKind('audio', null)).toBe('audio')
    expect(sessionTabsPresetKind('imageGen', null)).toBe('image')
    expect(sessionTabsPresetKind('imageEdit', null)).toBe('edit')
    expect(sessionTabsPresetKind('video', null)).toBe('video')
  })

  it('tells Agent Maker, its saved Agent Presets and the other Agent Presets apart', () => {
    expect(sessionTabsPresetKind('agent', { name: 'Agent', agentPreset: true })).toBe('agent-maker')
    expect(
      sessionTabsPresetKind('agent', { name: 'Logo maker', agentPreset: true, agentTaskId: 't1' }),
    ).toBe('saved-agent-preset')
    expect(sessionTabsPresetKind('agent', { name: 'Game Agent', agentPreset: true })).toBe(
      'agent-preset',
    )
  })
})

describe('schedulesPanel', () => {
  it('offers the save bar, Steps and the whole library, editable, under Agent Maker', () => {
    expect(schedulesPanel('full')).toEqual({
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
    })
  })

  it('lists only what the Session holds, to stop or unschedule, under another preset', () => {
    expect(schedulesPanel('run-only')).toEqual({
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
    })
  })

  it("offers the save bar, Steps and only the preset's own Agent under a saved Agent Preset", () => {
    expect(schedulesPanel('one-agent')).toEqual({
      editSteps: true,
      editNote: false,
      agentList: {
        listed: 'preset-agent',
        load: false,
        saveAsPreset: false,
        manage: true,
        run: true,
        editSchedule: true,
      },
    })
  })
})
