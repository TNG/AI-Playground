import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import { makeFileBackedPreference } from '@/lib/fileBackedPreferences'

/** Whether the prompt bar offers the Media Modes (Audio, Image Gen, Image Edit, Video). */
export const useMediaModes = defineStore('mediaModes', () => {
  const enabled = ref(true)

  const prefs = makeFileBackedPreference({ section: 'mediaModes', refs: { enabled } })
  if (import.meta.hot) import.meta.hot.dispose(() => prefs.dispose())

  return { enabled, init: () => prefs.init() }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMediaModes, import.meta.hot))
}
