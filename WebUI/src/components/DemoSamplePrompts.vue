<template>
  <div class="flex flex-wrap justify-center gap-3 w-full max-w-3xl">
    <button
      v-for="(sample, index) in samples"
      :key="index"
      class="flex flex-col items-start gap-1 px-4 py-3 rounded-lg border border-border bg-background/50 hover:bg-primary/10 hover:border-primary/40 transition-colors cursor-pointer text-left max-w-[220px] w-full"
      @click="applySample(sample)"
    >
      <span class="text-sm font-semibold text-foreground">{{ sample.title }}</span>
      <span class="text-xs text-muted-foreground line-clamp-2">{{ sample.description }}</span>
      <span class="text-xs text-primary/80 mt-1 italic line-clamp-2">"{{ sample.prompt }}"</span>
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
