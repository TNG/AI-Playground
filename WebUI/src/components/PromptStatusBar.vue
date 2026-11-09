<template>
  <!-- min-h keeps the row the same height in every mode: the context widget and
       zoom controls (28px) are chat-only, so without it the row would collapse to
       the preset chip's height and sit closer to the prompt input. -->
  <div class="flex w-full items-center gap-2 m-1 min-h-7 text-xs text-muted-foreground">
    <div
      v-if="presetChip"
      role="status"
      :aria-label="`Active preset: ${presetChip.label}`"
      class="flex min-w-0 items-center gap-2"
    >
      <TooltipProvider :delay-duration="0">
        <Tooltip v-if="backendChip">
          <TooltipTrigger as-child>
            <button
              type="button"
              :class="chipClass"
              class="flex-none cursor-help"
              :aria-label="`Inference backend: ${backendChip.name}`"
            >
              <span>{{ backendChip.name }}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent
            align="start"
            class="w-64 bg-card border border-border text-foreground p-3 z-[200]"
          >
            <p class="text-sm font-semibold">{{ backendChip.name }}</p>
            <p class="mt-1 text-xs text-muted-foreground">{{ backendChip.description }}</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip v-if="deviceChip">
          <TooltipTrigger as-child>
            <button
              type="button"
              :class="chipClass"
              class="min-w-0 max-w-48 cursor-help"
              :aria-label="`Inference device: ${deviceChip.name}`"
            >
              <span class="truncate">{{ deviceChip.label }}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent
            align="start"
            class="w-64 bg-card border border-border text-foreground p-3 z-[200]"
          >
            <p class="text-sm font-semibold">{{ deviceChip.name }}</p>
            <p class="mt-1 text-xs text-muted-foreground">{{ deviceChip.categoryLabel }}</p>
          </TooltipContent>
        </Tooltip>
        <template v-if="modelChip">
          <ModelCapabilities
            v-if="modelChip.source === 'chat' && currentModel"
            :model="currentModel"
            show-name
            :delay-duration="0"
          >
            <template #trigger>
              <button type="button" :class="chipClass" class="min-w-0 cursor-help">
                <span class="truncate">{{ modelChip.name }}</span>
                <CapabilityIcons
                  v-if="isAssistantPreset"
                  :model="currentModel"
                  icon-size="size-3.5"
                  :delay-duration="0"
                />
              </button>
            </template>
          </ModelCapabilities>
          <Tooltip v-else>
            <TooltipTrigger as-child>
              <button type="button" :class="chipClass" class="min-w-0 cursor-help">
                <span class="truncate">{{ modelChip.name }}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent
              align="start"
              class="w-72 bg-card border border-border text-foreground p-3 z-[200]"
            >
              <p class="text-sm font-semibold break-all">{{ modelChip.id }}</p>
            </TooltipContent>
          </Tooltip>
          <!-- Whether the model plus its context fits the card (llama.cpp only) -->
          <ModelVramFit v-if="modelChip.source === 'chat'" :delay-duration="0" />
        </template>
        <DropdownMenu
          v-if="bar.presetChip === 'dropdown'"
          @update:open="(open: boolean) => !open && (agentQuery = '')"
        >
          <DropdownMenuTrigger as-child>
            <button
              id="preset-dropdown"
              type="button"
              :class="presetChipClass"
              :aria-label="`${presetChip.agentId ? languages.PROMPT_BAR_AGENT : languages.PROMPT_BAR_PRESET}: ${presetChip.label}`"
            >
              <img
                v-if="presetChip.image"
                :src="presetChip.image"
                alt=""
                class="size-4 rounded object-cover flex-none"
              />
              <span class="text-foreground font-medium truncate">{{ presetChip.label }}</span>
              <ChevronDownIcon class="size-3.5 flex-none" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            class="z-[40010] min-w-48 flex flex-col max-h-[var(--reka-dropdown-menu-content-available-height)]"
          >
            <DropdownMenuLabel v-if="bar.activeMode === 'agent'" class="text-xs">
              {{ languages.PROMPT_BAR_AGENT_PRESETS }}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              :model-value="pickedPresetName ?? ''"
              @update:model-value="(name) => pickPreset(name as string)"
            >
              <TooltipProvider :delay-duration="200">
                <Tooltip v-for="preset in bar.presets" :key="preset.name">
                  <TooltipTrigger as-child>
                    <!-- Gated items stay focusable rather than `disabled`, which would also
                       swallow the hover that shows their reason. -->
                    <DropdownMenuRadioItem
                      :value="preset.name"
                      :aria-disabled="!preset.enabled"
                      :data-aipg-preset-name="preset.name"
                      class="gap-2"
                      :class="{ 'opacity-50': !preset.enabled }"
                      @select="(event: Event) => !preset.enabled && event.preventDefault()"
                    >
                      <img
                        v-if="preset.image"
                        :src="preset.image"
                        alt=""
                        class="size-6 rounded object-cover flex-none"
                        :class="{ grayscale: !preset.enabled }"
                      />
                      <span class="truncate">{{ preset.label }}</span>
                    </DropdownMenuRadioItem>
                  </TooltipTrigger>
                  <TooltipContent side="right" class="z-[40011] max-w-[260px]">
                    <p class="font-semibold">{{ preset.label }}</p>
                    <p v-if="descriptionOf(preset.name)" class="mt-1 text-primary-foreground/80">
                      {{ descriptionOf(preset.name) }}
                    </p>
                    <p v-if="preset.reason" class="mt-1 text-amber-400 text-xs">
                      {{ languages[preset.reason] }}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </DropdownMenuRadioGroup>
            <template v-if="bar.agents.length > 0">
              <DropdownMenuSeparator />
              <DropdownMenuLabel class="text-xs">{{
                languages.AGENT_LIBRARY_LIST
              }}</DropdownMenuLabel>
              <DropdownMenuFilter
                v-if="agentView.filterable"
                v-model="agentQuery"
                auto-focus
                :placeholder="languages.AGENT_LIBRARY_FILTER"
                :aria-label="languages.AGENT_LIBRARY_FILTER"
                class="mx-1 mb-1 h-7 flex-none rounded-md border border-input bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
              />
              <DropdownMenuRadioGroup
                :model-value="pickedAgentId ?? ''"
                :aria-label="languages.AGENT_LIBRARY_LIST"
                class="min-h-0 overflow-y-auto"
                @update:model-value="(id) => pickAgent(id as string)"
              >
                <p
                  v-if="agentView.agents.length === 0"
                  role="status"
                  class="px-2 py-1.5 text-xs text-muted-foreground"
                >
                  {{ languages.AGENT_LIBRARY_FILTER_EMPTY }}
                </p>
                <TooltipProvider :delay-duration="200">
                  <Tooltip v-for="agent in agentView.agents" :key="agent.id">
                    <TooltipTrigger as-child>
                      <DropdownMenuRadioItem :value="agent.id" class="gap-2">
                        <img
                          v-if="agent.image"
                          :src="agent.image"
                          alt=""
                          class="size-6 rounded object-cover flex-none"
                        />
                        <span class="truncate">{{ agent.name }}</span>
                      </DropdownMenuRadioItem>
                    </TooltipTrigger>
                    <TooltipContent
                      v-if="agent.description"
                      side="right"
                      class="z-[40011] max-w-[260px]"
                    >
                      <p class="font-semibold">{{ agent.name }}</p>
                      <p class="mt-1 text-primary-foreground/80">{{ agent.description }}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </DropdownMenuRadioGroup>
            </template>
            <AgentLibraryMenuItems v-if="bar.activeMode === 'agent'" />
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip v-else>
          <TooltipTrigger as-child>
            <button type="button" :class="presetChipClass" class="cursor-help">
              <img
                v-if="presetChip.image"
                :src="presetChip.image"
                :alt="presetChip.label"
                class="size-4 rounded object-cover flex-none"
              />
              <span class="text-foreground font-medium truncate">{{ presetChip.label }}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent
            align="start"
            class="w-64 bg-card border border-border text-foreground p-3 z-[200]"
          >
            <p class="text-sm font-semibold">{{ presetChip.label }}</p>
            <p v-if="presetChipDescription" class="mt-1 text-xs text-muted-foreground">
              {{ presetChipDescription }}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
    <TooltipProvider v-if="workspaceFolder" :delay-duration="200">
      <Tooltip>
        <TooltipTrigger as-child>
          <button
            type="button"
            class="flex min-w-0 items-center gap-1 p-1 text-muted-foreground hover:text-foreground transition-colors"
            :aria-label="`Open workspace folder ${workspaceFolder.name}`"
            @click="openWorkspaceFolder"
          >
            <FolderOpenIcon class="size-4 flex-none" aria-hidden="true" />
            <span class="truncate">{{ workspaceFolder.name }}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{{ workspaceFolder.dir }}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <div class="ml-auto flex flex-none items-center gap-2">
      <!-- Live GPU / RAM, gated on the same Metrics checkbox as the chat footer. -->
      <TooltipProvider v-if="textInference.metricsEnabled && computeChip" :delay-duration="0">
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              :class="chipClass"
              class="flex-none cursor-help"
              :aria-label="computeChip.ariaLabel"
            >
              <span class="tabular-nums">{{ computeChip.label }}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent
            align="start"
            class="w-72 bg-card border border-border text-foreground p-3 z-[200]"
          >
            <p class="text-sm font-semibold">{{ languages.COMPUTE_METRICS_LABEL }}</p>
            <section
              v-for="section in computeChip.sections"
              :key="section.title"
              class="mt-2 first-of-type:mt-1.5"
            >
              <p class="text-xs font-medium text-foreground">{{ section.title }}</p>
              <dl class="mt-0.5 grid grid-cols-[auto_1fr] gap-x-4 text-xs">
                <template v-for="row in section.rows" :key="row.label">
                  <dt class="text-muted-foreground">{{ row.label }}</dt>
                  <dd class="text-right tabular-nums text-foreground">{{ row.value }}</dd>
                </template>
              </dl>
            </section>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <!-- Context usage. Outside the status element so the live region doesn't
           re-announce the token percentage on every stream tick. -->
      <Context
        v-if="isChatMode"
        trigger-size="xs"
        :used-tokens="contextUsedTokens"
        :max-tokens="contextMaxTokens"
        :max-context-size="textInference.maxContextSizeFromModel"
        :dynamic-context="textInference.contextSizeIsDynamic"
        :usage="contextUsage"
      />
      <!-- Same gauge in agent mode, fed by Pi's context report. -->
      <AgentTokenUsage v-if="isAgentMode" />
      <div v-if="isChatMode" class="flex flex-none gap-1">
        <button
          @click="textInference.decreaseFontSize()"
          :disabled="textInference.isMinSize"
          class="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Decrease font size"
        >
          <MagnifyingGlassMinusIcon class="size-5" />
        </button>
        <button
          @click="textInference.increaseFontSize()"
          :disabled="textInference.isMaxSize"
          class="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Increase font size"
        >
          <MagnifyingGlassPlusIcon class="size-5" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
  ChevronDownIcon,
  FolderOpenIcon,
  MagnifyingGlassPlusIcon,
  MagnifyingGlassMinusIcon,
} from '@heroicons/vue/24/outline'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useErrors } from '@/assets/js/store/errors'
import {
  useTextInference,
  textInferenceBackendDescription,
  backendToService,
} from '@/assets/js/store/textInference'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets.ts'
import { AUDIO_CATEGORY, usePresets, type ChatPreset } from '@/assets/js/store/presets'
import { useTextToSpeech } from '@/assets/js/store/textToSpeech'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { useI18N } from '@/assets/js/store/i18n'
import { useComputeMetrics } from '@/assets/js/store/computeMetrics'
import { usePromptBarStyle } from '@/assets/js/store/promptBarStyle'
import { Context } from '@/components/ui/context'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuFilter,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import ModelCapabilities from '@/components/ModelCapabilities.vue'
import ModelVramFit from '@/components/ModelVramFit.vue'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import AgentTokenUsage from '@/components/AgentTokenUsage.vue'
import AgentLibraryMenuItems from '@/components/agentLibrary/AgentLibraryMenuItems.vue'
import { computeDetailSections, formatMib } from '@/lib/computeMetricsFormat'
import { HYBRID_CLOUD_NAME } from '@/lib/cloudModeName'
import {
  agentList,
  promptBarModel,
  type HeaderChip,
  type SpeechBackend,
} from '@/lib/promptBarModel'
import { usePromptBarPresetSwitch } from '@/lib/usePromptBarPresetSwitch'
import { usePromptBarAgentPick } from '@/lib/usePromptBarAgentPick'

const promptStore = usePromptStore()
const textInference = useTextInference()
const cloudMode = useCloudMode()
const backendServices = useBackendServices()
const openAiCompatibleChat = useOpenAiCompatibleChat()
const imageGeneration = useImageGenerationPresets()
const presetsStore = usePresets()
const textToSpeech = useTextToSpeech()
const oemBranding = useOemBranding()
const languages = useI18N().state
const computeMetrics = useComputeMetrics()
const agentMode = useAgentMode()
const errors = useErrors()
const promptBarStyle = usePromptBarStyle()
const { gateOf } = usePromptBarPresetSwitch()
const agentPick = usePromptBarAgentPick()
const { pickedAgentId, pickedPresetName } = agentPick

const presetChipClass =
  'flex h-6 min-w-0 items-center gap-1.5 rounded-md border border-primary/60 bg-primary/10 px-1.5 text-left'

const chipClass =
  'flex h-6 items-center gap-1 rounded-md border border-border px-1.5 text-foreground/80'

const isChatMode = computed(() => promptStore.getCurrentMode() === 'chat')
const isAgentMode = computed(() => promptStore.getCurrentMode() === 'agent')

// Games presets open their folder from the GameBar instead.
const workspaceFolder = computed(() => {
  const dir = agentMode.workspaceDir
  if (!isAgentMode.value || agentMode.agentWorkspaceKind !== 'pick' || !dir) return undefined
  return { dir, name: dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir }
})

async function openWorkspaceFolder(): Promise<void> {
  if (!workspaceFolder.value) return
  try {
    const result = await window.electronAPI.agentMode.openWorkspaceFolder(workspaceFolder.value.dir)
    if (!result.success) throw new Error(result.error)
  } catch (error) {
    errors.report(error)
  }
}

// Chat, Agent and Audio all run on chat-type presets.
const isLlmMode = computed(() => ['chat', 'agent', 'audio'].includes(promptStore.currentMode))

const activeChatPreset = computed(() => {
  const preset = presetsStore.activePresetWithVariant
  if (preset?.type === 'chat') return preset as ChatPreset
  return null
})

const stableChatPreset = ref<ChatPreset | null>(null)
watch(
  activeChatPreset,
  (preset) => {
    if (preset) stableChatPreset.value = preset
  },
  { immediate: true },
)

// No preset switch has run yet at launch, so fall back to the persisted last-used preset.
const fallbackChatPreset = computed<ChatPreset | null>(() => {
  const inAudioMode = promptStore.currentMode === 'audio'
  const candidates = inAudioMode ? presetsStore.audioPresets : presetsStore.chatPresets
  if (candidates.length === 0) return null
  const lastUsed = presetsStore.getLastUsedPreset([inAudioMode ? AUDIO_CATEGORY : 'chat'])
  return candidates.find((p) => p.name === lastUsed) ?? candidates[0]
})

const activePreset = computed(() =>
  isLlmMode.value
    ? (stableChatPreset.value ?? fallbackChatPreset.value)
    : (imageGeneration.activePreset ?? null),
)

function selectedDevice(serviceName: BackendServiceName): InferenceDevice | undefined {
  const info = backendServices.info.find((s) => s.serviceName === serviceName)
  return info?.devices.find((d) => d.selected)
}

// The service that runs the active preset: ComfyUI for media, the speech sidecars for
// TTS / STT, the chat engine otherwise. Undefined for remote inference.
const activeService = computed<BackendServiceName | undefined>(() => {
  const preset = activePreset.value
  if (!preset) return undefined
  if (preset.type === 'comfy') return 'comfyui-backend'
  if (preset.sttPreset) return 'openvino-backend'
  if (preset.ttsPreset) {
    if (textToSpeech.selectedEngine === 'external') return undefined
    return textToSpeech.selectedEngine === 'kokoro' ? 'openvino-backend' : 'qwen3-tts-backend'
  }
  return backendToService[textInference.backend] ?? undefined
})

const SPEECH_BACKEND_OF: Partial<Record<BackendServiceName, SpeechBackend>> = {
  'openvino-backend': 'openVINO',
  'qwen3-tts-backend': 'qwen3TTS',
}

const speechBackend = computed<SpeechBackend | undefined>(() => {
  const preset = activePreset.value
  if (!preset || preset.type !== 'chat' || !(preset.ttsPreset || preset.sttPreset)) return undefined
  const service = activeService.value
  return service ? SPEECH_BACKEND_OF[service] : 'external'
})

const bar = computed(() =>
  promptBarModel({
    activePreset: activePreset.value,
    presetLabel: (name) => oemBranding.presetLabel(name),
    machine: {
      chatBackend: textInference.backend,
      chatModel: textInference.activeModel,
      speechBackend: speechBackend.value,
      device: activeService.value ? selectedDevice(activeService.value) : undefined,
    },
    catalog: presetsStore.getPresetsByCategories([]),
    presetGate: gateOf,
    style: promptBarStyle.active,
    agents: agentPick.agents.value,
    pickedAgentId: pickedAgentId.value,
  }),
)

const headerChips = computed(() => bar.value.headerChips)

const agentQuery = ref('')
const agentView = computed(() => agentList(bar.value.agents, agentQuery.value))

async function pickPreset(name: string) {
  if (name) await agentPick.pickPreset(name)
}

async function pickAgent(id: string) {
  if (id) await agentPick.pickAgent(id)
}

function chipOf<K extends HeaderChip['kind']>(kind: K) {
  return computed(() =>
    headerChips.value.find((c): c is Extract<HeaderChip, { kind: K }> => c.kind === kind),
  )
}

const deviceChip = chipOf('device')
const modelChip = chipOf('model')
const presetChip = chipOf('preset')
const presetChipDescription = computed(() =>
  presetChip.value?.agentId
    ? bar.value.pickedAgent?.description
    : descriptionOf(presetChip.value?.name ?? ''),
)

const BACKEND_NAMES = {
  llamaCPP: 'llama.cpp',
  openVINO: 'OpenVINO',
  cloud: HYBRID_CLOUD_NAME,
  comfyui: 'ComfyUI',
  qwen3TTS: 'Qwen3-TTS',
} as const

const backendChip = computed(() => {
  const chip = headerChips.value.find((c) => c.kind === 'backend')
  if (!chip) return undefined
  if (chip.backend === 'external' || speechBackend.value) {
    const name =
      chip.backend === 'external'
        ? languages.PROMPT_BAR_EXTERNAL_SPEECH_ENDPOINT
        : BACKEND_NAMES[chip.backend]
    return { name, description: languages.PROMPT_BAR_SPEECH_BACKEND.replace('{engine}', name) }
  }
  const provider = cloudMode.selectedProvider?.name
  const name =
    chip.backend === 'cloud' && provider
      ? `${BACKEND_NAMES.cloud} · ${provider}`
      : BACKEND_NAMES[chip.backend]
  const description =
    chip.backend === 'comfyui'
      ? 'Images and videos are generated by ComfyUI workflows.'
      : chip.backend === 'cloud'
        ? textInferenceBackendDescription.cloud
        : chip.backend === 'llamaCPP'
          ? 'Chat is running on the llama.cpp backend (GGUF models).'
          : 'Chat is running on the OpenVINO backend (OpenVINO IR models).'
  return { name, description }
})

const computeChip = computed(() => {
  const snapshot = computeMetrics.latest
  if (!snapshot) return null
  // Only a GPU selection names a card; on CPU / NPU the lookup falls back to the primary card.
  const device = deviceChip.value
  const onCloud = headerChips.value.some((c) => c.kind === 'backend' && c.backend === 'cloud')
  const gpu = onCloud
    ? undefined
    : computeMetrics.gpuFor(device?.category === 'gpu' ? device.name : undefined)
  const label =
    gpu?.memUsedMiB != null
      ? `${formatMib(gpu.memUsedMiB)}${gpu.memTotalMiB != null ? ` / ${formatMib(gpu.memTotalMiB)}` : ''}`
      : `${formatMib(snapshot.host.memUsedMiB)} / ${formatMib(snapshot.host.memTotalMiB)}`
  return {
    label,
    sections: computeDetailSections(gpu, snapshot.host),
    ariaLabel: languages.COMPUTE_METRICS_LABEL || 'Compute resources',
  }
})

// The base preset's description, the same text as the quick preset picker; the active
// preset is variant-merged, where `description` can be a per-variant blurb instead.
function descriptionOf(name: string): string | undefined {
  return presetsStore.presets.find((p) => p.name === name)?.description
}

const currentModel = computed(() =>
  textInference.llmModels.find((m) => m.active && m.type === textInference.backend),
)

// The merged Assistant preset shows per-capability icons on its model chip.
const isAssistantPreset = computed(() => presetChip.value?.name === 'Assistant')

const contextUsedTokens = computed(() => openAiCompatibleChat.usedTokens)
const contextMaxTokens = computed(() => textInference.effectiveContextWindow)
const contextUsage = computed(() => openAiCompatibleChat.contextUsage)
</script>
