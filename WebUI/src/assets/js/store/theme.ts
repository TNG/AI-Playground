import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { makeFileBackedPreference } from '@/lib/fileBackedPreferences'
import { builtInThemes, fallbackBuiltInTheme, themeTokens } from '@/lib/builtInThemes'

export const useTheme = defineStore('theme', () => {
  const selected = ref<Theme | null>(null)

  // Step 8 (§6.1): the theme choice is a kernel-owned preference
  // (preferences.json), hydrated before mount and written through.
  const prefs = makeFileBackedPreference({
    section: 'theme',
    refs: { selected },
    legacyKey: 'theme',
  })
  if (import.meta.hot) import.meta.hot.dispose(() => prefs.dispose())

  const activeTheme = computed(
    () => builtInThemes.find((t) => t.id === selected.value) ?? fallbackBuiltInTheme,
  )

  return {
    selected,
    builtInThemes,
    colorTokens: themeTokens,
    active: computed(() => activeTheme.value.id),
    /** What decorations and per-theme classes follow; a Built-in Theme is its own. */
    baseTheme: computed(() => activeTheme.value.id),
    activeColors: computed(() => activeTheme.value.colors),
    init: () => prefs.init(),
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTheme, import.meta.hot))
}
