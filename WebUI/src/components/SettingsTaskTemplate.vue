<template>
  <div class="border-t border-border pt-4 flex flex-col gap-6">
    <div class="flex flex-col gap-1">
      <Label class="whitespace-nowrap">{{ i18n.AGENT_TASK_EDIT_SETTINGS }}</Label>
      <p class="text-xs text-muted-foreground">{{ i18n.AGENT_TASK_EDIT_SETTINGS_HINT }}</p>
    </div>

    <AgentSettingsForm :binding="binding" id-prefix="task-edit">
      <template #provider>
        <ProviderSelector
          bound
          :model-value="template.cloudProviderId ?? cloudMode.selectedProviderId"
          @update:model-value="changeProvider"
        />
      </template>
      <template #device>
        <DeviceSelector
          bound
          :backend="deviceServiceName"
          :model-value="deviceId"
          @update:model-value="changeDevice"
        />
      </template>
      <template #model>
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
      </template>
    </AgentSettingsForm>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { CLOUD_DEFAULT_MODEL, useCloudMode } from '@/assets/js/store/cloudMode'
import { useI18N } from '@/assets/js/store/i18n'
import {
  backendToService,
  type LlmBackend,
  useTextInference,
} from '@/assets/js/store/textInference'
import AgentSettingsForm from '@/components/AgentSettingsForm.vue'
import DeviceSelector from '@/components/DeviceSelector.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import ModelSelector from '@/components/ModelSelector.vue'
import ProviderSelector from '@/components/ProviderSelector.vue'
import { Label } from '@/components/ui/label'
import { useAgentBackendItems } from '@/assets/js/agentBackendItems'
import { useCapabilityCatalog } from '@/assets/js/capabilityCatalog'
import { useEmbeddingModelPicker } from '@/assets/js/embeddingModelPicker'
import { contextSizeSettingSupported, isNpuDevice } from '@/lib/llmBackendChoices'
import { llmModelChoices, modelSupportsThinkingToggle } from '@/lib/llmModelChoices'
import type { AgentSettingsBinding } from '@/lib/agentSettingsBinding'
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

const { activeName: embeddingModelName, items: embeddingModelItems } = useEmbeddingModelPicker(
  () => textInference.llmEmbeddingModels,
  () => textInference.embeddingBackend,
  () => props.template.embeddingModel,
)

onMounted(async () => {
  await refreshCapabilityCatalog()
})

const binding: AgentSettingsBinding = reactive({
  backend,
  backendItems,
  setBackend: changeBackend,
  currentModel,
  contextSizeSupported,
  contextSize: computed(
    () => props.template.contextSize ?? agentMode.activeAgentPreset?.contextSize ?? 8192,
  ),
  setContextSize: (contextSize: number) =>
    agentTasks.editTemplate({ contextSize, contextSizeEdited: true }),
  thinkingToggleSupported: supportsThinkingToggle,
  thinkingEnabled,
  setThinkingEnabled: (enabled: boolean) => agentTasks.editTemplate({ thinkingEnabled: enabled }),
  planningThinkingOnly,
  setPlanningThinkingOnly: (enabled: boolean) =>
    agentTasks.editTemplate({ planningThinkingOnly: enabled }),
  capabilities,
  setCapabilities: (ids: string[]) => agentTasks.editTemplate({ capabilities: ids }),
  capabilityCatalog,
  embeddingModelName,
  embeddingModelItems,
  setEmbeddingModel: (embeddingModel: string) => agentTasks.editTemplate({ embeddingModel }),
  mediaTools,
  problems: computed(() => agentTasks.editProblems),
  sharedWithChat: false,
})
</script>
