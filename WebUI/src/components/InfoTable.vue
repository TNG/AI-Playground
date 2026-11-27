<template>
  <div
    v-if="props.generationParameters"
    class="info-params absolute px-5 pt-8 pb-5 text-foreground w-1000"
  >
    <button
      class="w-5 h-5 svg-icon i-close absolute right-2 top-2 text-foreground hover:text-foreground/80"
      @click="emits('close')"
    ></button>
    <div class="params-list">
      <ul class="border border-border">
        <li
          v-for="(value, key) in props.generationParameters"
          class="last:border-none border-b border-border flex items-center"
          :key="key"
        >
          <span class="text-base font-bold px-4 items-stretch w-36 flex-none">{{
            languages[generationSettingLabelKeys[key]] ?? key
          }}</span>
          <span class="px-4 flex-auto break-word">{{ value }}</span>
        </li>
      </ul>
      <ul class="border border-border">
        <li
          v-for="value in props.dynamicInputs"
          class="last:border-none border-b border-border flex items-center"
          :key="value.label"
        >
          <span class="text-base font-bold px-4 items-stretch w-36 flex-none">{{
            languages[getTranslationLabel('SETTINGS_IMAGE_COMFY_', value.label)] ?? value.label
          }}</span>
          <img
            v-if="value.type === 'image'"
            :src="String(value.current ?? '')"
            class="info-params-image"
          />
          <span v-else class="px-4 flex-auto break-word">{{ String(value.current ?? '') }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
<script setup lang="ts">
import {
  ComfyDynamicInputWithCurrent,
  GenerationSettings,
} from '@/assets/js/store/imageGenerationPresets'
import { generationSettingLabelKeys } from '@/lib/generationSettingLabels'
import { getTranslationLabel } from '@/lib/utils'
import { useI18N } from '@/assets/js/store/i18n'

const props = defineProps<{
  generationParameters: GenerationSettings
  dynamicInputs?: ComfyDynamicInputWithCurrent[]
}>()

const i18nState = useI18N().state
const languages = i18nState

const emits = defineEmits<{
  (e: 'close'): void
}>()
</script>
