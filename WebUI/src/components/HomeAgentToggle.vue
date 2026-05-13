<template>
  <div class="inline-flex items-center gap-2" :title="toggleTitle">
    <span
      class="text-xs font-medium select-none transition-colors"
      style="line-height: 1; vertical-align: middle"
      :class="isHomeAgentActive ? 'text-muted-foreground' : 'text-foreground'"
    >
      AI Playground
    </span>

    <!-- Toggle switch -->
    <button
      role="switch"
      :aria-checked="isHomeAgentActive"
      :disabled="!isAvailable || !isReadyToActivate"
      class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
      :class="isHomeAgentActive ? 'bg-primary' : 'bg-muted-foreground/40'"
      @click="toggle"
    >
      <span
        class="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform"
        :class="isHomeAgentActive ? 'translate-x-4' : 'translate-x-0'"
      />
    </button>

    <span
      class="text-xs font-medium select-none transition-colors"
      style="line-height: 1; vertical-align: middle"
      :class="isHomeAgentActive ? 'text-foreground' : 'text-muted-foreground'"
    >
      Home Agent
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useHomeAgent } from '@/assets/js/store/homeAgent'

const homeAgent = useHomeAgent()

const isHomeAgentActive = computed(() => homeAgent.isHomeAgentActive)
const isAvailable = computed(() => homeAgent.isAvailable)
const isReadyToActivate = computed(() => homeAgent.isReadyToActivate)

const toggleTitle = computed(() => {
  if (!isAvailable.value)
    return 'Home Agent is not installed. Install it from App Settings → Installation Management.'
  if (!isReadyToActivate.value)
    return 'Verify the Telegram connection in Setup Wizard to enable Home Agent.'
  return isHomeAgentActive.value
    ? 'Switch back to AI Playground'
    : 'Switch to Home Agent (chat only)'
})

function toggle() {
  homeAgent.toggle()
}
</script>
