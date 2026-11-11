import { computed } from 'vue'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets'

/** The active chat preset, with its variant applied. */
export function useActiveChatPreset() {
  const presets = usePresets()

  const activeChatPreset = computed(() => {
    const preset = presets.activePresetWithVariant
    return preset?.type === 'chat' ? (preset as ChatPreset) : null
  })

  return { activeChatPreset }
}
