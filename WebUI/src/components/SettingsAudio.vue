<template>
  <div class="flex flex-col gap-6 p-1">
    <PresetSelector
      type="chat"
      :categories="[AUDIO_CATEGORY]"
      :model-value="presetsStore.activePresetName || undefined"
      @update:model-value="handlePresetChange"
      @update:variant="handleVariantChange"
    />

    <!-- Text to Speech: a direct Qwen3-TTS / Kokoro synthesizer, no LLM controls. -->
    <SettingsTts v-if="isTtsPreset" />

    <!-- Speech to Text: a direct Whisper transcriber, no LLM controls. -->
    <SettingsStt v-else-if="isSttPreset" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import PresetSelector from '@/components/PresetSelector.vue'
import SettingsTts from '@/components/SettingsTts.vue'
import SettingsStt from '@/components/SettingsStt.vue'
import { AUDIO_CATEGORY, usePresets, type ChatPreset } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import * as toast from '@/assets/js/toast'

const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()

const activeAudioPreset = computed(() => {
  const preset = presetsStore.activePresetWithVariant
  if (preset?.type === 'chat') return preset as ChatPreset
  return null
})

const isTtsPreset = computed(() => activeAudioPreset.value?.ttsPreset === true)
const isSttPreset = computed(() => activeAudioPreset.value?.sttPreset === true)

async function handlePresetChange(presetName: string) {
  const result = await presetSwitching.switchPreset(presetName, {
    skipModeSwitch: true, // We're already in audio mode
  })
  if (result.success) {
    toast.success(`Switched to ${presetName}`)
  } else if (result.error) {
    toast.error(`Failed to switch preset: ${result.error}`)
  }
}

async function handleVariantChange(presetName: string, variantName: string | null) {
  if (!variantName) return
  const result = await presetSwitching.switchPreset(presetName, {
    variant: variantName,
    skipModeSwitch: true,
  })
  if (!result.success && result.error) {
    toast.error(`Failed to switch variant: ${result.error}`)
  }
}
</script>
