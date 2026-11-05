<template>
  <div class="absolute bottom-14 left-3 flex gap-2">
    <PromptAttachmentPreviews />
  </div>
  <div class="absolute bottom-4 left-3 flex items-center gap-2">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button
          id="mode-dropdown"
          variant="secondary"
          class="gap-1"
          :aria-label="`${i18nState.PROMPT_BAR_MODE}: ${mapModeToLabel(shownMode)}`"
        >
          {{ mapModeToLabel(shownMode) }}
          <ChevronDownIcon class="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" class="z-[40010] min-w-40">
        <DropdownMenuRadioGroup
          :model-value="shownMode"
          @update:model-value="(mode) => pickMode(mode as ModeType)"
        >
          <DropdownMenuRadioItem v-for="mode in model.modes" :key="mode" :value="mode">
            {{ mapModeToLabel(mode) }}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <TooltipProvider v-if="sessionTabs.tabs.includes('inferencing')" :delay-duration="200">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="secondary"
            class="px-2"
            :aria-label="i18nState.PROMPT_BAR_OPEN_INFERENCING"
            @click="sessionTabs.select('inferencing')"
          >
            <Cog6ToothIcon class="size-5" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{{ i18nState.PROMPT_BAR_OPEN_INFERENCING }}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <PromptAttachButton
      v-if="showAttach"
      :accepted-file-types="acceptedFileTypes"
      :is-over-drop-zone="isOverDropZone"
      @attach="(e: Event) => emit('attach', e)"
    />
    <PromptCaptureButtons
      :downloading="downloading"
      :stt-available="sttAvailable"
      :stt-unavailable-hint="sttUnavailableHint"
      @camera="emit('camera')"
      @record="emit('record')"
    />
  </div>
  <div class="absolute bottom-4 right-3 flex gap-2">
    <PromptSendButtons
      :show-send="showSend"
      :ready-for-new-submit="readyForNewSubmit"
      :can-run-steps="canRunSteps"
      :settings-blocked="settingsBlocked"
      :is-slash-command="isSlashCommand"
      :is-stopping="isStopping"
      @send="emit('send')"
      @run-steps="emit('runSteps')"
      @cancel="emit('cancel')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDownIcon, Cog6ToothIcon } from '@heroicons/vue/24/outline'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { usePresets } from '@/assets/js/store/presets'
import { useSessionTabs } from '@/assets/js/store/sessionTabs'
import { useTextInference } from '@/assets/js/store/textInference'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { useI18N } from '@/assets/js/store/i18n'
import Button from '@/components/ui/button/Button.vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import PromptAttachButton from '@/components/PromptAttachButton.vue'
import PromptAttachmentPreviews from '@/components/PromptAttachmentPreviews.vue'
import PromptCaptureButtons from '@/components/PromptCaptureButtons.vue'
import PromptSendButtons from '@/components/PromptSendButtons.vue'
import { mapModeToLabel } from '@/lib/utils.ts'
import { promptBarModel } from '@/lib/promptBarModel'
import { usePromptBarPresetSwitch } from '@/lib/usePromptBarPresetSwitch'

defineProps<{
  showAttach: boolean
  acceptedFileTypes: string
  isOverDropZone: boolean
  downloading: boolean
  sttAvailable: boolean
  sttUnavailableHint: string
  showSend: boolean
  readyForNewSubmit: boolean
  canRunSteps: boolean
  settingsBlocked: boolean
  isSlashCommand: boolean
  isStopping: boolean
}>()

const emit = defineEmits<{
  (e: 'attach', event: Event): void
  (e: 'camera'): void
  (e: 'record'): void
  (e: 'send'): void
  (e: 'runSteps'): void
  (e: 'cancel'): void
}>()

const promptStore = usePromptStore()
const presetsStore = usePresets()
const sessionTabs = useSessionTabs()
const textInference = useTextInference()
const oemBranding = useOemBranding()
const i18nState = useI18N().state
const { gateOf, switchTo } = usePromptBarPresetSwitch()

const model = computed(() =>
  promptBarModel({
    activePreset: presetsStore.activePreset,
    presetLabel: (name) => oemBranding.presetLabel(name),
    machine: { chatBackend: textInference.backend },
    catalog: presetsStore.getPresetsByCategories([]),
    lastUsed: presetsStore.lastUsedPresetsByMode,
    presetGate: gateOf,
  }),
)

const shownMode = computed(() => model.value.activeMode ?? promptStore.getCurrentMode())

async function pickMode(mode: ModeType) {
  const presetName = model.value.modePicks[mode]
  if (!presetName || mode === model.value.activeMode) return
  await switchTo(presetName, { announce: false })
}
</script>
