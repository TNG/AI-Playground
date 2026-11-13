import { describe, expect, it } from 'vitest'
import { appSettingsSections } from './appSettingsSections'

describe('appSettingsSections', () => {
  it('lists the seven sections in order outside demo mode, nothing blocked', () => {
    const sections = appSettingsSections({ demoMode: false, showDemoToggle: false })

    expect(sections.map((section) => section.id)).toEqual([
      'language',
      'theme',
      'promptBarStyle',
      'huggingFace',
      'speech',
      'permissions',
      'advanced',
    ])
    expect(sections.flatMap((section) => section.parts).some((part) => part.blocked)).toBe(false)
  })

  it('drops the Theme section in demo mode instead of leaving an empty band', () => {
    const sections = appSettingsSections({ demoMode: true, showDemoToggle: true })

    expect(sections.map((section) => section.id)).not.toContain('theme')
  })

  it('blocks what demo mode blocked before and leaves the prompt-bar style and demo toggle usable', () => {
    const parts = appSettingsSections({ demoMode: true, showDemoToggle: true }).flatMap(
      (section) => section.parts,
    )

    expect(parts).toEqual([
      { id: 'language', blocked: true },
      { id: 'promptBarStyle', blocked: false },
      { id: 'huggingFace', blocked: true },
      { id: 'speech', blocked: true },
      { id: 'permissions', blocked: true },
      { id: 'backendStatus', blocked: true },
      { id: 'developer', blocked: true },
      { id: 'demoMode', blocked: false },
    ])
  })

  it('shows the demo-mode toggle only when a passcode makes it available', () => {
    const advanced = (showDemoToggle: boolean) =>
      appSettingsSections({ demoMode: false, showDemoToggle })
        .find((section) => section.id === 'advanced')
        ?.parts.map((part) => part.id)

    expect(advanced(false)).toEqual(['backendStatus', 'developer'])
    expect(advanced(true)).toEqual(['backendStatus', 'developer', 'demoMode'])
  })

  it.each([
    { demoMode: false, showDemoToggle: false },
    { demoMode: false, showDemoToggle: true },
    { demoMode: true, showDemoToggle: false },
    { demoMode: true, showDemoToggle: true },
  ])('never renders a section with nothing in it (%o)', (state) => {
    for (const section of appSettingsSections(state)) {
      expect(section.parts.length, section.id).toBeGreaterThan(0)
    }
  })
})
