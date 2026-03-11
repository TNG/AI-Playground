<template>
  <div class="mt-2 rounded-md border border-border/80 bg-muted/20 p-3">
    <p class="text-sm text-muted-foreground">
      {{ progressText }}
    </p>

    <details class="mt-2" v-if="part.input" open>
      <summary class="cursor-pointer text-xs text-muted-foreground">Arguments</summary>
      <pre class="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs leading-5">{{
        formattedInput
      }}</pre>
    </details>

    <details class="mt-2" v-if="part.state === 'output-available'" open>
      <summary class="cursor-pointer text-xs text-muted-foreground">Result</summary>
      <pre class="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs leading-5">{{
        formattedOutput
      }}</pre>
    </details>

    <div
      v-if="errorText"
      class="mt-2 rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive"
    >
      {{ errorText }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { type ToolUIPart } from 'ai'

const props = defineProps<{
  part: ToolUIPart
}>()

const progressText = computed(() => {
  if (props.part.state === 'input-streaming') return 'Executing MCP tool call...'
  if (props.part.state === 'input-available') return 'MCP tool call queued.'
  if (props.part.state === 'output-available') return 'MCP tool call completed.'
  if (props.part.state === 'output-error') return 'MCP tool call failed.'
  return 'MCP tool call status updated.'
})

const errorText = computed(() => {
  const anyPart = props.part as any
  if (typeof anyPart.errorText === 'string' && anyPart.errorText.trim() !== '') {
    return anyPart.errorText
  }
  if (props.part.state === 'output-error') {
    const outputError = anyPart.output?.error || anyPart.output?.message
    if (typeof outputError === 'string' && outputError.trim() !== '') {
      return outputError
    }
    return 'Tool call failed with an unknown error.'
  }
  return null
})

const formattedInput = computed(() => formatToolPayload(props.part.input))
const formattedOutput = computed(() => formatToolPayload((props.part as any).output))

function formatToolPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}
</script>
