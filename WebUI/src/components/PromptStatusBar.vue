<template>
  <!-- min-h keeps the row the same height in every mode: the context widget and
       zoom controls (28px) are chat-only, so without it the row would collapse to
       the preset chip's height and sit closer to the prompt input. -->
  <div class="flex w-full items-center gap-2 m-1 min-h-7 text-xs text-muted-foreground">
    <!-- Active preset / model indicator -->
    <div
      v-if="presetIndicator"
      role="status"
      :aria-label="`Active preset: ${presetIndicator.name}`"
      class="flex min-w-0 items-center gap-2"
    >
      <TooltipProvider>
        <Tooltip :delay-duration="0">
          <TooltipTrigger as-child>
            <button type="button" class="flex min-w-0 items-center gap-1 text-left cursor-help">
              <img
                v-if="presetIndicator.image"
                :src="presetIndicator.image"
                :alt="presetIndicator.name"
                class="size-5 rounded object-cover flex-none border border-border"
              />
              <span class="text-foreground font-medium truncate">{{ presetIndicator.name }}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent
            align="start"
            class="w-64 bg-card border border-border text-foreground p-3 z-[200]"
          >
            <p class="text-sm font-semibold">{{ presetIndicator.name }}</p>
            <p v-if="presetIndicator.description" class="mt-1 text-xs text-muted-foreground">
              {{ presetIndicator.description }}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <div v-if="presetIndicator.model && currentModel">·</div>
      <ModelCapabilities
        v-if="presetIndicator.model && currentModel"
        :model="currentModel"
        show-name
        :delay-duration="0"
      >
        <template #trigger>
          <button type="button" class="truncate text-left cursor-help">
            {{ presetIndicator.model }}
          </button>
        </template>
      </ModelCapabilities>
      <span v-else-if="presetIndicator.model" class="truncate">{{ presetIndicator.model }}</span>
    </div>
    <!-- Context usage (chat only). Sibling of the status element so the live
         region doesn't re-announce the token percentage on every stream tick. -->
    <div v-if="isChatMode">·</div>
    <Context
      v-if="isChatMode"
      trigger-size="xs"
      :used-tokens="contextUsedTokens"
      :max-tokens="contextMaxTokens"
      :max-context-size="textInference.maxContextSizeFromModel"
      :dynamic-context="textInference.contextSizeIsDynamic"
      :usage="contextUsage"
    />
    <!-- Same gauge in agent mode, fed by Pi's context report instead of the chat
         store — see AgentTokenUsage / store/agentMode.ts. -->
    <div v-if="isAgentMode">·</div>
    <AgentTokenUsage v-if="isAgentMode" />
    <!-- Font zoom controls (chat only) -->
    <div v-if="isChatMode" class="ml-auto flex flex-none gap-1">
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
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { MagnifyingGlassPlusIcon, MagnifyingGlassMinusIcon } from '@heroicons/vue/24/outline'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useTextInference } from '@/assets/js/store/textInference'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets.ts'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets'
import { Context } from '@/components/ui/context'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import ModelCapabilities from '@/components/ModelCapabilities.vue'
import AgentTokenUsage from '@/components/AgentTokenUsage.vue'

const promptStore = usePromptStore()
const textInference = useTextInference()
const openAiCompatibleChat = useOpenAiCompatibleChat()
const imageGeneration = useImageGenerationPresets()
const presetsStore = usePresets()

const isChatMode = computed(() => promptStore.getCurrentMode() === 'chat')
const isAgentMode = computed(() => promptStore.getCurrentMode() === 'agent')

// Get active chat preset
const activeChatPreset = computed(() => {
  const preset = presetsStore.activePresetWithVariant
  if (preset?.type === 'chat') return preset as ChatPreset
  return null
})

// Remember the most recent chat preset so the indicator stays stable while a
// tool call or Home Agent turn temporarily switches the active preset to a
// ComfyUI one during agentic tool use.
const stableChatPreset = ref<ChatPreset | null>(null)
watch(
  activeChatPreset,
  (preset) => {
    if (preset) stableChatPreset.value = preset
  },
  { immediate: true },
)

// On startup no preset switch has run yet (presets/backends load async), so
// `activePresetWithVariant` — and thus `stableChatPreset` — can be null even
// though there is a persisted last-used preset. Fall back to it (or the first
// available chat preset) so the indicator isn't blank at launch.
const fallbackChatPreset = computed<ChatPreset | null>(() => {
  const chatPresets = presetsStore.chatPresets
  if (chatPresets.length === 0) return null
  const lastUsed = presetsStore.getLastUsedPreset(['chat'])
  return chatPresets.find((p) => p.name === lastUsed) ?? chatPresets[0]
})

// Preset/model indicator shown at the left of the bar. Keyed off the user's
// selected mode (not `currentMode`) so background comfy switches during
// agentic / Home Agent tool use don't flip it.
const presetIndicator = computed(() => {
  if (promptStore.userSelectedMode === 'chat') {
    const preset = stableChatPreset.value ?? fallbackChatPreset.value
    if (!preset) return null
    // Match the ModelSelector label: display only the last path segment.
    const model = textInference.activeModel
    return {
      image: preset.image,
      name: preset.name,
      model: model?.split('/').at(-1) ?? model,
      description: basePresetDescription(preset.name),
    }
  }
  if (promptStore.userSelectedMode === 'agent') {
    // Agent mode has no presets — a generic label plus the shared model
    // (local backend model or the Cloud Mode model, same as Chat).
    const model = textInference.activeModel
    return {
      image: undefined as string | undefined,
      name: 'Agent',
      model: model?.split('/').at(-1) ?? model,
      description:
        'Pi coding agent working on files in the workspace folder, using the model shared with Chat.',
    }
  }
  const preset = imageGeneration.activePreset
  if (!preset) return null
  return {
    image: preset.image,
    name: preset.name,
    model: undefined as string | undefined,
    description: basePresetDescription(preset.name),
  }
})

// The tooltip shows the base preset's description — the same text as the quick
// preset picker. `stableChatPreset` / `imageGeneration.activePreset` are
// variant-merged, where `description` can be a per-variant blurb instead.
function basePresetDescription(name: string): string | undefined {
  return presetsStore.presets.find((p) => p.name === name)?.description
}

// Active model object (capabilities, max context) — same source as ModelSelector.
// Undefined for models without metadata (e.g. cloud models), which hides the tooltip.
const currentModel = computed(() =>
  textInference.llmModels.find((m) => m.active && m.type === textInference.backend),
)

// Context usage data for Context component
const contextUsedTokens = computed(() => openAiCompatibleChat.usedTokens)
const contextMaxTokens = computed(() => textInference.effectiveContextWindow)
const contextUsage = computed(() => openAiCompatibleChat.contextUsage)
</script>
