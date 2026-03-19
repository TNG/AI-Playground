import { usePresets } from './presets'
import { useTextInference } from './textInference'
import { usePromptStore } from './promptArea'
import demoInputImageUrl from '@/assets/image/dog_with_people.jpg'

export type DemoImageEditFeature = 'upscale' | 'prompt' | 'inpaint' | 'outpaint'

export const DEMO_CHAT_PRESET = 'Vision'
export const DEMO_CHAT_MODEL = 'unsloth/Qwen3-VL-4B-Instruct-GGUF/Qwen3-VL-4B-Instruct-Q5_K_S.gguf'
export const DEMO_IMAGEGEN_PRESET = 'Pro Image'
export const DEMO_IMAGEEDIT_PRESET = 'Edit by Prompt 2'
export const DEMO_IMAGEEDIT_FEATURE: DemoImageEditFeature = 'prompt'

export async function applyDemoModeExplicitDefaults(): Promise<{
  imageEditFeature: DemoImageEditFeature
}> {
  const presetsStore = usePresets()
  const textInference = useTextInference()
  const promptStore = usePromptStore()

  // force Vision as the chat preset source of truth
  presetsStore.setLastUsedPreset('chat', DEMO_CHAT_PRESET)

  // always start in chat mode; preset load now goes through the single mode entrypoint
  promptStore.setCurrentMode('chat')

  // set model to 'qwen-vl' (exact hardcoded model id)
  textInference.backend = 'llamaCPP'
  textInference.selectModel('llamaCPP', DEMO_CHAT_MODEL)

  // set 'imagegen' to 'hdmode' (mapped to preset name "HD Image")
  presetsStore.setLastUsedPreset('create-images', DEMO_IMAGEGEN_PRESET)

  // set imageedit to 'edit by prompt' (dog-on-a-beach input is preloaded in imageGeneration demo logic)
  presetsStore.setLastUsedPreset('edit-images', DEMO_IMAGEEDIT_PRESET)

  return {
    imageEditFeature: DEMO_IMAGEEDIT_FEATURE,
  }
}

export function getDemoModeInputImage(): string | null {
  return demoInputImageUrl
}
