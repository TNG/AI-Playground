<template>
  <TooltipProvider v-if="indicator" :delay-duration="0">
    <Tooltip>
      <TooltipTrigger as-child>
        <!-- aria-disabled rather than disabled, which would also swallow the hover that shows the reason. -->
        <button
          type="button"
          class="flex h-6 flex-none items-center gap-1 rounded-md border px-1.5 transition-colors"
          :class="
            reachable
              ? 'border-primary/60 bg-primary/10 text-primary'
              : blocked
                ? 'cursor-not-allowed border-border text-muted-foreground/60'
                : 'border-border text-muted-foreground hover:text-foreground'
          "
          :aria-label="languages.SESSIONS_REACHABLE"
          :aria-pressed="reachable"
          :aria-disabled="blocked || undefined"
          @click="reachability.activate()"
        >
          <ChatBubbleLeftRightIcon class="size-3.5" aria-hidden="true" />
          <span>{{ languages.SESSIONS_REACHABLE_CHIP }}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" class="max-w-64">{{ hint }}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ChatBubbleLeftRightIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionReachability } from '@/lib/useSessionReachability'

const languages = useI18N().state
const reachability = useSessionReachability()
const indicator = reachability.indicator

const reachable = computed(() => indicator.value?.action === 'toggle' && indicator.value.reachable)
const blocked = computed(() => indicator.value?.action === 'blocked')

const hint = computed(() => {
  switch (indicator.value?.action) {
    case 'setUp':
      return languages.SESSIONS_REACHABLE_SET_UP
    case 'blocked':
      return languages.SESSIONS_REACHABLE_REAL_SHELL
    default:
      return reachable.value ? languages.SESSIONS_REACHABLE_ON : languages.SESSIONS_REACHABLE_OFF
  }
})
</script>
