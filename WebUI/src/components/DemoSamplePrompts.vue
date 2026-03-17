<template>
  <div v-if="activeSample" class="flex flex-wrap justify-start gap-3 pb-3 w-full max-w-3xl">
    <button class="demo-sample-bubble" @click="applySample(activeSample)">
      <span class="demo-sample-title">{{ activeSample.title }}</span>
      <span class="demo-sample-description">{{ activeSample.description }}</span>
      <span class="demo-sample-prompt">"{{ activeSample.prompt }}"</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { usePromptStore } from '@/assets/js/store/promptArea'

type SamplePrompt = {
  title: string
  description: string
  prompt: string
  mode: ModeType
}

const promptStore = usePromptStore()

const samples: SamplePrompt[] = [
  {
    title: 'Science Chat',
    description: 'Ask a science question and get an answer.',
    prompt: 'Why does water expand when it freezes?',
    mode: 'chat',
  },
  {
    title: 'Image Generation',
    description: 'Create a fantastic image from a detailed prompt.',
    prompt:
      'A close-up photo of a hummingbird hovering to get nectar from a red rose with drops of dew. Iridescent blue and green feathers, wings a blur. Depth of field. High Dynamic Range.',
    mode: 'imageGen',
  },
  {
    title: 'Image Editing',
    description: 'Edit a photo by describing what to change.',
    prompt: 'Remove people from the background',
    mode: 'imageEdit',
  },
  {
    title: 'Video Generation',
    description: 'Create a short video from a text description.',
    prompt: 'A golden retriever running through a field of sunflowers on a sunny day',
    mode: 'video',
  },
]

const activeSample = computed(() =>
  samples.find((s) => s.mode === promptStore.currentMode),
)

function applySample(sample: SamplePrompt) {
  // Insert the sample prompt into the textarea
  const textarea = document.getElementById('prompt-input') as HTMLTextAreaElement | null
  if (!textarea) return

  textarea.scrollIntoView({ behavior: 'smooth', block: 'center' })

  // Set value and trigger Vue reactivity via input event
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (nativeSetter) {
    nativeSetter.call(textarea, sample.prompt)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  }

  textarea.focus()
}
</script>

<style scoped>
.demo-sample-bubble {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px 16px;
  background: var(--demo-popover-bg);
  color: var(--demo-text-color);
  border: 1.5px solid var(--demo-popover-border);
  box-shadow: 0px 0.75px 4.95px var(--demo-popover-shadow);
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  max-width: 220px;
  width: 100%;
  font-family: 'IntelOne', sans-serif;
  transition:
    transform 0.3s ease,
    box-shadow 0.2s ease,
    border-color 0.2s ease;
  position: relative;
}

.demo-sample-bubble:hover {
  transform: translateY(-3px);
  box-shadow: 0px 1px 8px var(--demo-popover-shadow);
  border-color: color-mix(in srgb, var(--demo-popover-border) 80%, white);
}

/* Speech bubble arrow pointing downward */
.demo-sample-bubble::after {
  content: '';
  position: absolute;
  bottom: -10px;
  left: 24px;
  width: 0;
  height: 0;
  border-left: 10px solid transparent;
  border-right: 10px solid transparent;
  border-top: 10px solid var(--demo-popover-border);
}

.demo-sample-bubble::before {
  content: '';
  position: absolute;
  bottom: -7px;
  left: 25px;
  width: 0;
  height: 0;
  border-left: 9px solid transparent;
  border-right: 9px solid transparent;
  border-top: 9px solid var(--demo-popover-bg);
  z-index: 1;
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
</style>
