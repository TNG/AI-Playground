import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTheme } from '@/assets/js/store/theme'

const storedSections = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))

vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: vi.fn() }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  storedSections.value = {}
  ;(globalThis as Record<string, unknown>).window = {
    electronAPI: {
      preferences: {
        read: async () => ({ success: true, sections: storedSections.value }),
        migrate: async () => ({ success: true }),
        write: async () => ({ success: true }),
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
})

describe('Base Theme', () => {
  it.each(['dark', 'lnl', 'bmg', 'light'] as const)('a Built-in Theme %s is its own', (id) => {
    const theme = useTheme()
    theme.selected = id
    expect(theme.active).toBe(id)
    expect(theme.baseTheme).toBe(id)
  })

  it('an unknown stored selection resolves to Light', async () => {
    storedSections.value = { theme: { selected: 'neon' } }
    const theme = useTheme()
    await theme.init()
    expect(theme.active).toBe('light')
    expect(theme.baseTheme).toBe('light')
  })

  it('an old stored Built-in selection still loads', async () => {
    storedSections.value = { theme: { selected: 'bmg' } }
    const theme = useTheme()
    await theme.init()
    expect(theme.baseTheme).toBe('bmg')
  })
})

describe('Built-in Themes', () => {
  it('lists the four in menu order, the dark one named Dark', () => {
    expect(useTheme().builtInThemes.map((t) => [t.id, t.name])).toEqual([
      ['dark', 'Dark'],
      ['lnl', 'Intel® Core™ Ultra'],
      ['bmg', 'Intel® Arc™'],
      ['light', 'Light'],
    ])
  })

  it('resolves the active theme to its shipped colours', () => {
    const theme = useTheme()
    theme.selected = 'dark'
    expect(theme.activeColors.background).toBe('280 50% 5%')
    expect(theme.activeColors.primary).toBe('280 98.4% 50.6%')
    theme.selected = 'lnl'
    expect(theme.activeColors.card).toBe('209 58% 8%')
    theme.selected = 'bmg'
    expect(theme.activeColors.background).toBe('280 50% 10%')
    theme.selected = 'light'
    expect(theme.activeColors['muted-foreground']).toBe('215.4 16.3% 46.9%')
  })

  it('gives every Built-in Theme a value for every colour token', () => {
    const theme = useTheme()
    for (const t of theme.builtInThemes) {
      expect(Object.keys(t.colors).sort()).toEqual([...theme.colorTokens].sort())
      for (const value of Object.values(t.colors)) expect(value).toMatch(/^[\d.]+ [\d.]+% [\d.]+%$/)
    }
  })
})
