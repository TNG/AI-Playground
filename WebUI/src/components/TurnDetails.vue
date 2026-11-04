<template>
  <div v-if="details.parts.length > 0 || details.error" class="flex items-start gap-3">
    <span :class="textInference.iconSizeClass" class="shrink-0" aria-hidden="true" />
    <Collapsible v-model:open="open" class="flex min-w-0 flex-1 flex-col gap-2">
      <CollapsibleTrigger as-child>
        <TurnDetailsHeader :summary="details.summary" :open="open" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div class="flex flex-col gap-3 border-l-2 border-border pl-4">
          <slot />
          <p
            v-if="details.error"
            class="text-sm text-destructive whitespace-pre-wrap wrap-break-word"
          >
            {{ details.error }}
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useTextInference } from '@/assets/js/store/textInference'
import TurnDetailsHeader from '@/components/TurnDetailsHeader.vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { TurnDetails } from '@/lib/sessionTimeline'

/** How a Turn reached its Result, collapsed under one line until the user opens it. */
defineProps<{ details: TurnDetails }>()

const textInference = useTextInference()
const open = ref(false)
</script>
