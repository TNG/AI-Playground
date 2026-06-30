<script setup lang="ts">
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'

const props = defineProps<{
  text?: string
  startedAt?: number
  finishedAt?: number
  streaming?: boolean
  // Wall-clock start of the live reasoning block, supplied by the store while
  // `streaming` is true. The part's own `startedAt`/`finishedAt` metadata is
  // only attached once the block finishes, so the increasing timer relies on
  // this instead.
  liveStartedAt?: number
  onCopy?: (text: string) => void
}>()

const isExpanded = ref(false)

// Reactive "now" so the elapsed timer actually advances while streaming —
// `Date.now()` on its own is not reactive and would freeze the displayed value.
const now = ref(Date.now())
let tickHandle: ReturnType<typeof setInterval> | undefined
watch(
  () => props.streaming,
  (streaming) => {
    clearInterval(tickHandle)
    tickHandle = undefined
    if (streaming) {
      now.value = Date.now()
      tickHandle = setInterval(() => (now.value = Date.now()), 100)
    }
  },
  { immediate: true },
)
onUnmounted(() => clearInterval(tickHandle))

const elapsedSeconds = computed(() => {
  if (props.streaming) {
    const start = props.liveStartedAt || props.startedAt
    if (!start) return '0.0'
    return ((now.value - start) / 1000).toFixed(1)
  }
  if (!props.startedAt) return '0.0'
  return (((props.finishedAt ?? props.startedAt) - props.startedAt) / 1000).toFixed(1)
})

const statusText = computed(() => {
  if (!props.streaming && props.finishedAt && props.startedAt) {
    return `Done Reasoning after ${elapsedSeconds.value} seconds`
  }
  return `Reasoned for ${elapsedSeconds.value} seconds`
})
</script>

<template>
  <div>
    <button @click="isExpanded = !isExpanded" class="flex items-center cursor-pointer">
      <span class="italic text-muted-foreground">{{ statusText }}</span>
      <img v-if="isExpanded" src="../assets/svg/arrow-up.svg" class="w-4 h-4 ml-1" />
      <img v-else src="../assets/svg/arrow-down.svg" class="w-4 h-4 ml-1" />
    </button>
    <MarkdownRenderer
      v-if="isExpanded"
      class="border-l-2 border-border pl-4 text-muted-foreground"
      :content="text ?? ''"
      :on-copy="onCopy"
    />
  </div>
</template>
