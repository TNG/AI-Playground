<script setup lang="ts">
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'

const props = defineProps<{
  text?: string
  startedAt?: number
  finishedAt?: number
  onCopy?: (text: string) => void
}>()

const isExpanded = ref(false)

const elapsedSeconds = computed(() => {
  if (!props.startedAt) return '0.0'
  return ((props.finishedAt! - props.startedAt) / 1000).toFixed(1)
})

const statusText = computed(() => {
  if (props.finishedAt && props.startedAt) {
    return `Done Reasoning after ${elapsedSeconds.value} seconds`
  }
  return `Reasoned for ${elapsedSeconds.value} seconds`
})
</script>

<template>
  <div class="mb-2">
    <div class="flex items-center">
      <span class="italic text-muted-foreground">{{ statusText }}</span>
      <button @click="isExpanded = !isExpanded" class="ml-1">
        <img v-if="isExpanded" src="../assets/svg/arrow-up.svg" class="w-4 h-4" />
        <img v-else src="../assets/svg/arrow-down.svg" class="w-4 h-4" />
      </button>
    </div>
    <MarkdownRenderer
      v-if="isExpanded"
      class="border-l-2 border-border pl-4 text-muted-foreground"
      :content="text ?? ''"
      :on-copy="onCopy"
    />
  </div>
</template>
