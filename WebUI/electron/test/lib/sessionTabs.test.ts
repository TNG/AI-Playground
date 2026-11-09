import { describe, expect, it } from 'vitest'
import { sessionTabs, sessionTabsPresetKind, type SessionTabsInput } from '@/lib/sessionTabs'

const chatSession: SessionTabsInput = {
  owner: 'session',
  presetKind: 'chat',
  agentPicked: false,
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

  it('shows the same four tabs under every preset, Agent Maker included', () => {
    for (const presetKind of [
      'chat',
      'audio',
      'image',
      'edit',
      'video',
      'agent-maker',
      'agent-preset',
    ] as const) {
      expect(sessionTabs({ ...chatSession, presetKind }).tabs).toEqual([
        'viewport',
        'inferencing',
        'attributes',
        'artifacts',
      ])
    }
  })

  it('gives a Home Agent thread Viewport, Inferencing and Attributes only', () => {
    for (const presetKind of ['chat', 'agent-maker'] as const) {
      const view = sessionTabs({ ...chatSession, owner: 'home-agent-thread', presetKind })
      expect(view.tabs).toEqual(['viewport', 'inferencing', 'attributes'])
    }
  })

  it("shows the Session's own settings, editable, when no Agent is picked", () => {
    for (const presetKind of ['chat', 'agent-maker', 'agent-preset'] as const) {
      expect(sessionTabs({ ...chatSession, presetKind }).settings).toBe('session')
    }
  })

  it("shows a picked Agent's Settings Template read-only under Agent Maker", () => {
    const view = sessionTabs({ ...chatSession, presetKind: 'agent-maker', agentPicked: true })
    expect(view.settings).toBe('picked-agent')
    expect(view.tabs).toEqual(['viewport', 'inferencing', 'attributes', 'artifacts'])
  })

  it("keeps the Session's settings for a Home Agent thread even with an Agent picked", () => {
    const view = sessionTabs({
      ...chatSession,
      owner: 'home-agent-thread',
      presetKind: 'agent-maker',
      agentPicked: true,
    })
    expect(view.settings).toBe('session')
  })

  it('keeps the shown settings tab when an Agent is picked or unpicked', () => {
    for (const agentPicked of [true, false]) {
      const view = sessionTabs({
        ...chatSession,
        presetKind: 'agent-maker',
        agentPicked,
        current: 'attributes',
      })
      expect(view.shown).toBe('attributes')
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
    expect(
      sessionTabs({ ...chatSession, owner: 'home-agent-thread', current: 'artifacts' }).shown,
    ).toBe('viewport')
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

  it('tells Agent Maker and the other Agent Presets apart', () => {
    expect(sessionTabsPresetKind('agent', { name: 'Agent', agentPreset: true })).toBe('agent-maker')
    expect(sessionTabsPresetKind('agent', { name: 'Game Agent', agentPreset: true })).toBe(
      'agent-preset',
    )
  })
})
