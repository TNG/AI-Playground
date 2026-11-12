import { computed } from 'vue'
import { usePresets } from '@/assets/js/store/presets'
import { useTextInference } from '@/assets/js/store/textInference'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { usePromptBarStyle } from '@/assets/js/store/promptBarStyle'
import type { Preset } from '@/lib/presetSchemas'
import { promptBarModel, type PromptBarMachine } from '@/lib/promptBarModel'
import { usePromptBarPresetSwitch } from '@/lib/usePromptBarPresetSwitch'
import { usePromptBarAgentPick } from '@/lib/usePromptBarAgentPick'

type PromptBarModelSource = {
  /** Defaults to the presets store's active preset. */
  activePreset?: () => Preset | null
  /** Defaults to the chat backend alone. */
  machine?: () => PromptBarMachine
}

/** The prompt-bar model every bar renders, built from the live stores. */
export function usePromptBarModel(source: PromptBarModelSource = {}) {
  const presetsStore = usePresets()
  const textInference = useTextInference()
  const oemBranding = useOemBranding()
  const promptBarStyle = usePromptBarStyle()
  const { gateOf } = usePromptBarPresetSwitch()
  const { agents, pickedAgentId } = usePromptBarAgentPick()

  return computed(() =>
    promptBarModel({
      activePreset: source.activePreset ? source.activePreset() : presetsStore.activePreset,
      presetLabel: (name) => oemBranding.presetLabel(name),
      machine: source.machine ? source.machine() : { chatBackend: textInference.backend },
      catalog: presetsStore.getPresetsByCategories([]),
      lastUsed: presetsStore.lastUsedPresetsByMode,
      presetGate: gateOf,
      style: promptBarStyle.active,
      agents: agents.value,
      pickedAgentId: pickedAgentId.value,
    }),
  )
}
