<template>
  <TooltipProvider v-if="indicator" :delay-duration="0">
    <div class="flex flex-none items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger as-child>
          <button
            type="button"
            class="flex h-6 flex-none items-center gap-1 rounded-md border px-1.5 transition-colors"
            :class="chipClass"
            :aria-label="languages.SESSIONS_IN_OVERVIEWS"
            :aria-pressed="included"
            @click="overviews.activate()"
          >
            <ArrowPathIcon v-if="pending" class="size-3.5 animate-spin" aria-hidden="true" />
            <ExclamationTriangleIcon v-else-if="failed" class="size-3.5" aria-hidden="true" />
            <DocumentTextIcon v-else class="size-3.5" aria-hidden="true" />
            <span>{{ languages.SESSIONS_IN_OVERVIEWS_CHIP }}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" class="max-w-64">
          {{ hint }}
          <p class="mt-1 text-primary-foreground/70">
            {{ languages.SESSIONS_IN_OVERVIEWS_GENERATE }}
          </p>
        </TooltipContent>
      </Tooltip>
      <Tooltip v-if="failed">
        <TooltipTrigger as-child>
          <button
            type="button"
            class="flex h-6 flex-none items-center rounded-md border border-warning/60 px-1.5 text-warning transition-colors hover:bg-warning/10"
            :aria-label="languages.SESSION_OVERVIEW_UPDATE_RETRY"
            @click="overviews.retry()"
          >
            <ArrowPathIcon class="size-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{{ languages.SESSION_OVERVIEW_UPDATE_RETRY }}</TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ArrowPathIcon, DocumentTextIcon, ExclamationTriangleIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionOverviews } from '@/lib/useSessionOverviews'

const languages = useI18N().state
const overviews = useSessionOverviews()
const indicator = overviews.indicator

const included = computed(() => indicator.value?.included === true)
const pending = computed(() => indicator.value?.state === 'pending')
const failed = computed(() => indicator.value?.state === 'failed')

const chipClass = computed(() => {
  if (pending.value) return 'border-primary/60 bg-primary/10 text-primary'
  if (failed.value) return 'border-warning/60 bg-warning/10 text-warning'
  return included.value
    ? 'border-primary/60 bg-primary/10 text-primary'
    : 'border-border text-muted-foreground hover:text-foreground'
})

const hint = computed(() => {
  const state = indicator.value?.state
  if (state === 'pending') return languages.SESSIONS_IN_OVERVIEWS_PENDING
  if (state === 'failed') return languages.SESSIONS_IN_OVERVIEWS_FAILED
  return included.value ? languages.SESSIONS_IN_OVERVIEWS_ON : languages.SESSIONS_IN_OVERVIEWS_OFF
})
</script>
