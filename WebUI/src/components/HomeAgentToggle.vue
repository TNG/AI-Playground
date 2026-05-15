<template>
  <div class="inline-flex items-center gap-2" :title="toggleTitle">
    <span
      class="text-xs font-medium select-none text-foreground"
      style="line-height: 1; vertical-align: middle"
    >
      Home Agent
    </span>

    <button
      role="switch"
      :aria-checked="isHomeAgentActive"
      :aria-label="ariaLabel"
      :disabled="!isAvailable || (!isReadyToActivate && !isHomeAgentActive)"
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
      class="text-xs font-medium select-none tabular-nums min-w-6"
      style="line-height: 1; vertical-align: middle"
      :class="isHomeAgentActive ? 'text-foreground' : 'text-muted-foreground'"
    >
      {{ isHomeAgentActive ? 'On' : 'Off' }}
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
    return 'Verify the Telegram connection in Setup Wizard before turning Home Agent on.'
  return isHomeAgentActive.value
    ? 'Home Agent is on — answering Telegram; click to turn off.'
    : 'Home Agent is off — click to enable Telegram messaging.'
})

const ariaLabel = computed(() =>
  isHomeAgentActive.value ? 'Home Agent on, click to turn off' : 'Home Agent off, click to turn on',
)

function toggle() {
  homeAgent.toggle()
}
</script>
