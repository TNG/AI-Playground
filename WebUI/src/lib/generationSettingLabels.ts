import type { GenerationSettings } from '@/types/mediaItem'

/** The i18n key naming each generation setting wherever a run's parameters are listed. */
export const generationSettingLabelKeys: Record<keyof GenerationSettings, string> = {
  preset: 'SETTINGS_IMAGE_PRESET',
  variant: 'SETTINGS_IMAGE_VARIANT',
  device: 'DEVICE',
  negativePrompt: 'SETTINGS_MODEL_NEGATIVE_PROMPT',
  resolution: 'SETTINGS_MODEL_IMAGE_RESOLUTION',
  prompt: 'INPUT_PROMPT',
  inferenceSteps: 'SETTINGS_MODEL_IMAGE_STEPS',
  seed: 'SETTINGS_MODEL_SEED',
  safetyCheck: 'SETTINGS_MODEL_SAFE_CHECK',
  showPreview: 'SETTINGS_MODEL_SHOW_PREVIEW',
  batchSize: 'SETTINGS_MODEL_GENERATE_NUMBER',
  width: 'SETTINGS_MODEL_IMAGE_WIDTH',
  height: 'SETTINGS_MODEL_IMAGE_HEIGHT',
}
