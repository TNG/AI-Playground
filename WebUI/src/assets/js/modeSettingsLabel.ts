import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { mapModeToLabel } from '@/lib/utils'

/** "<Mode> Settings", named after the agent preset in Agent mode: there is no Agent mode button. */
export function useModeSettingsLabel(mode: MaybeRefOrGetter<ModeType>) {
  const agentMode = useAgentMode()
  const oemBranding = useOemBranding()

  return computed(() => {
    const current = toValue(mode)
    const agentPreset = current === 'agent' ? agentMode.activeAgentPreset?.name : undefined
    const label = agentPreset ? oemBranding.presetLabel(agentPreset) : mapModeToLabel(current)
    return `${label} Settings`
  })
}
