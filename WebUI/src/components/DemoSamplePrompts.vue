<template>
  <div
    v-if="activeSample"
    role="group"
    aria-label="Example prompt"
    class="flex w-full flex-col gap-1 text-left"
    :class="
      props.inline
        ? 'rounded-md border border-border bg-card px-3 py-2'
        : 'z-[var(--demo-z-sample)] driver-active-element'
    "
    @mousedown.prevent
  >
    <div
      class="demo-sample-body"
      :class="{ 'demo-sample-body--inline': props.inline }"
      @click="applySample(activeSample)"
    >
      <span class="demo-sample-title">{{ activeSample.title }}</span>
      <span class="demo-sample-description">{{ activeSample.description }}</span>
      <span class="demo-sample-prompt">"{{ activeSample.prompt }}"</span>
      <button
        class="demo-sample-apply-btn z-[var(--demo-z-sample-btn)]"
        type="button"
        @click="applySample(activeSample)"
      >
        Apply ›
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { populateImageEditHistory } from '@/assets/js/store/demoModeDefaults'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { usePresets } from '@/assets/js/store/presets'
import { useErrors } from '@/assets/js/store/errors'
import { sampleFor } from '@/lib/demoSamplePrompts'

/** Inline: shown in the prompt area rather than as a driver.js-highlighted popover. */
const props = defineProps<{ inline?: boolean }>()

const promptStore = usePromptStore()
const imageGeneration = useImageGenerationPresets()
const demoMode = useDemoMode()
const presetsStore = usePresets()
const errors = useErrors()

const activeSample = computed(() =>
  sampleFor(demoMode.samplePrompts, promptStore.currentMode, presetsStore.activePreset?.name),
)

function applySample(sample: SamplePrompt) {
  if (sample.mode === 'imageEdit') {
    populateImageEditHistory(imageGeneration, sample.presetName).catch((e: unknown) =>
      errors.report(e, { surface: 'silent' }),
    )
  }
  promptStore.injectPromptText(sample.prompt)
  document.getElementById('prompt-input')?.focus()
}
</script>

<style scoped>
.demo-sample-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  cursor: pointer;
  font-family: 'IntelOne', sans-serif;
  max-width: 220px;
  width: 100%;
}

.demo-sample-body--inline {
  max-width: none;
}

.demo-sample-title {
  font-size: 0.875rem;
  font-weight: bold;
  color: var(--demo-title-color);
}

.demo-sample-description {
  font-size: 0.75rem;
  color: hsl(var(--muted-foreground));
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.demo-sample-prompt {
  font-size: 0.75rem;
  color: hsl(var(--muted-foreground));
  font-style: italic;
  margin-top: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.demo-sample-apply-btn {
  align-self: flex-end;
  margin-top: 4px;
  padding: 2px 10px;
  background: transparent;
  border: 1.5px solid var(--demo-accent);
  border-radius: 6px;
  color: var(--demo-accent);
  font-family: 'IntelOne', sans-serif;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.2s ease,
    color 0.2s ease;
}

.demo-sample-apply-btn:hover {
  background: var(--demo-accent);
  color: var(--demo-popover-bg);
}
</style>
