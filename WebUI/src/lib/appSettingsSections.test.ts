import { describe, expect, it } from 'vitest'
import { appSettingsSections } from './appSettingsSections'

describe('appSettingsSections', () => {
  it('lists the seven sections in order outside demo mode, nothing blocked', () => {
    const sections = appSettingsSections({ demoMode: false, hasDemoPasscode: false })

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
    const sections = appSettingsSections({ demoMode: true, hasDemoPasscode: true })

    expect(sections.map((section) => section.id)).not.toContain('theme')
  })

  it('blocks what demo mode blocked before and leaves the prompt-bar style and demo toggle usable', () => {
    const parts = appSettingsSections({ demoMode: true, hasDemoPasscode: true }).flatMap(
      (section) => section.parts,
    )

    expect(parts).toEqual([
      { id: 'language', blocked: true, disabled: false },
      { id: 'promptBarStyle', blocked: false, disabled: false },
      { id: 'huggingFace', blocked: true, disabled: false },
      { id: 'speech', blocked: true, disabled: false },
      { id: 'permissions', blocked: true, disabled: false },
      { id: 'backendStatus', blocked: true, disabled: false },
      { id: 'developer', blocked: true, disabled: false },
      { id: 'demoMode', blocked: false, disabled: false },
    ])
  })

  it('always shows the demo-mode toggle, disabled until a passcode is set', () => {
    const advanced = (hasDemoPasscode: boolean) =>
      appSettingsSections({ demoMode: false, hasDemoPasscode }).find(
        (section) => section.id === 'advanced',
      )?.parts

    expect(advanced(false)).toEqual([
      { id: 'backendStatus', blocked: false, disabled: false },
      { id: 'developer', blocked: false, disabled: false },
      { id: 'demoMode', blocked: false, disabled: true },
    ])
    expect(advanced(true)).toEqual([
      { id: 'backendStatus', blocked: false, disabled: false },
      { id: 'developer', blocked: false, disabled: false },
      { id: 'demoMode', blocked: false, disabled: false },
    ])
  })

  it.each([
    { demoMode: false, hasDemoPasscode: false },
    { demoMode: false, hasDemoPasscode: true },
    { demoMode: true, hasDemoPasscode: false },
    { demoMode: true, hasDemoPasscode: true },
  ])('never renders a section with nothing in it (%o)', (state) => {
    for (const section of appSettingsSections(state)) {
      expect(section.parts.length, section.id).toBeGreaterThan(0)
    }
  })
})
