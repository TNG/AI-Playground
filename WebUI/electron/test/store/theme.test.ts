import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive } from 'vue'
import { useTheme } from '@/assets/js/store/theme'
import type { AppError } from '@/assets/js/errors/types'
import english from '@/assets/i18n/en-US.json'

const storedSections = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
const reported = vi.hoisted(() => ({ value: [] as unknown[] }))
const locale = vi.hoisted(() => ({ state: {} as Record<string, string> }))

vi.mock('@/assets/js/demoAwareStorage', () => ({
  demoAwareStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}))

vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: (error: unknown) => reported.value.push(error) }),
}))

vi.mock('@/assets/js/store/i18n', () => ({ useI18N: () => ({ state: locale.state }) }))

let writes: { section: string; value: unknown }[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  storedSections.value = {}
  reported.value = []
  locale.state = reactive({ ...english })
  writes = []
  ;(globalThis as Record<string, unknown>).window = {
    electronAPI: {
      preferences: {
        read: async () => ({ success: true, sections: storedSections.value }),
        migrate: async () => ({ success: true }),
        write: async (section: string, value: unknown) => {
          writes.push({ section, value })
          return { success: true }
        },
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

describe('Customize', () => {
  it('creates a selected Custom Theme named after its Base Theme, in hex', () => {
    const theme = useTheme()
    theme.selectTheme('dark')
    const id = theme.customize()
    expect(theme.active).toBe(id)
    expect(theme.activeCustomTheme).toMatchObject({ id, name: 'Dark (custom)', baseTheme: 'dark' })
    expect(theme.activeCustomTheme?.colors.background).toBe('#0f0613')
    expect(theme.baseTheme).toBe('dark')
  })

  it('numbers a second copy, taking the lowest free number', () => {
    const theme = useTheme()
    theme.customize('lnl')
    const second = theme.customize('lnl')
    theme.customize('lnl')
    expect(theme.validCustomThemes.map((t) => t.name)).toEqual([
      'Intel® Core™ Ultra (custom)',
      'Intel® Core™ Ultra (custom 2)',
      'Intel® Core™ Ultra (custom 3)',
    ])
    theme.customThemes = theme.customThemes.filter((t) => t.id !== second)
    theme.customize('lnl')
    expect(theme.activeCustomTheme?.name).toBe('Intel® Core™ Ultra (custom 2)')
  })

  it('keeps the Base Theme decorations of an Intel® Arc™ copy', () => {
    const theme = useTheme()
    theme.selectTheme('bmg')
    theme.customize()
    expect(theme.baseTheme).toBe('bmg')
  })
})

describe('Editing a draft', () => {
  it('keeps a colour edit in the draft, changing nothing until saved', () => {
    const theme = useTheme()
    theme.selectTheme('light')
    expect(theme.setColor('primary', '#FF0000')).toBe(true)
    expect(theme.draftHexColors.primary).toBe('#ff0000')
    expect(theme.hasUnsavedChanges).toBe(true)
    expect(theme.active).toBe('light')
    expect(theme.validCustomThemes).toHaveLength(0)
  })

  it('saving a draft of a Built-in Theme creates and selects a copy', () => {
    const theme = useTheme()
    theme.selectTheme('light')
    theme.setColor('primary', '#0000ff')
    expect(theme.saveDraft()).toBe(true)
    expect(theme.activeCustomTheme).toMatchObject({ name: 'Light (custom)', baseTheme: 'light' })
    expect(theme.activeHexColors.primary).toBe('#0000ff')
    expect(theme.hasUnsavedChanges).toBe(false)
  })

  it('saving a draft of a Custom Theme updates it in place, applied as an HSL triplet', () => {
    const theme = useTheme()
    theme.customize('dark')
    theme.setColor('ring', '#00ff00')
    theme.setColor('ring', '#0000ff')
    expect(theme.saveDraft()).toBe(true)
    expect(theme.validCustomThemes).toHaveLength(1)
    expect(theme.activeColors.ring).toBe('240 100% 50%')
    expect(theme.activeHexColors.primary).toBe('#aa05fd')
  })

  it('discarding drops the draft and creates nothing', () => {
    const theme = useTheme()
    theme.selectTheme('bmg')
    theme.setColor('border', '#123456')
    theme.discardDraft()
    expect(theme.hasUnsavedChanges).toBe(false)
    expect(theme.draftHexColors.border).toBe(theme.activeHexColors.border)
    expect(theme.saveDraft()).toBe(false)
    expect(theme.validCustomThemes).toHaveLength(0)
  })

  it('an edit back to the saved colour leaves nothing unsaved', () => {
    const theme = useTheme()
    theme.selectTheme('dark')
    const saved = theme.activeHexColors.border
    theme.setColor('border', '#123456')
    theme.setColor('border', saved)
    expect(theme.hasUnsavedChanges).toBe(false)
  })

  it('never changes a Built-in Theme', () => {
    const theme = useTheme()
    for (const id of ['dark', 'lnl', 'bmg', 'light'] as const) {
      theme.selectTheme(id)
      for (const token of theme.colorTokens) theme.setColor(token, '#123456')
      theme.saveDraft()
    }
    theme.selectTheme('dark')
    expect(theme.activeColors.background).toBe('280 50% 5%')
    expect(theme.builtInThemes[3].colors.foreground).toBe('222.2 47.4% 11.2%')
  })

  it('ignores a value that is not #rrggbb', () => {
    const theme = useTheme()
    theme.selectTheme('dark')
    expect(theme.setColor('primary', 'red')).toBe(false)
    expect(theme.setRoleColor('accent', '#12345')).toBe(false)
    expect(theme.hasUnsavedChanges).toBe(false)
  })
})

describe('Colour roles', () => {
  it('sets every token a role maps to and no other', () => {
    const theme = useTheme()
    theme.selectTheme('dark')
    const shipped = { ...theme.activeHexColors }
    theme.setRoleColor('panels', '#223344')
    theme.setRoleColor('accent', '#00aa55')
    expect(theme.draftHexColors).toEqual({
      ...shipped,
      card: '#223344',
      popover: '#223344',
      primary: '#00aa55',
      ring: '#00aa55',
    })
  })

  it('fixes button text from the roles alone after a light accent', () => {
    const theme = useTheme()
    theme.selectTheme('dark')
    theme.setRoleColor('accent', '#ffee88')
    expect(theme.draftVerdict).toMatchObject({ readable: false, text: 'primary-foreground' })
    theme.setRoleColor('accentText', '#222222')
    expect(theme.draftHexColors).toMatchObject({
      'primary-foreground': '#222222',
    })
    expect(theme.canSave).toBe(true)
  })

  it('leaves the text alone when a background changes, so edits work in any order', () => {
    const theme = useTheme()
    theme.selectTheme('dark')
    const text = theme.activeHexColors.foreground
    theme.setRoleColor('background', '#ffffff')
    expect(theme.draftHexColors.foreground).toBe(text)
    expect(theme.draftVerdict).toMatchObject({ readable: false, text: 'foreground' })
    expect(theme.canSave).toBe(false)
    theme.setRoleColor('text', '#111111')
    theme.setColor('muted-foreground', '#555555')
    expect(theme.draftVerdict).toMatchObject({ readable: false, text: 'card-foreground' })
    theme.setRoleColor('panels', '#f4f4f4')
    expect(theme.canSave).toBe(true)
    expect(theme.saveDraft()).toBe(true)
    expect(theme.activeHexColors).toMatchObject({ background: '#ffffff', foreground: '#111111' })
  })
})

describe('Persistence', () => {
  it('writes the Custom Themes and the selection to the theme section', async () => {
    const theme = useTheme()
    await theme.init()
    theme.selectTheme('lnl')
    const id = theme.customize()
    theme.setColor('border', '#abcdef')
    theme.saveDraft()
    await new Promise((resolve) => setTimeout(resolve, 400))
    const last = writes.at(-1)
    expect(last?.section).toBe('theme')
    const value = last?.value as { selected: string; customThemes: Record<string, unknown>[] }
    expect(value.selected).toBe(id)
    expect(value.customThemes).toHaveLength(1)
    expect(Object.keys(value.customThemes[0]).sort()).toEqual(['baseTheme', 'colors', 'id', 'name'])
    expect(value.customThemes[0]).toMatchObject({ id, baseTheme: 'lnl' })
    const colors = value.customThemes[0].colors as Record<string, string>
    expect(Object.keys(colors).sort()).toEqual([...theme.colorTokens].sort())
    expect(colors.border).toBe('#abcdef')
  })

  it('loads a saved Custom Theme selection after a restart', async () => {
    const theme = useTheme()
    theme.selectTheme('bmg')
    const id = theme.customize()
    theme.setColor('background', '#000000')
    theme.saveDraft()
    storedSections.value = {
      theme: { selected: id, customThemes: JSON.parse(JSON.stringify(theme.customThemes)) },
    }
    setActivePinia(createPinia())
    const restarted = useTheme()
    await restarted.init()
    expect(restarted.active).toBe(id)
    expect(restarted.baseTheme).toBe('bmg')
    expect(restarted.activeColors.background).toBe('0 0% 0%')
  })
})

describe('Readability guard', () => {
  it('names the unreadable pair of a draft and refuses to save it', () => {
    const theme = useTheme()
    theme.customize('dark')
    theme.setColor('card', '#e0e0e0')
    expect(theme.draftVerdict).toMatchObject({
      readable: false,
      text: 'card-foreground',
      background: 'card',
    })
    expect(theme.draftWarning).toContain('text on panels and cards')
    expect(theme.saveDraft()).toBe(false)
    expect(theme.activeHexColors.card).toBe('#000000')
  })

  it('clears the warning as soon as the draft is readable again', () => {
    const theme = useTheme()
    theme.customize('dark')
    theme.setColor('card', '#e0e0e0')
    theme.setColor('card', '#101010')
    expect(theme.draftWarning).toBe('')
    expect(theme.canSave).toBe(true)
  })

  it('accepts text down to 2:1 and refuses it below', () => {
    const theme = useTheme()
    theme.selectTheme('light')
    theme.setColor('foreground', '#b3b3b3')
    expect(theme.canSave).toBe(true)
    theme.setColor('foreground', '#bbbbbb')
    expect(theme.canSave).toBe(false)
    expect(theme.draftWarning).toBe(
      "Can't save: main text would be hard to read (contrast 1.91:1).",
    )
  })

  it('holds every Built-in Theme to the same minimum, whatever it ships', () => {
    const theme = useTheme()
    theme.selectTheme('light')
    theme.setColor('primary', '#66b3ff')
    expect(theme.canSave).toBe(true)
    theme.setColor('primary', '#80c0ff')
    expect(theme.draftVerdict).toMatchObject({ readable: false, text: 'primary-foreground' })
  })

  it('a reset drops the draft and its warning', () => {
    const theme = useTheme()
    const id = theme.customize('dark')
    theme.setColor('card', '#e0e0e0')
    theme.resetCustomTheme(id)
    expect(theme.hasUnsavedChanges).toBe(false)
    expect(theme.draftWarning).toBe('')
  })

  it('switching theme drops the draft', () => {
    const theme = useTheme()
    theme.selectTheme('dark')
    theme.setColor('card', '#e0e0e0')
    theme.selectTheme('light')
    expect(theme.hasUnsavedChanges).toBe(false)
    expect(theme.draftWarning).toBe('')
  })
})

describe('Unsaved changes', () => {
  it('runs a guarded action at once when nothing is unsaved', () => {
    const theme = useTheme()
    const action = vi.fn()
    theme.guardUnsaved(action)
    expect(action).toHaveBeenCalledOnce()
    expect(theme.discardPending).toBe(false)
  })

  it('holds a guarded action until the user discards, and keeps the draft on cancel', () => {
    const theme = useTheme()
    theme.selectTheme('dark')
    theme.setColor('border', '#123456')
    const action = vi.fn()
    theme.guardUnsaved(action)
    expect(action).not.toHaveBeenCalled()
    expect(theme.discardPending).toBe(true)
    theme.cancelDiscard()
    expect(theme.discardPending).toBe(false)
    expect(theme.hasUnsavedChanges).toBe(true)
    theme.guardUnsaved(action)
    theme.confirmDiscard()
    expect(action).toHaveBeenCalledOnce()
    expect(theme.hasUnsavedChanges).toBe(false)
  })
})

describe('Startup fallback', () => {
  const unreadable = {
    id: 'custom-unreadable',
    name: 'Night (hand-edited)',
    baseTheme: 'bmg' as const,
  }

  async function startWithUnreadableTheme() {
    const theme = useTheme()
    theme.selectTheme('bmg')
    theme.customize()
    const colors = { ...theme.activeHexColors, 'muted-foreground': '#1e0d26' }
    const stored = { selected: unreadable.id, customThemes: [{ ...unreadable, colors }] }
    storedSections.value = { theme: JSON.parse(JSON.stringify(stored)) }
    setActivePinia(createPinia())
    writes = []
    const restarted = useTheme()
    await restarted.init()
    return { restarted, stored }
  }

  it('applies the Base Theme and reports why, leaving stored data untouched', async () => {
    const { restarted, stored } = await startWithUnreadableTheme()
    expect(restarted.active).toBe('bmg')
    expect(restarted.baseTheme).toBe('bmg')
    expect(restarted.activeCustomTheme).toBeNull()
    expect(restarted.selected).toBe(unreadable.id)
    expect(restarted.customThemes).toEqual(stored.customThemes)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(writes).toEqual([])
    expect(reported.value).toHaveLength(1)
    expect((reported.value[0] as AppError).userMessage).toBe(
      'The theme “Night (hand-edited)” makes secondary text hard to read, so Intel® Arc™ is shown instead. Your theme has been kept unchanged.',
    )
  })

  it('waits for the locale to load before reporting', async () => {
    locale.state = reactive({})
    await startWithUnreadableTheme()
    expect(reported.value).toHaveLength(0)
    Object.assign(locale.state, english)
    await nextTick()
    expect(reported.value).toHaveLength(1)
  })

  it('keeps the unreadable Custom Theme in the editor, saying why it is not applied', async () => {
    const { restarted } = await startWithUnreadableTheme()
    expect(restarted.selectedId).toBe(unreadable.id)
    expect(restarted.editedCustomTheme).toMatchObject(unreadable)
    expect(restarted.draftHexColors['muted-foreground']).toBe('#1e0d26')
    expect(restarted.fallbackMessage).toBe(
      'The theme “Night (hand-edited)” makes secondary text hard to read, so Intel® Arc™ is shown instead. Your theme has been kept unchanged.',
    )
  })

  it('applies the Custom Theme once a saved edit makes it readable, without a copy', async () => {
    const { restarted } = await startWithUnreadableTheme()
    restarted.setColor('muted-foreground', '#cccccc')
    expect(restarted.saveDraft()).toBe(true)
    expect(restarted.active).toBe(unreadable.id)
    expect(restarted.activeHexColors['muted-foreground']).toBe('#cccccc')
    expect(restarted.validCustomThemes).toHaveLength(1)
    expect(restarted.fallbackMessage).toBe('')
  })

  it('refuses to save an edit that leaves it unreadable, without a copy', async () => {
    const { restarted } = await startWithUnreadableTheme()
    restarted.setColor('border', '#445566')
    expect(restarted.draftVerdict).toMatchObject({ readable: false, text: 'muted-foreground' })
    expect(restarted.saveDraft()).toBe(false)
    expect(restarted.validCustomThemes).toHaveLength(1)
    expect(restarted.active).toBe('bmg')
  })

  it('can be reset, renamed and deleted while it is not applied', async () => {
    const { restarted } = await startWithUnreadableTheme()
    expect(restarted.renameCustomTheme(unreadable.id, 'Night')).toBe(true)
    restarted.resetCustomTheme(unreadable.id)
    expect(restarted.active).toBe(unreadable.id)
    expect(restarted.activeCustomTheme?.name).toBe('Night')
    restarted.deleteCustomTheme(unreadable.id)
    expect(restarted.active).toBe('bmg')
  })
})

describe('Stored Custom Themes from another version or a hand edit', () => {
  const colorsWithout = (id: Theme, missing: string) => {
    const theme = useTheme()
    theme.selectTheme(id)
    const colors: Record<string, string> = { ...theme.activeHexColors, background: '#000000' }
    delete colors[missing]
    return colors
  }

  async function load(section: unknown) {
    storedSections.value = { theme: JSON.parse(JSON.stringify(section)) }
    setActivePinia(createPinia())
    const theme = useTheme()
    await theme.init()
    return theme
  }

  it('fills a missing token from the Base Theme and keeps it on the next write', async () => {
    const stored = {
      id: 'custom-old',
      name: 'Old',
      baseTheme: 'bmg',
      colors: colorsWithout('bmg', 'ring'),
    }
    const theme = await load({ selected: stored.id, customThemes: [stored] })
    expect(theme.active).toBe(stored.id)
    expect(theme.activeHexColors.background).toBe('#000000')
    expect(theme.activeHexColors.ring).toBe('#aa05fd')
    theme.setColor('border', '#334455')
    theme.saveDraft()
    await new Promise((resolve) => setTimeout(resolve, 400))
    const written = (writes.at(-1)?.value as { customThemes: { colors: Record<string, string> }[] })
      .customThemes
    expect(written).toHaveLength(1)
    expect(written[0].colors.ring).toBe('#aa05fd')
  })

  it('fills from Light when the Base Theme is gone', async () => {
    const stored = {
      id: 'custom-old',
      name: 'Old',
      baseTheme: 'retired',
      colors: colorsWithout('dark', 'border'),
    }
    const theme = await load({ selected: stored.id, customThemes: [stored] })
    expect(theme.active).toBe(stored.id)
    expect(theme.activeHexColors.border).toBe('#e2e8f0')
  })

  it('ignores a malformed entry', async () => {
    const theme = await load({
      selected: 'light',
      customThemes: [{ id: 'custom-bad', baseTheme: 'dark', colors: {} }],
    })
    expect(theme.validCustomThemes).toHaveLength(0)
  })

  it('a selected malformed entry falls back to the Base Theme it names', async () => {
    const theme = await load({
      selected: 'custom-bad',
      customThemes: [{ id: 'custom-bad', baseTheme: 'lnl', colors: { ring: 'nope' } }],
    })
    expect(theme.active).toBe('lnl')
    expect(theme.baseTheme).toBe('lnl')
  })
})

describe('Names', () => {
  it('come from the locale at creation and stay as created', () => {
    locale.state.THEME_NAME_CUSTOM = '{name} (eigenes)'
    const theme = useTheme()
    const id = theme.customize('dark')
    expect(theme.activeCustomTheme?.name).toBe('Dark (eigenes)')
    locale.state.THEME_NAME_CUSTOM = '{name} (custom)'
    expect(theme.validCustomThemes.find((t) => t.id === id)?.name).toBe('Dark (eigenes)')
  })
})

describe('Managing Custom Themes', () => {
  it('renames a Custom Theme and rejects an empty name', () => {
    const theme = useTheme()
    const id = theme.customize('dark')
    expect(theme.renameCustomTheme(id, '  Night  ')).toBe(true)
    expect(theme.activeCustomTheme?.name).toBe('Night')
    expect(theme.renameCustomTheme(id, '   ')).toBe(false)
    expect(theme.activeCustomTheme?.name).toBe('Night')
  })

  it('copies a Custom Theme with its Base Theme and colours under a unique name', () => {
    const theme = useTheme()
    const original = theme.customize('bmg')
    theme.setColor('accent', '#112233')
    theme.saveDraft()
    const copy = theme.copyCustomTheme(original)
    expect(copy).not.toBe(original)
    expect(theme.active).toBe(copy)
    expect(theme.activeCustomTheme).toMatchObject({
      name: 'Intel® Arc™ (custom) (copy)',
      baseTheme: 'bmg',
    })
    expect(theme.activeCustomTheme?.colors.accent).toBe('#112233')
    expect(theme.baseTheme).toBe('bmg')
    theme.copyCustomTheme(original)
    expect(theme.activeCustomTheme?.name).toBe('Intel® Arc™ (custom) (copy 2)')
    expect(theme.validCustomThemes).toHaveLength(3)
  })

  it('resets to the Base Theme colours, keeping id, name and selection', () => {
    const theme = useTheme()
    const id = theme.customize('dark')
    theme.renameCustomTheme(id, 'Mine')
    const shippedBorder = theme.activeHexColors.border
    theme.setColor('border', '#ffffff')
    theme.setColor('ring', '#00ff00')
    theme.saveDraft()
    expect(theme.resetTargetFor(id)?.name).toBe('Dark')
    theme.resetCustomTheme(id)
    expect(theme.active).toBe(id)
    expect(theme.activeCustomTheme).toMatchObject({ id, name: 'Mine', baseTheme: 'dark' })
    expect(theme.activeHexColors.border).toBe(shippedBorder)
    expect(theme.activeHexColors.ring).toBe('#aa05fd')
  })

  it('deleting the selected Custom Theme selects its Base Theme', () => {
    const theme = useTheme()
    const id = theme.customize('lnl')
    theme.deleteCustomTheme(id)
    expect(theme.validCustomThemes).toHaveLength(0)
    expect(theme.active).toBe('lnl')
  })

  it('deleting another Custom Theme keeps the selection', () => {
    const theme = useTheme()
    const other = theme.customize('dark')
    const kept = theme.customize('bmg')
    theme.deleteCustomTheme(other)
    expect(theme.validCustomThemes.map((t) => t.id)).toEqual([kept])
    expect(theme.active).toBe(kept)
  })

  it('offers no rename, reset or delete on a Built-in Theme', () => {
    const theme = useTheme()
    theme.selectTheme('bmg')
    expect(theme.renameCustomTheme('bmg', 'Renamed')).toBe(false)
    expect(theme.resetTargetFor('bmg')).toBeNull()
    theme.resetCustomTheme('bmg')
    theme.deleteCustomTheme('bmg')
    expect(theme.active).toBe('bmg')
    expect(theme.builtInThemes.map((t) => t.name)).toContain('Intel® Arc™')
    expect(theme.activeColors.background).toBe('280 50% 10%')
  })
})

describe('A Custom Theme whose Base Theme no longer ships', () => {
  const orphan = {
    id: 'custom-orphan',
    name: 'Retro',
    baseTheme: 'retired',
    colors: {} as Record<string, string>,
  }

  async function loadOrphan() {
    for (const token of useTheme().colorTokens)
      orphan.colors[token] = token.endsWith('foreground') ? '#f0f0f0' : '#203040'
    storedSections.value = { theme: { selected: orphan.id, customThemes: [orphan] } }
    setActivePinia(createPinia())
    const theme = useTheme()
    await theme.init()
    return theme
  }

  it('keeps its colours and gets no decorations', async () => {
    const theme = await loadOrphan()
    expect(theme.active).toBe(orphan.id)
    expect(theme.activeHexColors.background).toBe('#203040')
    expect(theme.baseTheme).toBeNull()
  })

  it('resets to Light and adopts it as its Base Theme', async () => {
    const theme = await loadOrphan()
    expect(theme.resetTargetFor(orphan.id)?.name).toBe('Light')
    theme.resetCustomTheme(orphan.id)
    expect(theme.activeCustomTheme).toMatchObject({
      id: orphan.id,
      name: 'Retro',
      baseTheme: 'light',
    })
    expect(theme.activeColors.foreground).toBe('222.2 47.4% 11.2%')
    expect(theme.baseTheme).toBe('light')
  })

  it('deleting it while selected selects Light', async () => {
    const theme = await loadOrphan()
    theme.deleteCustomTheme(orphan.id)
    expect(theme.active).toBe('light')
    expect(theme.validCustomThemes).toHaveLength(0)
  })
})
