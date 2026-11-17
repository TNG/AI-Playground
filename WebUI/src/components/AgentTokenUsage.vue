<template>
  <Context
    :used-tokens="contextTokens"
    :used-tokens-unknown="contextUnknown"
    :max-tokens="contextWindow"
    :max-context-size="contextWindow"
    :usage="lastStepUsage"
    trigger-size="xs"
  >
    <template #details>
      <div class="pt-1 flex items-center justify-between">
        <span class="text-muted-foreground">Session total</span>
        <span>{{ format(sessionTokens) }}</span>
      </div>
      <div v-if="costFormatted" class="flex items-center justify-between">
        <span class="text-muted-foreground">Session cost</span>
        <span>{{ costFormatted }}</span>
      </div>
      <p v-if="pickedAgent" class="pt-1 text-muted-foreground/80">
        {{
          fillTemplate(
            agentTasks.usageSessionId
              ? languages.AGENT_USAGE_PICKED_AGENT_RUN
              : languages.AGENT_USAGE_PICKED_AGENT_NO_RUN,
            { agent: pickedAgent.name },
          )
        }}
      </p>
      <p class="pt-1 text-muted-foreground/80">
        Input and Output are the agent's most recent model call. The session total counts every step
        of the agentic run, so it grows far past the window — the agent compacts its context
        automatically when it fills up.
      </p>
    </template>
  </Context>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Context from '@/components/ui/context/Context.vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useTextInference } from '@/assets/js/store/textInference'
import { fillTemplate } from '@/lib/fillTemplate'

// Agent Mode reuses the chat Context widget so both modes label context the same
// way, and adds the two figures only an agentic run has: the cumulative session
// total across all steps and its cost (see store/agentMode.ts).
const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const textInference = useTextInference()

const format = (value: number) =>
  new Intl.NumberFormat('en-US', { notation: 'compact' }).format(value)

const pickedAgent = computed(() => agentTasks.pickedAgent)

const report = computed(() =>
  agentTasks.usageSessionId ? agentMode.usageOf(agentTasks.usageSessionId) : undefined,
)

const contextTokens = computed(() => report.value?.contextUsage?.tokens ?? 0)

// Pi only reports the window once a session exists; until then it is the same
// window Chat would use, which is also what the next turn will hand to Pi.
const contextWindow = computed(
  () => report.value?.contextUsage?.contextWindow || textInference.effectiveContextWindow,
)

// Pi cannot estimate occupancy between a compaction and the next model response.
const contextUnknown = computed(() => report.value?.contextUsage?.tokens === null)

const lastStepUsage = computed(() => {
  const step = report.value?.lastStep
  if (!step) return undefined
  return {
    inputTokens: step.inputTokens,
    outputTokens: step.outputTokens,
    inputTokenDetails: { cacheReadTokens: step.cacheReadTokens },
  }
})

const sessionTokens = computed(() => report.value?.totalTokens ?? 0)

const costFormatted = computed(() => {
  const cost = report.value?.usage?.costUsd
  if (!cost) return ''
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cost < 1 ? 3 : 2,
  }).format(cost)
})
</script>
