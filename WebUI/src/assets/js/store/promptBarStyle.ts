import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { makeFileBackedPreference } from '@/lib/fileBackedPreferences'

export type PromptBarStyle = 'classic' | 'modern'

export const PROMPT_BAR_STYLES: PromptBarStyle[] = ['modern', 'classic']

export const usePromptBarStyle = defineStore('promptBarStyle', () => {
  const selected = ref<PromptBarStyle | null>(null)

  const prefs = makeFileBackedPreference({ section: 'promptBarStyle', refs: { selected } })
  if (import.meta.hot) import.meta.hot.dispose(() => prefs.dispose())

  return {
    selected,
    active: computed<PromptBarStyle>(() =>
      selected.value && PROMPT_BAR_STYLES.includes(selected.value) ? selected.value : 'modern',
    ),
    init: () => prefs.init(),
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePromptBarStyle, import.meta.hot))
}
