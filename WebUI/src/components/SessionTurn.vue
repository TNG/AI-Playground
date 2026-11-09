<template>
  <div class="flex w-full flex-col gap-6">
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

provide(turnHeaderShownKey, true)

const textInference = useTextInference()
</script>
