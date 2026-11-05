<template>
  <div v-if="resultOnly" class="mx-auto flex w-full max-w-3xl flex-col gap-6">
    <slot name="result" />
  </div>
  <div v-else class="mx-auto flex w-full max-w-3xl flex-col gap-6">
    <slot name="prompt" />
    <div class="flex flex-col gap-3">
      <slot name="details" />
      <slot name="result" />
      <div v-if="$slots.footer" class="flex items-start gap-3">
        <span :class="textInference.iconSizeClass" class="shrink-0" aria-hidden="true" />
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { provide } from 'vue'
import { useTextInference } from '@/assets/js/store/textInference'
import { turnHeaderShownKey } from '@/lib/turnHeader'

const props = defineProps<{ resultOnly?: boolean }>()

provide(turnHeaderShownKey, !props.resultOnly)

const textInference = useTextInference()
</script>
