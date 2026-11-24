<template>
  <div class="contents" :class="textInference.fontSizeClass">
    <template v-for="{ part, index } in shownParts()" :key="`${message.id}:${index}`">
      <AgentMessagePart
        :part="asPart(part)"
        :section="section"
        :grid-artifacts="gridArtifactsOf(index)"
        :hide-media-grid="hideMediaGrid(index)"
        :created-files="createdFilesOf(message)"
        :harness-session-id="harnessSessionId"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import type { UIDataTypes, UIMessagePart, UITools, UIMessage } from 'ai'
import { useTextInference } from '@/assets/js/store/textInference'
import { useArtifactRuns } from '@/assets/js/store/artifactRuns'
import { useSessions } from '@/assets/js/store/sessions'
import AgentMessagePart from '@/components/AgentMessagePart.vue'
import { mediaToolNameOf } from '@/lib/agentTranscript'
import { createdFilesOf } from '@/lib/answerFileLinks'
import { consecutiveMediaGroups } from '@/lib/mediaPartGroups'
import { toolCallArtifacts, type TurnArtifact } from '@/lib/turnArtifacts'

const props = defineProps<{
  message: UIMessage
  section?: 'details' | 'result'
  indexes?: readonly number[]
  /** The harness session that produced the message, for its file links. */
  harnessSessionId?: string
}>()

const textInference = useTextInference()
const artifactRuns = useArtifactRuns()
const sessions = useSessions()

function shownParts() {
  return (props.message.parts ?? [])
    .map((part, index) => ({ part, index }))
    .filter(({ part, index }) =>
      props.indexes ? props.indexes.includes(index) : part.type !== 'step-start',
    )
}

// Consecutive media tool parts share one grid, so several calls in one prompt
// put their images side by side instead of one stacked block per call.
function mediaGroups(): Map<number, number[]> {
  return consecutiveMediaGroups(
    props.message.parts,
    (part) => !!mediaToolNameOf(part),
    shownParts().map(({ index }) => index),
  )
}

function gridArtifactsOf(index: number): TurnArtifact[] | undefined {
  const group = mediaGroups().get(index)
  if (!group) return undefined
  return group.flatMap((member) =>
    toolCallArtifacts(props.message.parts[member], artifactRuns.state, sessions.openDeletedFiles),
  )
}

function hideMediaGrid(index: number): boolean {
  return !!mediaToolNameOf(props.message.parts[index]) && !mediaGroups().has(index)
}

// The AI SDK grows a part by mutating it, so the same object reference would
// leave AgentMessagePart showing whatever the part held when it mounted. A copy
// per render makes every mutated field arrive as a changed prop.
function asPart(part: unknown): UIMessagePart<UIDataTypes, UITools> {
  return { ...(part as object) } as UIMessagePart<UIDataTypes, UITools>
}
</script>
