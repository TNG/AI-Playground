<template>
  <div class="flex flex-wrap justify-center gap-3 pb-3 w-full max-w-3xl">
    <button
      v-for="(sample, index) in samples"
      :key="index"
      class="demo-sample-bubble"
      @click="applySample(sample)"
    >
      <span class="demo-sample-title">{{ sample.title }}</span>
      <span class="demo-sample-description">{{ sample.description }}</span>
      <span class="demo-sample-prompt">"{{ sample.prompt }}"</span>
    </button>
  </div>
</template>

<script setup lang="ts">
type SamplePrompt = {
  title: string
  description: string
  prompt: string
}

const samples: SamplePrompt[] = [
  {
    title: 'Science Chat',
    description: 'Ask a science question and get an answer.',
    prompt: 'Why does water expand when it freezes?',
  },
  {
    title: 'Image Generation',
    description: 'Create a fantastic image from a detailed prompt.',
    prompt:
      'A close-up photo of a hummingbird hovering to get nectar from a red rose with drops of dew. Iridescent blue and green feathers, wings a blur. Depth of field. High Dynamic Range.',
  },
  {
    title: 'Image Editing',
    description: 'Edit a photo by describing what to change.',
    prompt: 'Remove people from the background',
  },
]

function applySample(sample: SamplePrompt) {
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
  background: #0a0622;
  color: white;
  border: 1.5px solid #00c4fa;
  box-shadow: 0px 0.75px 4.95px #00c4fa;
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  max-width: 220px;
  width: 100%;
  font-family: 'IntelOne', sans-serif;
  transition:
    box-shadow 0.2s ease,
    border-color 0.2s ease;
  position: relative;
}

.demo-sample-bubble:hover {
  box-shadow: 0px 1px 8px #00c4fa;
  border-color: #3be0ff;
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
  border-top: 10px solid #00c4fa;
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
  border-top: 9px solid #0a0622;
  z-index: 1;
}

.demo-sample-title {
  font-size: 0.875rem;
  font-weight: bold;
  color: #00bfff;
}

.demo-sample-description {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.7);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.demo-sample-prompt {
  font-size: 0.75rem;
  color: rgba(0, 196, 250, 0.8);
  font-style: italic;
  margin-top: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
