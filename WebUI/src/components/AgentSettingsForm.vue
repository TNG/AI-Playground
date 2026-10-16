<template>
  <div class="flex flex-col gap-6 min-w-0">
    <!-- A fieldset, so every control below (Reka triggers are buttons too) is disabled natively. -->
    <fieldset
      :disabled="disabled"
      class="flex flex-col gap-6 min-w-0"
      :aria-describedby="describedBy"
    >
      <div class="grid grid-cols-[120px_1fr] items-center gap-4" :class="problemClass('backend')">
        <Label class="whitespace-nowrap">Backend</Label>
        <drop-down-new
          title="Select Backend"
          :value="binding.backend"
          :items="binding.backendItems"
          @change="binding.setBackend"
        ></drop-down-new>
      </div>
      <!-- Cloud Mode swaps the hardware "Device" picker for a remote "Provider" picker. -->
      <div
        v-if="binding.backend === 'cloud'"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
        :class="problemClass('cloudProvider')"
      >
        <Label class="whitespace-nowrap">Provider</Label>
        <slot name="provider" />
      </div>
      <div
        v-else
        class="grid grid-cols-[120px_1fr] items-center gap-4"
        :class="problemClass('device')"
      >
        <Label class="whitespace-nowrap">{{ i18n.DEVICE }}</Label>
        <slot name="device" />
      </div>
      <!-- The picker's trigger is named after the selected model, so the row carries the
           stable name saying what the control is for. -->
      <div
        role="group"
        :aria-label="i18n.MODEL"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
        :class="problemClass('model')"
      >
        <Label class="whitespace-nowrap">{{ i18n.MODEL }}</Label>
        <div class="flex items-center gap-2 min-w-0">
          <div class="flex-1 min-w-0">
            <slot name="model" />
          </div>
          <CapabilityIcons v-if="binding.currentModel" :model="binding.currentModel" />
        </div>
      </div>
      <div
        v-if="binding.contextSizeSupported"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
      >
        <Label :for="contextSizeId" class="whitespace-nowrap">
          {{ i18n.ANSWER_CONTEXT_SIZE }}
        </Label>
        <div class="flex items-center gap-3">
          <input
            :id="contextSizeId"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            :value="contextSizeField.draft"
            class="rounded-sm text-foreground text-center h-7 w-24 leading-7 p-0 bg-transparent border border-border disabled:opacity-50"
            @focus="contextSizeField.onFocus"
            @input="contextSizeField.onInput"
            @blur="contextSizeField.commit"
            @keydown.enter="contextSizeField.commit"
          />
          <span v-if="binding.contextSize < 16384" class="text-xs text-amber-500">
            Agentic sessions typically need 32k+ context.
          </span>
        </div>
      </div>
      <p v-if="binding.sharedWithChat" class="text-xs text-muted-foreground">
        Backend, device/provider, model and context size are shared with Chat mode.
      </p>

      <!-- Only models whose template honours enable_thinking can be told to stop, and only a
           session that thinks has anything to shorten. -->
      <div v-if="binding.thinkingToggleSupported" class="flex flex-col gap-2">
        <Label class="whitespace-nowrap">Thinking</Label>
        <label class="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            class="mt-0.5"
            :checked="binding.thinkingEnabled"
            @change="binding.setThinkingEnabled(!binding.thinkingEnabled)"
          />
          <span class="flex flex-col">
            <span class="text-foreground">Think before acting</span>
            <span v-if="binding.sharedWithChat" class="text-xs text-muted-foreground">
              Shared with Chat mode, where it applies to every answer.
            </span>
          </span>
        </label>
        <label class="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            class="mt-0.5"
            :disabled="!binding.thinkingEnabled"
            :checked="binding.planningThinkingOnly"
            @change="binding.setPlanningThinkingOnly(!binding.planningThinkingOnly)"
          />
          <span class="flex flex-col">
            <span class="text-foreground" :class="{ 'opacity-50': !binding.thinkingEnabled }">
              Reasoning only during planning
            </span>
            <span class="text-xs text-muted-foreground">
              The agent thinks while it works out what to build and stops once it starts building:
              Game Agent follows the checklist in its plan file from then on, and Quick Coder writes
              its game as a second step, after the plan. Presets that do not plan think throughout.
            </span>
          </span>
        </label>
      </div>
    </fieldset>

    <!-- Outside both fieldsets, so a read-only form never disables it. -->
    <slot name="between" />

    <fieldset
      :disabled="disabled"
      class="flex flex-col gap-6 min-w-0"
      :aria-describedby="describedBy"
    >
      <div class="border-t border-border pt-4 flex flex-col gap-3">
        <Label class="whitespace-nowrap">Capabilities</Label>
        <p class="text-xs text-muted-foreground">
          What the agent is equipped with, on top of its file and shell tools. Each capability adds
          its tools and instructions to the session.
        </p>
        <AgentCapabilityChecklist
          :model-value="binding.capabilities"
          :catalog="binding.capabilityCatalog"
          :mcp-servers="mcp.allServers"
          @update:model-value="binding.setCapabilities"
        >
          <!-- Same selector as Chat Settings' Embeddings row, but bound to the embedding
               backend rather than the chat backend: an agent can run on a cloud model while
               its document search stays local. The model downloads on first rag use. -->
          <div
            v-if="ragEnabled"
            class="grid grid-cols-[120px_1fr] items-center gap-4"
            :class="problemClass('embeddingModel')"
          >
            <Label class="whitespace-nowrap">Embeddings</Label>
            <drop-down-new
              :title="i18n.RAG_DOCUMENT_EMBEDDING_MODEL"
              :value="binding.embeddingModelName"
              :items="binding.embeddingModelItems"
              @change="binding.setEmbeddingModel"
            ></drop-down-new>
          </div>

          <!-- Shown whenever the capability exists, including while it reports itself
               unavailable: turning every workflow off is what makes it unavailable, and this
               is where they are turned back on. -->
          <SettingsBuiltinTools
            v-if="hasMediaCapability"
            variant="media"
            :settings="binding.mediaTools"
          />

          <slot name="capability-extras" />

          <template #mcp-notices>
            <p
              v-for="serverId in missingMcpServers"
              :key="serverId"
              class="text-xs text-amber-500 rounded-sm ring-1 ring-amber-500 px-2 py-1"
            >
              {{ describeMissingMcpServer(serverId) }}
            </p>
          </template>
        </AgentCapabilityChecklist>
        <p v-if="liveSession" class="text-xs text-amber-500">
          Changes take effect on the next turn, which starts a fresh Pi session. Attached MCP
          servers are started then too.
        </p>
      </div>

      <slot name="footer" />
    </fieldset>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useMcp } from '@/assets/js/store/mcp'
import AgentCapabilityChecklist from '@/components/AgentCapabilityChecklist.vue'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import SettingsBuiltinTools from '@/components/SettingsBuiltinTools.vue'
import { Label } from '@/components/ui/label'
import { useContextSizeField } from '@/assets/js/contextSizeField'
import { useSettingsProblemMarks } from '@/assets/js/settingsProblemMarks'
import type { AgentSettingsBinding } from '@/lib/agentSettingsBinding'

const props = defineProps<{
  binding: AgentSettingsBinding
  idPrefix: string
  disabled?: boolean
  describedBy?: string
  /** Bound to an open session, whose changes reach the agent on its next turn. */
  liveSession?: boolean
}>()

const mcp = useMcp()
const i18n = useI18N().state

const contextSizeId = computed(() => `${props.idPrefix}-context-size`)
const contextSize = computed<number>({
  get: () => props.binding.contextSize,
  set: (value) => props.binding.setContextSize(value),
})
const contextSizeField = useContextSizeField(contextSize)

const hasMediaCapability = computed(() =>
  props.binding.capabilityCatalog.some((capability) => capability.id === 'media'),
)

// The embedding picker belongs to the rag capability; hide it with the checkbox.
const ragEnabled = computed(
  () =>
    props.binding.capabilityCatalog.some((capability) => capability.id === 'rag') &&
    props.binding.capabilities.includes('rag'),
)

const { problemClass, missingMcpServers, describeMissingMcpServer } = useSettingsProblemMarks(
  () => props.binding.problems,
)

onMounted(() => {
  void mcp.refreshAvailableServers()
})
</script>
