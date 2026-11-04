<template>
  <div class="flex flex-col gap-6">
    <slot name="prompt" />
    <div class="-mb-3 flex items-center gap-3">
      <span :class="textInference.iconSizeClass" class="shrink-0" aria-hidden="true" />
      <slot name="hint">
        <SessionTurnHint :hint="hint" />
      </slot>
    </div>
    <slot name="details" />
    <slot name="result" />
    <slot name="footer" />
  </div>
</template>

<script setup lang="ts">
import { useTextInference } from '@/assets/js/store/textInference'
import SessionTurnHint from '@/components/SessionTurnHint.vue'
import type { TurnHint } from '@/lib/sessionTimeline'

/** Every Turn of a Session in one shape: prompt, hint, Turn Details, Result, footer. */
defineProps<{ hint: TurnHint }>()

const textInference = useTextInference()
</script>
