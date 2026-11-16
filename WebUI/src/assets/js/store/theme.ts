import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { createAppError } from '@/assets/js/errors/appError'
import { useErrors } from '@/assets/js/store/errors'
import { makeFileBackedPreference } from '@/lib/fileBackedPreferences'
import { fillTemplate } from '@/lib/fillTemplate'
import {
  builtInThemes,
  fallbackBuiltInTheme,
  themeTokens,
  type BuiltInTheme,
  type ThemeColors,
  type ThemeToken,
} from '@/lib/builtInThemes'
import {
  isHexColor,
  toHexColors,
  toHslColors,
  type HexColor,
  type HexThemeColors,
} from '@/lib/themeColors'
import { findUnreadablePair, type CorePair, type UnreadablePair } from '@/lib/themeContrast'
import {
  deriveThemeColors,
  derivedColorTokens,
  isMainColorToken,
  mainColorTokens,
  mainColorsOf,
} from '@/lib/themeDerivation'

export type EditingMode = 'simple' | 'advanced'

export type CustomTheme = {
  id: string
  name: string
  baseTheme: Theme
  mode: EditingMode
  colors: HexThemeColors
}

type ThemeDraft = { mode: EditingMode; colors: HexThemeColors }

const editingModes: readonly unknown[] = ['simple', 'advanced'] satisfies EditingMode[]

const derivedFrom = (colors: HexThemeColors) => deriveThemeColors(mainColorsOf(colors))

export type ReadabilityVerdict = { readable: true } | ({ readable: false } & UnreadablePair)

const pairLabelKeys: Record<CorePair['text'], string> = {
  foreground: 'SETTINGS_THEME_PAIR_FOREGROUND',
  'primary-foreground': 'SETTINGS_THEME_PAIR_PRIMARY_FOREGROUND',
}

/** Floors at two decimals so a ratio just under the minimum never reads as 3.00. */
const formatRatio = (ratio: number) => (Math.floor(ratio * 100) / 100).toFixed(2)

type ResolvedTheme = {
  id: string
  colors: ThemeColors
  hexColors: HexThemeColors
  baseId: Theme | null
  custom: CustomTheme | null
}

const findBuiltIn = (id: unknown) => builtInThemes.find((t) => t.id === id)

const builtInOrFallback = (id: unknown): BuiltInTheme => findBuiltIn(id) ?? fallbackBuiltInTheme

const shippedColors = (id: unknown) => toHexColors(builtInOrFallback(id).colors)

const asRecord = (value: unknown) =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null

/**
 * Fills tokens an older version did not have from the Base Theme; null for anything malformed.
 * An entry from before Editing Modes loads as Simple, its Derived Colours recalculated.
 */
function readCustomTheme(value: unknown): CustomTheme | null {
  const t = asRecord(value)
  const stored = asRecord(t?.colors)
  if (!t || !stored) return null
  if (typeof t.id !== 'string' || typeof t.name !== 'string' || typeof t.baseTheme !== 'string')
    return null
  if (t.mode !== undefined && !editingModes.includes(t.mode)) return null
  const fill = shippedColors(t.baseTheme)
  const colors = {} as HexThemeColors
  for (const token of themeTokens) {
    const color = stored[token] ?? fill[token]
    if (!isHexColor(color)) return null
    colors[token] = color
  }
  const base = { id: t.id, name: t.name, baseTheme: t.baseTheme as Theme }
  if (t.mode === undefined) return { ...base, mode: 'simple', colors: derivedFrom(colors) }
  return { ...base, mode: t.mode as EditingMode, colors }
}

const unreadablePairOf = (theme: CustomTheme) => findUnreadablePair(theme.colors)

function uniqueName(first: string, numbered: (n: number) => string, taken: Set<string>): string {
  if (!taken.has(first)) return first
  for (let n = 2; ; n++) if (!taken.has(numbered(n))) return numbered(n)
}

export const useTheme = defineStore('theme', () => {
  const i18n = useI18N()
  const errors = useErrors()
  const selected = ref<string | null>(null)
  const customThemes = ref<CustomTheme[]>([])
  const draft = ref<ThemeDraft | null>(null)
  const pendingAction = ref<(() => void) | null>(null)

  // Step 8 (§6.1): the theme choice is a kernel-owned preference
  // (preferences.json), hydrated before mount and written through.
  const prefs = makeFileBackedPreference({
    section: 'theme',
    refs: { selected, customThemes },
    legacyKey: 'theme',
  })
  if (import.meta.hot) import.meta.hot.dispose(() => prefs.dispose())

  const storedEntries = computed<unknown[]>(() =>
    Array.isArray(customThemes.value) ? customThemes.value : [],
  )

  // A hand-edited file may hold anything: malformed entries are ignored and dropped on the next write.
  const validCustomThemes = computed(() =>
    storedEntries.value.map(readCustomTheme).filter((t): t is CustomTheme => !!t),
  )

  const selectedCustomTheme = computed(() =>
    validCustomThemes.value.find((t) => t.id === selected.value),
  )

  const selectedEntryBase = computed(
    () => storedEntries.value.map(asRecord).find((t) => t?.id === selected.value)?.baseTheme,
  )

  /** A selected Custom Theme that fails the guard (a hand-edited file) shows its Base Theme. */
  const unreadableSelection = computed(() => {
    const custom = selectedCustomTheme.value
    const pair = custom && unreadablePairOf(custom)
    return custom && pair ? { theme: custom, pair } : null
  })

  const resolved = computed<ResolvedTheme>(() => {
    const custom = selectedCustomTheme.value
    if (custom && !unreadableSelection.value) {
      const baseId = findBuiltIn(custom.baseTheme)?.id ?? null
      const colors = toHslColors(custom.colors)
      return { id: custom.id, colors, hexColors: custom.colors, baseId, custom }
    }
    const builtIn = findBuiltIn(selected.value) ?? builtInOrFallback(selectedEntryBase.value)
    const hexColors = toHexColors(builtIn.colors)
    return { id: builtIn.id, colors: builtIn.colors, hexColors, baseId: builtIn.id, custom: null }
  })

  /** The theme the editor works on: the selected Custom Theme even while it is not applied. */
  const edited = computed<ThemeDraft>(() => {
    const custom = selectedCustomTheme.value
    return custom ?? { mode: 'simple', colors: resolved.value.hexColors }
  })

  const pairLabel = (pair: UnreadablePair) => i18n.state[pairLabelKeys[pair.text]]

  const fallbackMessage = computed(() => {
    const unreadable = unreadableSelection.value
    const template = i18n.state.SETTINGS_THEME_UNREADABLE_FALLBACK
    if (!unreadable || !template) return ''
    return fillTemplate(template, {
      name: unreadable.theme.name,
      text: pairLabel(unreadable.pair),
      base: builtInOrFallback(unreadable.theme.baseTheme).name,
    })
  })

  function reportUnreadableSelection() {
    const unreadable = unreadableSelection.value
    if (!unreadable) return
    const { theme, pair } = unreadable
    errors.report(
      createAppError({
        code: 'theme/unreadable',
        category: 'validation',
        severity: 'warning',
        userMessage: fallbackMessage.value,
        technicalMessage: `Custom Theme ${theme.id}: ${pair.text} on ${pair.background} is ${pair.ratio.toFixed(2)}:1`,
      }),
    )
  }

  // Theme hydrates before the locale loads, so the startup report waits for its string.
  function reportUnreadableSelectionWhenTranslated() {
    if (!unreadableSelection.value) return
    if (i18n.state.SETTINGS_THEME_UNREADABLE_FALLBACK) return reportUnreadableSelection()
    const stop = watch(
      () => i18n.state.SETTINGS_THEME_UNREADABLE_FALLBACK,
      (message) => {
        if (!message) return
        stop()
        reportUnreadableSelection()
      },
    )
  }

  function newName(key: string, numberedKey: string, name: string): string {
    const taken = new Set(validCustomThemes.value.map((t) => t.name))
    return uniqueName(
      fillTemplate(i18n.state[key] ?? '{name}', { name }),
      (n) => fillTemplate(i18n.state[numberedKey] ?? '{name} {n}', { name, n }),
      taken,
    )
  }

  function addAndSelect(theme: Omit<CustomTheme, 'id'>): string {
    const id = `custom-${crypto.randomUUID()}`
    customThemes.value = [...validCustomThemes.value, { id, ...theme }]
    selected.value = id
    discardDraft()
    return id
  }

  function updateCustomTheme(id: string, change: (t: CustomTheme) => CustomTheme) {
    customThemes.value = validCustomThemes.value.map((t) => (t.id === id ? change(t) : t))
  }

  function selectTheme(id: string) {
    if (!findBuiltIn(id) && !validCustomThemes.value.some((t) => t.id === id)) return
    selected.value = id
    discardDraft()
    reportUnreadableSelection()
  }

  /** Copies a Built-in Theme (the active one's Base Theme by default) and selects the copy. */
  function customize(from: Theme = resolved.value.baseId ?? fallbackBuiltInTheme.id): string {
    const source = builtInOrFallback(from)
    return addAndSelect({
      name: newName('THEME_NAME_CUSTOM', 'THEME_NAME_CUSTOM_N', source.name),
      baseTheme: source.id,
      mode: 'simple',
      colors: toHexColors(source.colors),
    })
  }

  const current = computed(() => draft.value ?? edited.value)
  const draftHexColors = computed(() => current.value.colors)
  const editingMode = computed(() => current.value.mode)

  const hasUnsavedChanges = computed(() => {
    const changed = draft.value
    if (!changed) return false
    const saved = edited.value
    return (
      changed.mode !== saved.mode ||
      themeTokens.some((token) => changed.colors[token] !== saved.colors[token])
    )
  })

  /** The Derived Colours a switch to Simple mode would recalculate: those set by hand. */
  const simpleModeRecalculates = computed<ThemeToken[]>(() => {
    if (editingMode.value === 'simple') return []
    const colors = draftHexColors.value
    const derived = derivedFrom(colors)
    return derivedColorTokens.filter((token) => derived[token] !== colors[token])
  })

  const draftVerdict = computed<ReadabilityVerdict>(() => {
    const unreadable = findUnreadablePair(draftHexColors.value)
    return unreadable ? { readable: false, ...unreadable } : { readable: true }
  })

  const draftWarning = computed(() => {
    const verdict = draftVerdict.value
    if (verdict.readable) return ''
    return fillTemplate(i18n.state.SETTINGS_THEME_UNREADABLE, {
      text: pairLabel(verdict),
      ratio: formatRatio(verdict.ratio),
    })
  })

  const canSave = computed(() => hasUnsavedChanges.value && draftVerdict.value.readable)

  /**
   * Changes the draft only; nothing is applied until `saveDraft`. In Simple mode only a Main
   * Colour can be set, and every Derived Colour follows it.
   */
  function setColor(token: ThemeToken, hex: HexColor): boolean {
    const mode = editingMode.value
    if (!isHexColor(hex) || (mode === 'simple' && !isMainColorToken(token))) return false
    const colors = { ...draftHexColors.value, [token]: hex.toLowerCase() }
    draft.value = { mode, colors: mode === 'simple' ? derivedFrom(colors) : colors }
    return true
  }

  /** Switching to Simple recalculates `simpleModeRecalculates`; the editor confirms that first. */
  function setEditingMode(mode: EditingMode) {
    if (mode === editingMode.value) return
    const colors = draftHexColors.value
    draft.value = { mode, colors: mode === 'simple' ? derivedFrom(colors) : { ...colors } }
  }

  /** Applies a readable draft; a draft of a Built-in Theme becomes a new, selected Custom Theme. */
  function saveDraft(): boolean {
    const changed = draft.value
    if (!changed || !canSave.value) return false
    const id = selectedCustomTheme.value?.id ?? customize()
    updateCustomTheme(id, (t) => ({ ...t, ...changed }))
    draft.value = null
    return true
  }

  function discardDraft() {
    draft.value = null
    pendingAction.value = null
  }

  /** Runs `action` now, or once the user agrees to discard unsaved changes (`confirmDiscard`). */
  function guardUnsaved(action: () => void) {
    if (!hasUnsavedChanges.value) return action()
    pendingAction.value = action
  }

  function confirmDiscard() {
    const action = pendingAction.value
    discardDraft()
    action?.()
  }

  /** Returns false, changing nothing, for a blank name. */
  function renameCustomTheme(id: string, name: string): boolean {
    const trimmed = name.trim()
    if (!trimmed || !validCustomThemes.value.some((t) => t.id === id)) return false
    updateCustomTheme(id, (t) => ({ ...t, name: trimmed }))
    return true
  }

  /** Copies a Custom Theme, keeping its Base Theme, and selects the copy. */
  function copyCustomTheme(id: string): string | null {
    const source = validCustomThemes.value.find((t) => t.id === id)
    if (!source) return null
    return addAndSelect({
      name: newName('THEME_NAME_COPY', 'THEME_NAME_COPY_N', source.name),
      baseTheme: source.baseTheme,
      mode: source.mode,
      colors: { ...source.colors },
    })
  }

  /** The Built-in Theme a reset or delete leads to: the Base Theme, or the fallback when it is gone. */
  function resetTargetFor(id: string): BuiltInTheme | null {
    const custom = validCustomThemes.value.find((t) => t.id === id)
    return custom ? builtInOrFallback(custom.baseTheme) : null
  }

  function resetCustomTheme(id: string) {
    const target = resetTargetFor(id)
    if (!target) return
    updateCustomTheme(id, (t) => ({
      ...t,
      baseTheme: target.id,
      mode: 'simple',
      colors: toHexColors(target.colors),
    }))
    if (selected.value === id) discardDraft()
  }

  function deleteCustomTheme(id: string) {
    const target = resetTargetFor(id)
    if (!target) return
    customThemes.value = validCustomThemes.value.filter((t) => t.id !== id)
    if (selected.value !== id) return
    selected.value = target.id
    discardDraft()
  }

  return {
    selected,
    customThemes,
    builtInThemes,
    colorTokens: themeTokens,
    validCustomThemes,
    active: computed(() => resolved.value.id),
    selectedId: computed(() => selectedCustomTheme.value?.id ?? resolved.value.id),
    activeCustomTheme: computed(() => resolved.value.custom),
    editedCustomTheme: computed(() => selectedCustomTheme.value ?? null),
    /** A Custom Theme whose Base Theme no longer ships gets no decorations. */
    baseTheme: computed(() => resolved.value.baseId),
    activeColors: computed(() => resolved.value.colors),
    activeHexColors: computed(() => resolved.value.hexColors),
    mainColorTokens,
    draftHexColors,
    editingMode,
    simpleModeRecalculates,
    draftVerdict,
    draftWarning,
    hasUnsavedChanges,
    canSave,
    discardPending: computed(() => !!pendingAction.value),
    fallbackMessage,
    selectTheme,
    customize,
    setColor,
    setEditingMode,
    saveDraft,
    discardDraft,
    guardUnsaved,
    confirmDiscard,
    cancelDiscard: () => (pendingAction.value = null),
    init: async () => {
      await prefs.init()
      reportUnreadableSelectionWhenTranslated()
    },
    renameCustomTheme,
    copyCustomTheme,
    resetTargetFor,
    resetCustomTheme,
    deleteCustomTheme,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTheme, import.meta.hot))
}
