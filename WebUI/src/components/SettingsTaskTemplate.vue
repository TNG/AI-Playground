<template>
  <div class="border-t border-border pt-4 flex flex-col gap-6">
    <div class="flex flex-col gap-1">
      <Label class="whitespace-nowrap">{{ i18n.AGENT_TASK_EDIT_SETTINGS }}</Label>
      <p class="text-xs text-muted-foreground">{{ i18n.AGENT_TASK_EDIT_SETTINGS_HINT }}</p>
    </div>

    <div class="grid grid-cols-[120px_1fr] items-center gap-4" :class="problemClass('backend')">
      <Label class="whitespace-nowrap">Backend</Label>
      <drop-down-new
        title="Select Backend"
        :value="backend"
        :items="backendItems"
        @change="changeBackend"
      ></drop-down-new>
    </div>
    <div
      v-if="backend === 'cloud'"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
      :class="problemClass('cloudProvider')"
    >
      <Label class="whitespace-nowrap">Provider</Label>
      <ProviderSelector
        bound
        :model-value="template.cloudProviderId ?? cloudMode.selectedProviderId"
        @update:model-value="changeProvider"
      />
    </div>
    <div
      v-else
      class="grid grid-cols-[120px_1fr] items-center gap-4"
      :class="problemClass('device')"
    >
      <Label class="whitespace-nowrap">{{ i18n.DEVICE }}</Label>
      <DeviceSelector
        bound
        :backend="deviceServiceName"
        :model-value="deviceId"
        @update:model-value="changeDevice"
      />
    </div>
    <div
      role="group"
      :aria-label="i18n.MODEL"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
      :class="problemClass('model')"
    >
      <Label class="whitespace-nowrap">{{ i18n.MODEL }}</Label>
      <div class="flex items-center gap-2 min-w-0">
        <div class="flex-1 min-w-0">
          <drop-down-new
            v-if="backend === 'cloud'"
            :title="i18n.MODEL"
            :value="template.model ?? ''"
            :items="cloudModelItems"
            @change="(model) => agentTasks.editTemplate({ model })"
          ></drop-down-new>
          <!-- No auto-select: a saved model the list no longer offers is a problem to show. -->
          <ModelSelector
            v-else
            bound
            :backend="backend"
            :preset="agentMode.activeAgentPreset"
            :on-npu="onNpu"
            :model-value="template.model"
            @update:model-value="(model) => agentTasks.editTemplate({ model })"
          />
        </div>
        <CapabilityIcons v-if="currentModel" :model="currentModel" />
      </div>
    </div>
    <div v-if="contextSizeSupported" class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label for="task-edit-context-size" class="whitespace-nowrap">
        {{ i18n.ANSWER_CONTEXT_SIZE }}
      </Label>
      <div class="flex items-center gap-3">
        <input
          id="task-edit-context-size"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          :value="contextSizeField.draft"
          class="rounded-sm text-foreground text-center h-7 w-24 leading-7 p-0 bg-transparent border border-border"
          @focus="contextSizeField.onFocus"
          @input="contextSizeField.onInput"
          @blur="contextSizeField.commit"
          @keydown.enter="contextSizeField.commit"
        />
        <span v-if="contextSize < 16384" class="text-xs text-amber-500">
          Agentic sessions typically need 32k+ context.
        </span>
      </div>
    </div>

    <div v-if="supportsThinkingToggle" class="flex flex-col gap-2">
      <Label class="whitespace-nowrap">Thinking</Label>
      <label class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          class="mt-0.5"
          :checked="thinkingEnabled"
          @change="agentTasks.editTemplate({ thinkingEnabled: !thinkingEnabled })"
        />
        <span class="text-foreground">Think before acting</span>
      </label>
      <label class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          class="mt-0.5"
          :disabled="!thinkingEnabled"
          :checked="planningThinkingOnly"
          @change="agentTasks.editTemplate({ planningThinkingOnly: !planningThinkingOnly })"
        />
        <span class="text-foreground" :class="{ 'opacity-50': !thinkingEnabled }">
          Reasoning only during planning
        </span>
      </label>
    </div>

    <div class="border-t border-border pt-4 flex flex-col gap-3">
      <Label class="whitespace-nowrap">Capabilities</Label>
      <AgentCapabilityChecklist
        :model-value="capabilities"
        :catalog="capabilityCatalog"
        :mcp-servers="mcp.allServers"
        @update:model-value="(ids) => agentTasks.editTemplate({ capabilities: ids })"
      >
        <div
          v-if="ragEnabled"
          class="grid grid-cols-[120px_1fr] items-center gap-4"
          :class="problemClass('embeddingModel')"
        >
          <Label class="whitespace-nowrap">Embeddings</Label>
          <drop-down-new
            :title="i18n.RAG_DOCUMENT_EMBEDDING_MODEL"
            :value="embeddingModelName"
            :items="embeddingModelItems"
            @change="(embeddingModel) => agentTasks.editTemplate({ embeddingModel })"
          ></drop-down-new>
        </div>

        <SettingsBuiltinTools v-if="hasMediaCapability" variant="media" :settings="mediaTools" />

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
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { CLOUD_DEFAULT_MODEL, useCloudMode } from '@/assets/js/store/cloudMode'
import { useI18N } from '@/assets/js/store/i18n'
import { useMcp } from '@/assets/js/store/mcp'
import {
  backendToService,
  type LlmBackend,
  useTextInference,
} from '@/assets/js/store/textInference'
import AgentCapabilityChecklist from '@/components/AgentCapabilityChecklist.vue'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import DeviceSelector from '@/components/DeviceSelector.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import ModelSelector from '@/components/ModelSelector.vue'
import ProviderSelector from '@/components/ProviderSelector.vue'
import SettingsBuiltinTools from '@/components/SettingsBuiltinTools.vue'
import { Label } from '@/components/ui/label'
import { useAgentBackendItems } from '@/assets/js/agentBackendItems'
import { useCapabilityCatalog } from '@/assets/js/capabilityCatalog'
import { useContextSizeField } from '@/assets/js/contextSizeField'
import { useEmbeddingModelPicker } from '@/assets/js/embeddingModelPicker'
import { useSettingsProblemMarks } from '@/assets/js/settingsProblemMarks'
import { contextSizeSettingSupported, isNpuDevice } from '@/lib/llmBackendChoices'
import { llmModelChoices, modelSupportsThinkingToggle } from '@/lib/llmModelChoices'
import { draftMediaToolSettings } from '@/lib/mediaToolSettings'
import {
  templateBackendChange,
  templateDeviceChange,
  templateProviderChange,
  type TemplateChoiceContext,
} from '@/lib/taskTemplateEdits'

// Bound to the Task's draft only: every control writes through `editTemplate` (ADR 0003).
const props = defineProps<{ workspaceDir: string; template: AgentSessionSettings }>()

const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const backendServices = useBackendServices()
const cloudMode = useCloudMode()
const mcp = useMcp()
const textInference = useTextInference()
const i18n = useI18N().state

const { available: availableBackends, items: backendItems } = useAgentBackendItems(
  () => agentMode.activeAgentPreset?.backends,
)

const backend = computed<LlmBackend>(
  () => props.template.backend ?? availableBackends.value[0] ?? 'llamaCPP',
)

/** The draft with the backend it is shown with, for edits that depend on it. */
const shownTemplate = computed(() => ({ ...props.template, backend: backend.value }))

function serviceDevice(local: Exclude<LlmBackend, 'cloud'>) {
  const devices =
    backendServices.info.find((s) => s.serviceName === backendToService[local])?.devices ?? []
  const device = devices.find((d) => d.selected) ?? devices[0]
  return device ? { id: device.id, uuid: device.uuid ?? null } : undefined
}

function providerModels(providerId: string): string[] {
  const models = cloudMode.providers.find((p) => p.id === providerId)?.models ?? []
  return models.length > 0 ? models : [CLOUD_DEFAULT_MODEL]
}

const choiceContext: TemplateChoiceContext = {
  modelChoices: (local, id) =>
    llmModelChoices(textInference.llmModels, {
      backend: local,
      preset: agentMode.activeAgentPreset,
      onNpu: local === 'openVINO' && isNpuDevice(id),
      phisonSsdDetected: backendServices.phisonSsdDetected,
    }).map((model) => model.name),
  providerModels,
  serviceDevice,
  get selectedProviderId() {
    return cloudMode.selectedProviderId
  },
}

// Only rendered for local backends, so the fallback is inert.
const deviceServiceName = computed(() => backendToService[backend.value] ?? 'llamacpp-backend')

// A template without a device runs on the one the service has selected.
const deviceId = computed(() =>
  backend.value === 'cloud'
    ? undefined
    : (props.template.device?.id ?? serviceDevice(backend.value)?.id),
)

const onNpu = computed(() => backend.value === 'openVINO' && isNpuDevice(deviceId.value))

function changeBackend(choice: string): void {
  agentTasks.editTemplate(
    templateBackendChange(shownTemplate.value, choice as LlmBackend, choiceContext),
  )
}

function changeDevice(id: string, device: InferenceDevice | undefined): void {
  agentTasks.editTemplate(
    templateDeviceChange(shownTemplate.value, { id, uuid: device?.uuid ?? null }, choiceContext),
  )
}

function changeProvider(providerId: string): void {
  agentTasks.editTemplate(templateProviderChange(shownTemplate.value, providerId, choiceContext))
}

// The app's cloud models are the selected provider's; a template may use another one.
const cloudModelItems = computed(() =>
  providerModels(props.template.cloudProviderId ?? cloudMode.selectedProviderId).map((name) => ({
    label: name,
    value: name,
    active: true,
  })),
)

const currentModel = computed(() =>
  backend.value === 'cloud'
    ? undefined
    : textInference.llmModels.find(
        (m) => m.type === backend.value && m.name === props.template.model,
      ),
)

const contextSizeSupported = computed(() => contextSizeSettingSupported(backend.value, onNpu.value))

const contextSize = computed<number>({
  get: () => props.template.contextSize ?? agentMode.activeAgentPreset?.contextSize ?? 8192,
  set: (value) => agentTasks.editTemplate({ contextSize: value, contextSizeEdited: true }),
})
const contextSizeField = useContextSizeField(contextSize)

const supportsThinkingToggle = computed(() =>
  modelSupportsThinkingToggle(textInference.llmModels, backend.value, props.template.model),
)
const thinkingEnabled = computed(() => props.template.thinkingEnabled ?? true)
const planningThinkingOnly = computed(() => props.template.planningThinkingOnly ?? true)

const capabilities = computed(() => props.template.capabilities ?? [])

const mediaTools = draftMediaToolSettings({
  read: () => props.template,
  update: (change) => agentTasks.editTemplate(change),
})

// Listed for the draft's folder, so a capability's availability follows the Task, not the session.
const { catalog: capabilityCatalog, refresh: refreshCapabilityCatalog } = useCapabilityCatalog(
  () => ({
    workspaceDir: props.workspaceDir,
    embeddingModel: props.template.embeddingModel,
    mediaTools,
  }),
)

const hasMediaCapability = computed(() =>
  capabilityCatalog.value.some((capability) => capability.id === 'media'),
)

const ragEnabled = computed(
  () =>
    capabilityCatalog.value.some((capability) => capability.id === 'rag') &&
    capabilities.value.includes('rag'),
)

const { activeName: embeddingModelName, items: embeddingModelItems } = useEmbeddingModelPicker(
  () => textInference.llmEmbeddingModels,
  () => textInference.embeddingBackend,
  () => props.template.embeddingModel,
)

onMounted(async () => {
  void mcp.refreshAvailableServers()
  await refreshCapabilityCatalog()
})

const { problemClass, missingMcpServers, describeMissingMcpServer } = useSettingsProblemMarks(
  () => agentTasks.editProblems,
)
</script>
