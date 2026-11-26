<template>
  <p v-if="failure.state === 'failed'" role="status" class="truncate text-sm text-destructive">
    {{ languages.COM_GENERATE_FAILED
    }}<template v-if="failure.reason">: {{ failure.reason }}</template>
  </p>
  <p
    v-else
    role="status"
    class="inline-flex w-fit items-center gap-1.5 self-start rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium text-muted-foreground"
  >
    <StopCircleIcon class="size-3.5 shrink-0" aria-hidden="true" />
    {{ languages.SESSION_TURN_CANCELLED }}
  </p>
</template>

<script setup lang="ts">
import { StopCircleIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import type { GenerationFailure } from '@/lib/turnArtifacts'

defineProps<{ failure: GenerationFailure }>()

const languages = useI18N().state
</script>
