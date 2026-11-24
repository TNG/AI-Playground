<template>
  <TooltipProvider v-if="indicator" :delay-duration="0">
    <Tooltip>
      <TooltipTrigger as-child>
        <button
          type="button"
          class="flex h-6 flex-none items-center gap-1 rounded-md border px-1.5 transition-colors"
          :class="
            included
              ? 'border-primary/60 bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:text-foreground'
          "
          :aria-label="languages.SESSIONS_IN_OVERVIEWS"
          :aria-pressed="included"
          @click="overviews.activate()"
        >
          <DocumentTextIcon class="size-3.5" aria-hidden="true" />
          <span>{{ languages.SESSIONS_IN_OVERVIEWS_CHIP }}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" class="max-w-64">{{ hint }}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { DocumentTextIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionOverviews } from '@/lib/useSessionOverviews'

const languages = useI18N().state
const overviews = useSessionOverviews()
const indicator = overviews.indicator

const included = computed(() => indicator.value?.included === true)

const hint = computed(() =>
  included.value ? languages.SESSIONS_IN_OVERVIEWS_ON : languages.SESSIONS_IN_OVERVIEWS_OFF,
)
</script>
