import { defineStore } from 'pinia'
import { ref } from 'vue'
import { acceptHMRUpdate } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'

export const useDeveloperSettings = defineStore(
  'developerSettings',
  () => {
    const openDevConsoleOnStartup = ref(false)
    const keepModelsLoaded = ref(false)
    // Restricts the media tool catalogs to the dev-only dummy workflows
    // (see devPresets.ts), so a media turn finishes in seconds instead of
    // minutes. Without it, which workflow runs is up to the model.
    const forceDummyMediaWorkflows = ref(false)

    return {
      openDevConsoleOnStartup,
      keepModelsLoaded,
      forceDummyMediaWorkflows,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: ['openDevConsoleOnStartup', 'keepModelsLoaded', 'forceDummyMediaWorkflows'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDeveloperSettings, import.meta.hot))
}
