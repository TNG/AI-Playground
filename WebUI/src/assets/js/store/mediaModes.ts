import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import { usePresets } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import { makeFileBackedPreference } from '@/lib/fileBackedPreferences'
import { mediaModeFallbackPreset } from '@/lib/mediaModeFallbackPreset'

/** Whether the prompt bar offers the Media Modes (Audio, Image Gen, Image Edit, Video). */
export const useMediaModes = defineStore('mediaModes', () => {
  const presets = usePresets()
  const globalSetup = useGlobalSetup()
  const presetSwitching = usePresetSwitching()

  const enabled = ref(true)

  const prefs = makeFileBackedPreference({ section: 'mediaModes', refs: { enabled } })
  if (import.meta.hot) import.meta.hot.dispose(() => prefs.dispose())

  // Waits for `running` so the switch sees the installed backends rather than an empty boot list.
  watch(
    [() => presets.activePreset, enabled, () => globalSetup.loadingState === 'running'],
    ([active, on, running]) => {
      const fallback = running ? mediaModeFallbackPreset(active ?? undefined, on) : null
      if (fallback) void presetSwitching.switchPreset(fallback)
    },
    { immediate: true },
  )

  return { enabled, init: () => prefs.init() }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMediaModes, import.meta.hot))
}
