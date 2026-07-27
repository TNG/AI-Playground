<template>
  <HoverCard :open-delay="0" :close-delay="0">
    <HoverCardTrigger as-child>
      <button
        type="button"
        class="cursor-help font-medium text-muted-foreground"
        aria-label="Agent session token usage"
      >
        {{ totalFormatted }} tokens
      </button>
    </HoverCardTrigger>
    <HoverCardContent
      side="top"
      class="min-w-60 overflow-hidden p-0 bg-card border-border text-foreground"
    >
      <div class="w-full p-3 space-y-2 text-xs">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">Session Tokens</h2>
          <h2 class="text-sm font-medium">Tokens</h2>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">Total</span>
          <span>{{ totalFormatted }}</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">Input</span>
          <span>{{ inputFormatted }}</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">Output</span>
          <span>{{ outputFormatted }}</span>
        </div>
        <p class="pt-1 text-muted-foreground/80">
          Totals for the whole agent session, not current context usage — each step re-sends the
          conversation, so this grows past the model's context window. The agent compacts its
          context automatically when it fills up.
        </p>
      </div>
    </HoverCardContent>
  </HoverCard>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useAgentMode } from '@/assets/js/store/agentMode'

// Agent-mode counterpart of the chat Context widget. Deliberately NOT a
// gauge: what the Pi harness reports is a cumulative session total (see the
// usage comment in store/agentMode.ts), so there is no meaningful percentage
// to show against the context window.
const agentMode = useAgentMode()

const format = (value: number) =>
  new Intl.NumberFormat('en-US', { notation: 'compact' }).format(value)

const totalFormatted = computed(() => format(agentMode.sessionTokens))
const inputFormatted = computed(() => format(agentMode.sessionUsage?.inputTokens ?? 0))
const outputFormatted = computed(() => format(agentMode.sessionUsage?.outputTokens ?? 0))
</script>
