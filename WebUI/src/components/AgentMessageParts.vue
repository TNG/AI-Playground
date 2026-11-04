<template>
  <template v-for="{ part, index } in shownParts()" :key="`${message.id}:${index}`">
    <AgentMessagePart :part="asPart(part)" :section="section" />
  </template>
</template>

<script setup lang="ts">
import type { UIDataTypes, UIMessagePart, UITools, UIMessage } from 'ai'
import AgentMessagePart from '@/components/AgentMessagePart.vue'

/** An agent reply's parts: text, reasoning, tool cards and the media they made. */
const props = defineProps<{
  message: UIMessage
  /** Which side of the Turn this renders: a media tool's card is the Result, the rest Turn Details. */
  section?: 'details' | 'result'
  /** The parts to render; all of them when absent. */
  indexes?: readonly number[]
}>()

function shownParts() {
  return (props.message.parts ?? [])
    .map((part, index) => ({ part, index }))
    .filter(({ part, index }) =>
      props.indexes ? props.indexes.includes(index) : part.type !== 'step-start',
    )
}

// The AI SDK grows a part by mutating it, so the same object reference would
// leave AgentMessagePart showing whatever the part held when it mounted. A copy
// per render makes every mutated field arrive as a changed prop.
function asPart(part: unknown): UIMessagePart<UIDataTypes, UITools> {
  return { ...(part as object) } as UIMessagePart<UIDataTypes, UITools>
}
</script>
