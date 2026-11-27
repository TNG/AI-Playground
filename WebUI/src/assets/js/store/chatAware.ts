import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import { makeFileBackedPreference } from '@/lib/fileBackedPreferences'
import type { ResponseLanguage } from '@/lib/responseLanguage'

/** Whether chat and agent turns tell the model to reply in the interface language by default. */
export const useChatAware = defineStore('chatAware', () => {
  const enabled = ref(true)

  const prefs = makeFileBackedPreference({ section: 'chatAware', refs: { enabled } })
  if (import.meta.hot) import.meta.hot.dispose(() => prefs.dispose())

  function responseLanguage(locale: string): ResponseLanguage {
    return { locale, chatAware: enabled.value }
  }

  return { enabled, responseLanguage, init: () => prefs.init() }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChatAware, import.meta.hot))
}
