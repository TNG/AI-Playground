<template>
  <SessionAssistantBubble>
    <ChatWorkflowResult :artifacts="artifacts" :phase="phase" :progress="progress" />
    <p v-if="!phase && status === 'failed'" class="text-sm text-red-500 wrap-break-word">
      {{ languages.COM_GENERATE_FAILED }}<template v-if="error">: {{ error }}</template>
    </p>
    <p v-else-if="!phase && status === 'cancelled'" class="text-sm text-muted-foreground">
      {{ languages.SESSION_TURN_CANCELLED }}
    </p>
  </SessionAssistantBubble>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import ChatWorkflowResult from '@/components/ChatWorkflowResult.vue'
import SessionAssistantBubble from '@/components/SessionAssistantBubble.vue'
import type { ArtifactPhase } from '@/types/kernelEvents'
import type { TurnArtifact } from '@/lib/turnArtifacts'
import type { MediaTurnStatus } from '@/types/sessionTimeline'

/** The Result of a ComfyUI Turn, settled or still running. */
defineProps<{
  artifacts: TurnArtifact[]
  /** Set only while the run is in flight. */
  phase?: ArtifactPhase
  progress?: { current: number; max: number }
  status?: MediaTurnStatus
  error?: string
}>()

const languages = useI18N().state
</script>
