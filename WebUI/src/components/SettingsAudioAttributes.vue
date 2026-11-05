<template>
  <SettingsTabLayout v-if="isTtsPreset">
    <PresetVariantPicker @update:variant="changeVariant" />
    <template #machine>
      <SettingsTtsAttributes />
      <PresetResetButton
        :reset="resetSpeechSettings"
        :label="languages.AUDIO_RESET_SPEECH_DEFAULTS"
      />
    </template>
  </SettingsTabLayout>
  <div v-else-if="isSttPreset" class="flex flex-col gap-6 p-4 w-full max-w-3xl mx-auto">
    <PresetVariantPicker @update:variant="changeVariant" />
    <p class="text-sm text-muted-foreground">{{ languages.AUDIO_STT_NO_ATTRIBUTES }}</p>
  </div>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import PresetResetButton from '@/components/PresetResetButton.vue'
import PresetVariantPicker from '@/components/PresetVariantPicker.vue'
import SettingsTabLayout from '@/components/SettingsTabLayout.vue'
import SettingsTtsAttributes from '@/components/SettingsTtsAttributes.vue'
import { useActiveAudioPreset, useSpeechSettingsReset } from '@/assets/js/activeAudioPreset'
import { usePresetPicker } from '@/assets/js/presetPicker'

const languages = useI18N().state
const { isTtsPreset, isSttPreset } = useActiveAudioPreset()
const { resetSpeechSettings } = useSpeechSettingsReset()
const { changeVariant } = usePresetPicker({})
</script>
