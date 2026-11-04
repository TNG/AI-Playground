<template>
  <p v-if="failure.state === 'failed'" role="status" class="truncate text-sm text-destructive">
    {{ languages.COM_GENERATE_FAILED
    }}<template v-if="failure.reason">: {{ failure.reason }}</template>
  </p>
  <p v-else role="status" class="text-sm text-muted-foreground">
    {{ languages.SESSION_TURN_CANCELLED }}
  </p>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import type { GenerationFailure } from '@/lib/turnArtifacts'

/** A generation that ended before producing anything, said in one line in its Result. */
defineProps<{ failure: GenerationFailure }>()

const languages = useI18N().state
</script>
