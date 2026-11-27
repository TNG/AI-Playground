import { computed } from 'vue'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import { usePresets, type Preset } from '@/assets/js/store/presets'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { useI18N } from '@/assets/js/store/i18n'
import { useErrors } from '@/assets/js/store/errors'
import { createAppError } from '@/assets/js/errors/appError'
import { presetGate, type PresetGate } from '@/lib/presetGate'
import { presetToMode } from '@/lib/presetModes'
import * as toast from '@/assets/js/toast'

/** The one preset switch behind every prompt-bar picker, gate included. */
export function usePromptBarPresetSwitch() {
  const presetSwitching = usePresetSwitching()
  const presetsStore = usePresets()
  const promptStore = usePromptStore()
  const backendServices = useBackendServices()
  const oemBranding = useOemBranding()
  const i18nState = useI18N().state
  const errors = useErrors()

  const phisonUsable = computed(
    () =>
      backendServices.phisonSsdDetected &&
      (backendServices.info.find((s) => s.serviceName === 'llamacpp-backend')
        ?.llamaCppPhisonArtifactReady ??
        false) &&
      backendServices.llamaCppBuildVariant === 'ssd-offload',
  )

  function gateOf(preset: Preset): PresetGate {
    return presetGate(preset, {
      phisonUsable: phisonUsable.value,
    })
  }

  async function switchTo(presetName: string, options: { announce?: boolean } = {}) {
    const preset = presetsStore.presets.find((p) => p.name === presetName)
    if (!preset) return false
    const gate = gateOf(preset)
    if (!gate.enabled) {
      if (gate.reason) toast.warning(i18nState[gate.reason])
      return false
    }
    const mode = presetToMode(preset)
    if (presetName === presetsStore.activePresetName && promptStore.getCurrentMode() === mode) {
      return true
    }
    if (presetSwitching.isSwitching) {
      toast.warning(i18nState.PROMPT_BAR_WAIT_FOR_PRESET_SWITCH)
      return false
    }
    if (!promptStore.ensureModeAvailable(mode)) return false

    const result = await presetSwitching.switchPreset(presetName)
    if (!result.success) {
      if (result.error) {
        // switchPreset has already shown the failure (toast or setup notice).
        errors.report(
          createAppError({
            category: 'setup',
            code: 'preset/prompt-bar-switch-failed',
            userMessage: 'Could not switch preset.',
            technicalMessage: result.error,
            surface: 'silent',
            context: { presetName },
          }),
        )
      }
      return false
    }
    if (options.announce !== false) {
      toast.success(
        i18nState.PROMPT_BAR_SWITCHED_TO_PRESET.replace(
          '{preset}',
          oemBranding.presetLabel(presetName),
        ),
      )
    }
    return true
  }

  return { gateOf, switchTo }
}
