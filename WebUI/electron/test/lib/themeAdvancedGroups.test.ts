import { describe, expect, it } from 'vitest'
import english from '@/assets/i18n/en-US.json'
import { builtInThemes, colorLabelKeys, themeTokens } from '@/lib/builtInThemes'
import { formatContrastRatio } from '@/lib/themeContrast'
import { toHexColors } from '@/lib/themeColors'
import { advancedGroups, advancedRowContrast, groupLabelKeys } from '@/lib/themeAdvancedGroups'

const labels = english as Record<string, string>

const listed = advancedGroups.map((group) => ({
  group: labels[groupLabelKeys[group.id]],
  rows: group.rows.map((row) =>
    [row.surface, row.text].filter(Boolean).map((token) => labels[colorLabelKeys[token!]]),
  ),
}))

describe('Advanced groups', () => {
  it('lists every colour as the spec groups and pairs them', () => {
    expect(listed).toEqual([
      {
        group: 'Base',
        rows: [
          ['Background', 'Text'],
          ['Panels', 'Panel text'],
          ['Menus & popups', 'Popup text'],
        ],
      },
      { group: 'Accent', rows: [['Accent', 'Accent text'], ['Focus ring']] },
      {
        group: 'Subtle',
        rows: [
          ['Muted surface', 'Secondary text'],
          ['Secondary button', 'Button text'],
          ['Hover', 'Hover text'],
        ],
      },
      { group: 'Lines', rows: [['Border'], ['Input border']] },
      { group: 'Danger', rows: [['Danger', 'Danger text']] },
      { group: 'Status', rows: [['Warning'], ['Success']] },
    ])
  })

  it('shows every colour exactly once', () => {
    const tokens = advancedGroups.flatMap((g) => g.rows.flatMap((r) => [r.surface, r.text]))
    expect(tokens.filter(Boolean).sort()).toEqual([...themeTokens].sort())
  })
})

describe('advancedRowContrast', () => {
  const light = toHexColors(builtInThemes.find((t) => t.id === 'light')!.colors)
  const row = (surface: string) =>
    advancedGroups.flatMap((g) => g.rows).find((r) => r.surface === surface)!

  it('measures the text against its surface', () => {
    const colors = { ...light, background: '#ffffff', foreground: '#000000' }
    expect(advancedRowContrast(row('background'), colors)).toEqual({ ratio: 21, readable: true })
  })

  it('flags a pair below the readability minimum', () => {
    const colors = { ...light, muted: '#777777', 'muted-foreground': '#888888' }
    expect(advancedRowContrast(row('muted'), colors)?.readable).toBe(false)
  })

  it('measures Warning and Success on Background', () => {
    const colors = { ...light, background: '#000000', warning: '#ffffff', success: '#010101' }
    expect(advancedRowContrast(row('warning'), colors)).toEqual({ ratio: 21, readable: true })
    expect(advancedRowContrast(row('success'), colors)?.readable).toBe(false)
  })

  it('shows a ratio rounded down, so a flagged pair never reads as the minimum', () => {
    expect(formatContrastRatio(1.999)).toBe('1.99')
    expect(formatContrastRatio(21)).toBe('21.00')
  })

  it('has no contrast for a colour that sits on nothing in particular', () => {
    expect(advancedRowContrast(row('border'), light)).toBeNull()
    expect(advancedRowContrast(row('ring'), light)).toBeNull()
  })
})
