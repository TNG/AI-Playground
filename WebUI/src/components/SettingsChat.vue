<template>
  <div>
    <div class="flex flex-col gap-6 p-1">
      <PresetSelector
        type="chat"
        :model-value="presetsStore.activePresetName || undefined"
        @update:model-value="handlePresetChange"
        @update:variant="handleVariantChange"
      />

      <!-- When the Home Agent preset is the active chat preset, surface a
           global-settings warning. These knobs apply to every Home Agent
           conversation (Telegram + desktop), so changes can lock the user
           out of remote access if not verified. -->
      <div
        v-if="isHomeAgentPresetActive"
        class="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm text-foreground"
      >
        <p class="font-semibold text-amber-600 dark:text-amber-200">Global Home Agent Settings</p>
        <p class="text-xs text-muted-foreground">
          The settings for this preset impact all Home Agent conversations. Please verify after
          changing them to ensure that you can still access AI Playground remotely.
        </p>
      </div>

      <!-- TTS preset: a direct Qwen3-TTS synthesizer, no LLM controls. -->
      <SettingsTts v-if="isTtsPreset" />

      <div v-else class="flex flex-col gap-4">
        <!-- Backend selector - only shown when multiple backends are available -->
        <div v-if="!isBackendLocked" class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap">Backend</Label>
          <drop-down-new
            title="Select Backend"
            @change="handleBackendChange"
            :value="textInference.backend"
            :items="availableBackendItems"
          ></drop-down-new>
        </div>
        <!-- Cloud Mode swaps the hardware "Device" picker for a remote "Provider" picker. -->
        <div
          v-if="textInference.backend === 'cloud'"
          class="grid grid-cols-[120px_1fr] items-center gap-4"
        >
          <Label class="whitespace-nowrap">Provider</Label>
          <ProviderSelector />
        </div>
        <div v-else class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap">{{ languages.DEVICE }}</Label>
          <DeviceSelector :backend="deviceServiceName" />
        </div>
        <!-- The picker's trigger is named after whichever model is selected, so the
             row carries the stable name that identifies what the control is for. -->
        <div
          role="group"
          :aria-label="languages.MODEL"
          class="grid grid-cols-[120px_1fr] items-center gap-4"
        >
          <!-- The gear lives in the label column: managing models belongs to this
               row, but it must not eat into the width the picker needs to show a
               model name. -->
          <div class="flex items-center justify-between gap-2">
            <Label class="whitespace-nowrap">{{ languages.MODEL }}</Label>
            <SettingsButton
              class="shrink-0"
              :title="languages.MODEL_MANAGER_MANAGE"
              :aria-label="languages.MODEL_MANAGER_MANAGE"
              @click="uiStore.openModelManager()"
            />
          </div>
          <div class="flex items-center gap-2 min-w-0">
            <div class="flex-1 min-w-0">
              <ModelSelector />
            </div>
            <CapabilityIcons v-if="currentModel" :model="currentModel" />
          </div>
        </div>
        <!-- Two numbers that are read together (a reply cannot exceed either), so
             they share a row rather than stacking two mostly-empty ones. Each half
             repeats the sidebar's label/control grid, so the right-hand pair sits
             in its half exactly as the left one does. -->
        <div class="grid grid-cols-2 gap-4">
          <div class="grid grid-cols-[120px_1fr] items-center gap-4">
            <label class="whitespace-nowrap">{{ languages.ANSWER_MAX_TOKENS }}</label>
            <input
              type="number"
              v-model="textInference.maxTokens"
              min="0"
              max="4096"
              step="1"
              class="rounded-sm text-foreground text-center h-7 w-20 leading-7 p-0 bg-transparent border border-border"
            />
          </div>
          <div
            v-if="textInference.contextSizeSettingSupported"
            class="grid grid-cols-[120px_1fr] items-center gap-4"
          >
            <Label class="whitespace-nowrap">{{ languages.ANSWER_CONTEXT_SIZE }}</Label>
            <input
              type="number"
              v-model="textInference.contextSize"
              min="512"
              max="131072"
              step="512"
              class="rounded-sm text-foreground text-center h-7 w-20 leading-7 p-0 bg-transparent border border-border"
            />
          </div>
        </div>
        <div class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap"
            >Temperature: {{ textInference.temperature.toFixed(1) }}</Label
          >
          <Slider v-model="textInference.temperature" :min="0" :max="2" :step="0.1" />
        </div>
        <!-- Both are per-reply switches; the thinking one only exists for models
             whose template supports enable_thinking. Not the label/control grid:
             each box belongs to the word beside it, so the pair reads left to
             right instead of across two columns. `for` already forwards a label
             click to the checkbox (a button is a labelable element), so a handler
             here would toggle it twice. -->
        <div class="flex items-center gap-2">
          <template v-if="textInference.modelSupportsThinkingToggle">
            <Label for="thinking" class="cursor-pointer whitespace-nowrap">Thinking</Label>
            <Checkbox
              id="thinking"
              :model-value="textInference.thinkingEnabled"
              @click="() => (textInference.thinkingEnabled = !textInference.thinkingEnabled)"
            />
          </template>
          <!-- The gap only exists when something precedes it, so on a model without
               the thinking toggle Metrics still starts at the label column. -->
          <Label
            for="metrics"
            class="cursor-pointer whitespace-nowrap"
            :class="{ 'ml-6': textInference.modelSupportsThinkingToggle }"
            >{{ languages.ANSWER_METRICS }}</Label
          >
          <Checkbox
            id="metrics"
            :model-value="textInference.metricsEnabled"
            @click="() => (textInference.metricsEnabled = !textInference.metricsEnabled)"
          />
        </div>
        <!-- Retrieval belongs together: the embedding model is what the documents
             are indexed with, so the uploader opens from the same row. The button
             is an icon plus its count — a full label left the dropdown too narrow
             to read a model name in. -->
        <div v-if="enableRAG" class="grid grid-cols-[120px_1fr] items-center gap-4">
          <Label class="whitespace-nowrap">Embeddings</Label>
          <!-- A grid, not a flex row: as a grid item the dropdown stretches to the
               space the button leaves, which a flex child of DropDownNew does not. -->
          <div class="grid grid-cols-[1fr_auto] items-center gap-2 min-w-0">
            <drop-down-new
              :title="languages.RAG_DOCUMENT_EMBEDDING_MODEL"
              @change="(item) => textInference.selectEmbeddingModel(textInference.backend, item)"
              :value="activeEmbeddingModelName"
              :items="embeddingModelItems"
            ></drop-down-new>
            <Button
              variant="secondary"
              class="h-[30px] shrink-0 gap-1.5 rounded px-2 text-sm"
              @click="showUploader = !showUploader"
              :disabled="processing"
              :title="documentButtonText"
              :aria-label="documentButtonText"
            >
              <DocumentTextIcon class="size-4" />
              <span v-if="documentStats.total > 0" class="text-xs">
                {{ documentStats.enabled }}
              </span>
              <PlusIcon v-else class="size-3" />
            </Button>
          </div>
        </div>

        <!-- Each panel carries its own master switch in its header: the toggle and
             what it governs are one block, which is two fewer label rows than
             floating the switches above the panels. Tools need a tool-calling
             model, so the header explains itself when the model has none. -->
        <template v-if="showTools">
          <SettingsBuiltinTools />
          <SettingsMcp />
        </template>

        <!-- System Prompt - only shown in advanced mode -->
        <div v-if="advancedMode" class="grid grid-cols-[120px_1fr] items-start gap-4">
          <Label class="whitespace-nowrap pt-2">System Prompt</Label>
          <Textarea
            v-model="textInference.systemPrompt"
            placeholder="You are a helpful AI assistant."
            class="min-h-[100px] text-sm"
          />
        </div>

        <div class="border-t border-border items-center flex-wrap grid grid-cols-1 gap-2">
          <button class="mt-4" @click="textInference.resetActivePresetSettings">
            <div class="svg-icon i-refresh">Reset</div>
            {{ languages.COM_LOAD_PRESET_DEFAULTS || 'Reset Preset Settings' }}
          </button>
        </div>
      </div>
      <rag v-if="showUploader" ref="ragPanel" @close="showUploader = false"></rag>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'

import {
  backendToService,
  LlmBackend,
  useTextInference,
  textInferenceBackendDisplayName,
} from '@/assets/js/store/textInference.ts'
import DeviceSelector from '@/components/DeviceSelector.vue'
import ProviderSelector from '@/components/ProviderSelector.vue'
import ModelSelector from '@/components/ModelSelector.vue'
import SettingsButton from '@/components/SettingsButton.vue'
import { DocumentTextIcon, PlusIcon } from '@heroicons/vue/24/solid'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import { ref, computed } from 'vue'
import { useI18N } from '@/assets/js/store/i18n.ts'
import Rag from '@/components/Rag.vue'
import SettingsMcp from '@/components/SettingsMcp.vue'
import SettingsBuiltinTools from '@/components/SettingsBuiltinTools.vue'
import SettingsTts from '@/components/SettingsTts.vue'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import DropDownNew from '@/components/DropDownNew.vue'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets.ts'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching.ts'
import PresetSelector from '@/components/PresetSelector.vue'
import * as toast from '@/assets/js/toast'
import { useProductMode } from '@/assets/js/store/productMode'
import { useConversations, HOME_AGENT_CHAT_PRESET_NAME } from '@/assets/js/store/conversations'
import { useHomeAgent } from '@/assets/js/store/homeAgent'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { sortFavoritesFirst } from '@/assets/js/models/favorites'
import { useUIStore } from '@/assets/js/store/ui'

const showUploader = ref(false)
const processing = ref(false)
const i18nState = useI18N().state
const textInference = useTextInference()
const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const backendServices = useBackendServices()
const productModeStore = useProductMode()
const conversations = useConversations()
const homeAgent = useHomeAgent()
const cloudMode = useCloudMode()
const uiStore = useUIStore()

// Non-null service name for the local-backend DeviceSelector (only rendered for
// non-cloud backends; cloud uses ProviderSelector instead).
const deviceServiceName = computed(
  () => backendToService[textInference.backend] ?? 'llamacpp-backend',
)

const isHomeAgentPresetActive = computed(
  () => presetsStore.activePresetName === HOME_AGENT_CHAT_PRESET_NAME,
)

// Get the active chat preset
const activeChatPreset = computed(() => {
  const preset = presetsStore.activePresetWithVariant
  if (preset?.type === 'chat') return preset as ChatPreset
  return null
})

// Check if backend is locked (only one backend allowed)
const isBackendLocked = computed(() => {
  return activeChatPreset.value?.backends?.length === 1
})

// Direct Text-to-Speech preset: hides all LLM controls in favour of SettingsTts.
const isTtsPreset = computed(() => activeChatPreset.value?.ttsPreset === true)

// Active model (capabilities) for the icon row next to the selector — same
// source as ModelSelector / PromptStatusBar.
const currentModel = computed(() =>
  textInference.llmModels.find((m) => m.active && m.type === textInference.backend),
)

const activeEmbeddingModelName = computed(
  () =>
    textInference.llmEmbeddingModels
      .filter((m) => m.type === textInference.backend)
      .find((m) => m.active)?.name ?? '',
)

// Same treatment as the chat model picker: favorites float to the top.
const embeddingModelItems = computed(() =>
  sortFavoritesFirst(
    textInference.llmEmbeddingModels.filter((m) => m.type === textInference.backend),
  ).map((item) => ({
    label: item.name.split('/').at(-1) ?? item.name,
    value: item.name,
    active: item.downloaded,
  })),
)

// UI visibility flags from preset
const enableRAG = computed(() => activeChatPreset.value?.enableRAG ?? false)
const showTools = computed(() => activeChatPreset.value?.showTools ?? false)
const advancedMode = computed(() => activeChatPreset.value?.advancedMode ?? false)

// Get available backends from preset (fallback when none configured on preset)
const availableBackends = computed(() => {
  let base = activeChatPreset.value?.backends ?? (['llamaCPP', 'openVINO'] as LlmBackend[])
  if (productModeStore.productMode === 'nvidia') {
    base = base.filter((b) => b !== 'openVINO')
  }
  // Surface Cloud Mode as a selectable backend whenever the feature is enabled.
  if (cloudMode.isFeatureEnabled && !base.includes('cloud')) {
    base = [...base, 'cloud']
  }
  return base
})

// Backend items for dropdown
const availableBackendItems = computed(() => {
  return availableBackends.value.map((backend) => ({
    label: textInferenceBackendDisplayName[backend] || backend,
    value: backend,
    active: isBackendRunning(backend),
  }))
})

// Handle backend change from dropdown
function handleBackendChange(newBackend: string) {
  textInference.backend = newBackend as LlmBackend
  // Switching to Cloud Mode refreshes the selected provider's model list
  // (overwriting it on success) so the picker reflects the live provider state.
  if (newBackend === 'cloud') {
    cloudMode.refreshSelectedProviderModels()
  }
}

async function handlePresetChange(presetName: string) {
  // Route the active conversation alongside the preset:
  //   • picking Home Agent jumps to the most-recently routed Home Agent thread
  //     (so the Telegram bridge and this view share the same conversation)
  //   • picking any other chat preset off a Home Agent thread spawns a fresh
  //     main conversation so the user isn't writing into Home Agent state
  //     with a non-Home-Agent preset.
  const switchingToHomeAgent = presetName === HOME_AGENT_CHAT_PRESET_NAME
  const onHomeAgentThread = conversations.getThreadKind(conversations.activeKey) === 'homeAgent'

  const result = await presetSwitching.switchPreset(presetName, {
    skipModeSwitch: true, // We're already in chat mode
  })

  if (result.success) {
    // Only reroute the conversation after the preset switch actually succeeds —
    // otherwise a failed switch would leave the UI on a different thread while
    // the picker stayed on the previous preset.
    if (switchingToHomeAgent) {
      conversations.activeKey = homeAgent.ensureActiveRemoteConversation()
    } else if (onHomeAgentThread) {
      conversations.addNewConversation()
    }
    toast.success(`Switched to ${presetName}`)
  } else if (result.error) {
    toast.error(`Failed to switch preset: ${result.error}`)
  }
}

async function handleVariantChange(presetName: string, variantName: string | null) {
  if (variantName) {
    const result = await presetSwitching.switchPreset(presetName, {
      variant: variantName,
      skipModeSwitch: true,
    })

    if (!result.success && result.error) {
      toast.error(`Failed to switch variant: ${result.error}`)
    }
  }
}

const documentButtonText = computed(() => {
  const stats = documentStats.value
  if (stats.total === 0) {
    return 'Add Documents'
  } else {
    return `${i18nState.RAG_DOCUMENTS} (${stats.enabled})`
  }
})

const documentStats = computed(() => {
  const totalDocs = textInference.ragList.length
  const enabledDocs = textInference.ragList.filter((doc) => doc.isChecked).length
  return { total: totalDocs, enabled: enabledDocs }
})

function isBackendRunning(backend: LlmBackend): boolean {
  // Cloud Mode has no local service — it's "ready" once a provider base URL
  // is configured.
  if (backend === 'cloud') return !!cloudMode.activeProviderBaseUrl
  const serviceName = backendToService[backend]
  return backendServices.info.find((item) => item.serviceName === serviceName)?.status === 'running'
}
</script>
