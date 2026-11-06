<template>
  <div class="contents" :class="textInference.fontSizeClass">
    <template v-for="{ part, index } in shownParts()" :key="`${message.id}:${index}`">
      <AgentMessagePart :part="asPart(part)" :section="section" />
    </template>
  </div>
</template>

<script setup lang="ts">
import type { UIDataTypes, UIMessagePart, UITools, UIMessage } from 'ai'
import { useTextInference } from '@/assets/js/store/textInference'
import AgentMessagePart from '@/components/AgentMessagePart.vue'

const props = defineProps<{
  message: UIMessage
  section?: 'details' | 'result'
  indexes?: readonly number[]
}>()

const textInference = useTextInference()

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
