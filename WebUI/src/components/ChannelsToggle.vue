<template>
  <TooltipProvider :delay-duration="200">
    <div class="inline-flex items-center gap-3">
      <span
        class="text-xs font-medium select-none text-foreground"
        style="line-height: 1; vertical-align: middle"
      >
        Channels
      </span>

      <Tooltip>
        <!-- The wrapper carries the tip: a disabled button gets no pointer events. -->
        <TooltipTrigger as-child>
          <span class="inline-flex">
            <button
              type="button"
              role="switch"
              :aria-checked="isOn"
              :aria-label="`Channels: ${isOn ? 'on' : 'off'}`"
              :disabled="!isAvailable || !hasConfiguredChannel"
              class="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              :class="
                isOn
                  ? 'bg-primary/15 border-primary text-foreground'
                  : 'bg-muted/40 border-border text-muted-foreground hover:bg-muted'
              "
              @click="channelStore.toggleMaster()"
            >
              <span
                class="w-1.5 h-1.5 rounded-full"
                :style="{
                  backgroundColor: isOn ? 'var(--color-primary, #22c55e)' : 'currentColor',
                }"
              />
              <span class="tabular-nums">{{ isOn ? 'On' : 'Off' }}</span>
              <span v-if="isOn && activeCount > 0" class="text-muted-foreground">
                · {{ activeCount }} {{ activeCount === 1 ? 'channel' : 'channels' }}
              </span>
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{{ masterTitle }}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger as-child>
          <span class="inline-flex">
            <button
              type="button"
              aria-label="Revisit Channel setup"
              class="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              :disabled="!isInstalled"
              @click="openSetup"
            >
              <Cog6ToothIcon class="w-4 h-4" />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Revisit Channel setup</TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Cog6ToothIcon } from '@heroicons/vue/24/solid'
import { useChannels } from '@/assets/js/store/channels'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { CHANNELS } from '@/assets/js/store/channels/channelRegistry'
import { useErrors } from '@/assets/js/store/errors'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const channelStore = useChannels()
const setupWizard = useSetupWizard()
const backendServices = useBackendServices()
const errors = useErrors()

const isAvailable = computed(() => channelStore.isAvailable)
const isInstalled = computed(
  () => backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.isSetUp === true,
)

const hasConfiguredChannel = computed(() => channelStore.hasConfiguredChannel)

const isOn = computed(
  () => isAvailable.value && hasConfiguredChannel.value && channelStore.masterEnabled,
)

const activeCount = computed(
  () => CHANNELS.filter((c) => channelStore.channels[c.kind].active).length,
)

const masterTitle = computed(() => {
  if (!isInstalled.value)
    return 'Channels are not installed. Install them from App Settings → Installation Management.'
  if (!isAvailable.value) return 'The Channels service is starting…'
  if (!hasConfiguredChannel.value)
    return 'No Channel set up yet. Open Setup to connect Telegram, Slack or LAN chat first.'
  return channelStore.masterEnabled
    ? 'Channels are on: Reachable Sessions can be reached and send Notifications. Click to turn everything off.'
    : 'Channels are off: nothing goes in or out. Click to turn on. Enable individual Channels in Setup.'
})

function openSetup() {
  setupWizard.openChannelsSetup().catch((e: unknown) => errors.report(e, { surface: 'silent' }))
}
</script>
