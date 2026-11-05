<template>
  <!-- Hidden for the STT preset, which submits via its own record/upload controls. -->
  <template v-if="showSend">
    <TooltipProvider v-if="readyForNewSubmit" :delay-duration="200">
      <Tooltip v-if="canRunSteps">
        <TooltipTrigger as-child>
          <Button
            @click="emit('runSteps')"
            :aria-label="languages?.AGENT_STEPS_RUN"
            :disabled="settingsBlocked || isSlashCommand"
            class="px-3 py-1.5 bg-primary hover:bg-primary/80 rounded-lg text-sm min-w-[44px] flex items-center justify-center"
          >
            <PlayIcon class="size-4" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{{ languages?.AGENT_STEPS_RUN_TIP }}</TooltipContent>
      </Tooltip>
      <Tooltip :disabled="!canRunSteps">
        <TooltipTrigger as-child>
          <Button
            @click="emit('send')"
            id="send-button"
            aria-label="Send"
            :disabled="settingsBlocked"
            class="px-3 py-1.5 bg-primary hover:bg-primary/80 rounded-lg text-sm min-w-[44px]"
          >
            →
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{{ languages?.AGENT_STEPS_SEND_TIP }}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <Button
      v-else-if="!isStopping"
      @click="emit('cancel')"
      aria-label="Stop generating"
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
import { getCurrentInstance } from 'vue'
import { PlayIcon } from '@heroicons/vue/24/solid'
import Button from '@/components/ui/button/Button.vue'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

defineProps<{
  showSend: boolean
  readyForNewSubmit: boolean
  canRunSteps: boolean
  settingsBlocked: boolean
  isSlashCommand: boolean
  isStopping: boolean
}>()

const emit = defineEmits<{
  (e: 'send'): void
  (e: 'runSteps'): void
  (e: 'cancel'): void
}>()

const languages = getCurrentInstance()?.appContext.config.globalProperties.languages
</script>
