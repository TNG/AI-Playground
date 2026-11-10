<template>
  <!-- Hidden for the STT preset, which submits via its own record/upload controls. -->
  <template v-if="showSend">
    <TooltipProvider v-if="readyForNewSubmit" :delay-duration="200">
      <Tooltip v-if="pickedAgentName">
        <TooltipTrigger as-child>
          <Button
            @click="emit('runAgent')"
            :aria-label="labels?.run ?? languages?.AGENT_PICKED_RUN"
            :disabled="settingsBlocked || isSlashCommand"
            :class="[
              'px-3 py-1.5 rounded-lg text-sm min-w-[44px] flex items-center justify-center',
              toneClasses(runPrimary),
            ]"
          >
            <PlayIcon class="size-4" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{{ agentTip(languages?.AGENT_PICKED_RUN_TIP) }}</TooltipContent>
      </Tooltip>
      <Tooltip :disabled="!pickedAgentName">
        <TooltipTrigger as-child>
          <!-- A disabled button gets no pointer events, so the wrapper carries its tooltip. -->
          <span :tabindex="sendEnabled ? undefined : 0" class="inline-flex">
            <Button
              @click="emit('send')"
              :id="labels ? undefined : 'send-button'"
              :aria-label="labels?.send ?? 'Send'"
              :disabled="settingsBlocked || !sendEnabled"
              :class="['px-3 py-1.5 rounded-lg text-sm min-w-[44px]', toneClasses(!runPrimary)]"
            >
              →
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{{
          agentTip(
            sendEnabled ? languages?.AGENT_PICKED_SEND_TIP : languages?.AGENT_FOLLOW_UP_NEVER_RUN,
          )
        }}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <Button
      v-else-if="!isStopping"
      @click="emit('cancel')"
      :aria-label="labels?.stop ?? 'Stop generating'"
      aria-busy="true"
      class="px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded-lg text-sm min-w-[44px] flex items-center justify-center"
    >
      <i class="svg-icon w-4 h-4 i-stop"></i>
    </Button>
    <Button
      v-else
      disabled
      aria-label="Stopping"
      aria-busy="true"
      class="px-3 py-1.5 bg-red-400 cursor-not-allowed rounded-lg text-sm min-w-[44px] flex items-center justify-center"
    >
      <i class="svg-icon w-4 h-4 i-loading"></i>
    </Button>
  </template>
</template>

<script setup lang="ts">
import { computed, getCurrentInstance } from 'vue'
import { PlayIcon } from '@heroicons/vue/24/solid'
import Button from '@/components/ui/button/Button.vue'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { AgentComposerState } from '@/lib/agentComposer'
import { fillTemplate } from '@/lib/fillTemplate'

const props = defineProps<{
  showSend: boolean
  readyForNewSubmit: boolean
  pickedAgentName?: string
  /** Set with `pickedAgentName`: which button Enter triggers, and whether Send can. */
  agentComposer?: AgentComposerState
  settingsBlocked: boolean
  isSlashCommand: boolean
  isStopping: boolean
  /** Outside the prompt bar: its own accessible names, and no tour anchor. */
  labels?: { run: string; send: string; stop: string }
}>()

const emit = defineEmits<{
  (e: 'send'): void
  (e: 'runAgent'): void
  (e: 'cancel'): void
}>()

const languages = getCurrentInstance()?.appContext.config.globalProperties.languages

const runPrimary = computed(() => !!props.pickedAgentName && props.agentComposer?.primary === 'run')
const sendEnabled = computed(
  () => !props.pickedAgentName || props.agentComposer?.sendEnabled !== false,
)

const toneClasses = (primary: boolean) =>
  primary
    ? 'bg-primary hover:bg-primary/80'
    : 'bg-secondary text-secondary-foreground border border-primary/60 hover:bg-secondary/80'

const agentTip = (template: string | undefined) =>
  fillTemplate(template ?? '', { agent: props.pickedAgentName ?? '' })
</script>
