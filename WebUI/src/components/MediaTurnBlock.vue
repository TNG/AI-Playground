<template>
  <SessionAssistantBubble>
    <ChatWorkflowResult :artifacts="artifacts" />
    <TurnFailureLine v-if="failure" :failure="failure" />
  </SessionAssistantBubble>
</template>

<script setup lang="ts">
import ChatWorkflowResult from '@/components/ChatWorkflowResult.vue'
import SessionAssistantBubble from '@/components/SessionAssistantBubble.vue'
import TurnFailureLine from '@/components/TurnFailureLine.vue'
import type { GenerationFailure, TurnArtifact } from '@/lib/turnArtifacts'

/** The Result of a ComfyUI Turn, settled or still running. */
defineProps<{
  artifacts: TurnArtifact[]
  /** The run ended before it generated anything. */
  failure?: GenerationFailure
}>()
</script>
