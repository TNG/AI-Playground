<template>
  <div
    v-if="props.generationParameters"
    class="info-params absolute px-5 pt-8 pb-5 text-white w-1000"
  >
    <button
      class="w-5 h-5 svg-icon i-close absolute right-2 top-2"
      @click="emits('close')"
    ></button>
    <div class="params-list">
      <ul class="border border-color-spilter">
        <li
          v-for="(value, key) in filterRelevantInformation(props.generationParameters)"
          class="last:border-none border-b border-color-spilter flex items-center"
          :key="key"
        >
          <span class="text-base font-bold px-4 items-stretch w-36 flex-none">{{
            languages[settingToTranslationKey[key]] ?? key
          }}</span>
          <span class="px-4 flex-auto break-word">{{ value }}</span>
        </li>
      </ul>
      <ul class="border border-color-spilter">
        <li
          v-for="value in props.dynamicInputs"
          class="last:border-none border-b border-color-spilter flex items-center"
          :key="value.label"
        >
          <span class="text-base font-bold px-4 items-stretch w-36 flex-none">{{
            languages[getTranslationLabel('SETTINGS_IMAGE_COMFY_', value.label)] ?? value.label
          }}</span>
          <img v-if="value.type === 'image'" :src="value.current" class="info-params-image" />
          <span v-else class="px-4 flex-auto break-word">{{ value.current }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ComfyDynamicInputWithCurrent, GenerationSettings } from '@/assets/js/store/imageGeneration'
import { getTranslationLabel } from '@/lib/utils'

const props = defineProps<{
  generationParameters: GenerationSettings
  dynamicInputs?: ComfyDynamicInputWithCurrent[]
}>()

const notToDisplayKeys: (keyof GenerationSettings)[] = [
  'imagePreview',
  'batchSize',
  'width',
  'height',
]

const settingToTranslationKey: Record<keyof GenerationSettings, string> = {
  backend: 'BACKEND',
  workflow: 'SETTINGS_IMAGE_WORKFLOW',
  device: 'DEVICE',
  prompt: 'INPUT_PROMPT',
  width: 'SETTINGS_MODEL_IMAGE_WIDTH',
  height: 'SETTINGS_MODEL_IMAGE_HEIGHT',
  resolution: 'SETTINGS_MODEL_IMAGE_RESOLUTION',
  imagePreview: 'SETTINGS_MODEL_IMAGE_PREVIEW',
  inferenceSteps: 'SETTINGS_MODEL_IMAGE_STEPS',
  seed: 'SETTINGS_MODEL_SEED',
  batchSize: 'SETTINGS_MODEL_GENERATE_NUMBER',
  negativePrompt: 'SETTINGS_MODEL_NEGATIVE_PROMPT',
  safetyCheck: 'SETTINGS_MODEL_SAFE_CHECK',
  scheduler: 'SETTINGS_MODEL_SCHEDULER',
  guidanceScale: 'SETTINGS_MODEL_IMAGE_CFG',
  imageModel: 'DOWNLOADER_MODEL',
  inpaintModel: 'DOWNLOADER_FOR_INPAINT_GENERATE',
  lora: 'SETTINGS_MODEL_LORA',
}

const filterRelevantInformation = (
  generationParameters: GenerationSettings,
): GenerationSettings => {
  return Object.fromEntries(
    Object.entries(generationParameters).filter(
      ([key]) => !notToDisplayKeys.includes(key as keyof GenerationSettings),
    ),
  )
}

const emits = defineEmits<{
  (e: 'close'): void
}>()
</script>
