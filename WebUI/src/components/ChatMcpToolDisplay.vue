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
import { type DynamicToolUIPart } from 'ai'

const props = defineProps<{
  part: DynamicToolUIPart
  state: DynamicToolUIPart['state']
}>()

const progressText = computed(() => {
  if (props.state === 'input-streaming') return 'Executing MCP tool call...'
  if (props.state === 'input-available') return 'MCP tool call queued.'
  if (props.state === 'output-available') return 'MCP tool call completed.'
  if (props.state === 'output-error') return 'MCP tool call failed.'
  return 'MCP tool call status updated.'
})

const errorText = computed(() => {
  if (typeof props.part.errorText === 'string' && props.part.errorText.trim() !== '') {
    return props.part.errorText
  }
  if (props.state === 'output-error') {
    const outputError = props.part.output?.error || props.part.output?.message
    if (typeof outputError === 'string' && outputError.trim() !== '') {
      return outputError
    }
    return 'Tool call failed with an unknown error.'
  }
  return null
})

const formattedInput = computed(() => formatToolPayload(props.part.input))
const formattedOutput = computed(() => formatToolPayload(props.part.output))

function formatToolPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}
</script>
