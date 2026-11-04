<template>
  <SessionAssistantBubble>
    <ChatWorkflowResult :artifacts="artifacts" />
    <p v-if="status === 'failed'" class="text-sm text-red-500 wrap-break-word">
      {{ languages.COM_GENERATE_FAILED }}<template v-if="error">: {{ error }}</template>
    </p>
    <p v-else-if="status === 'cancelled'" class="text-sm text-muted-foreground">
      {{ languages.SESSION_TURN_CANCELLED }}
    </p>
  </SessionAssistantBubble>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import ChatWorkflowResult from '@/components/ChatWorkflowResult.vue'
import SessionAssistantBubble from '@/components/SessionAssistantBubble.vue'
import type { TurnArtifact } from '@/lib/turnArtifacts'
import type { MediaTurnStatus } from '@/types/sessionTimeline'

/** The Result of a ComfyUI Turn, settled or still running. */
defineProps<{
  artifacts: TurnArtifact[]
  /** Absent while the run is in flight. */
  status?: MediaTurnStatus
  error?: string
}>()

const languages = useI18N().state
</script>
