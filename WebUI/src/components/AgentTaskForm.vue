<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useAgentMaker } from '@/assets/js/store/agentMaker'
import { useAgentMode } from '@/assets/js/store/agentMode'
import {
  backendToService,
  textInferenceBackendDisplayName,
  useTextInference,
  type LlmBackend,
} from '@/assets/js/store/textInference'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useProductMode } from '@/assets/js/store/productMode'
import { useMcp } from '@/assets/js/store/mcp'
import { useI18N } from '@/assets/js/store/i18n'
import { useErrors } from '@/assets/js/store/errors'
import { getAgentToolSpecs } from '@/assets/js/tools/agentBridge'
import { useContextSizeField } from '@/assets/js/contextSizeField'
import { useEmbeddingModelPicker } from '@/assets/js/embeddingModelPicker'
import DropDownNew from '@/components/DropDownNew.vue'
import DeviceSelector from '@/components/DeviceSelector.vue'
import ModelSelector from '@/components/ModelSelector.vue'
import ProviderSelector from '@/components/ProviderSelector.vue'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { XMarkIcon } from '@heroicons/vue/24/outline'
import {
  DEFAULT_TASK_CONTEXT_SIZE,
  taskCatalogEntry,
  taskModelSupportsThinkingToggle,
} from '@/lib/agentTaskModel'
import { DEFAULT_CAPABILITY_IDS, mcpCapabilityId } from '@/types/agentCapabilities'
import type { AgentTask, AgentTaskModel } from '@/types/agentMakerIpc'
import type { AgentCapabilityInfo } from '@/types/agentIpc'

const props = defineProps<{ task: AgentTask | null }>()
const emit = defineEmits<{ saved: []; cancel: [] }>()

const agentMaker = useAgentMaker()
const agentMode = useAgentMode()
const textInference = useTextInference()
const cloudMode = useCloudMode()
const backendServices = useBackendServices()
const productMode = useProductMode()
const mcp = useMcp()
const errors = useErrors()
const { state: languages } = useI18N()

// A new task starts from the current Agent settings; from then on it is its own copy.
function initialModel(): AgentTaskModel {
  if (props.task) return { ...props.task.model }
  return {
    backend: textInference.backend,
    model: textInference.activeModel ?? '',
    providerId: textInference.backend === 'cloud' ? cloudMode.selectedProviderId : undefined,
    contextSize: textInference.contextSize,
    thinkingEnabled: textInference.thinkingEnabled,
    planningThinkingOnly: agentMode.planningThinkingOnly,
    embeddingModel: textInference.activeEmbeddingModel ?? undefined,
    embeddingBackend: textInference.embeddingBackend,
  }
}

const name = ref(props.task?.name ?? '')
const steps = ref<string[]>(props.task ? [...props.task.steps] : [''])
const instructions = ref(props.task?.instructions ?? '')
const capabilities = ref<string[]>(
  props.task ? [...props.task.capabilities] : [...DEFAULT_CAPABILITY_IDS],
)
const unsandboxed = ref(props.task?.unsandboxed ?? false)
const model = ref<AgentTaskModel>(initialModel())
const saving = ref(false)

const capabilityCatalog = ref<AgentCapabilityInfo[]>([])
const builtInCapabilities = computed(() =>
  capabilityCatalog.value.filter((capability) => !capability.id.startsWith('mcp:')),
)

// Embeddings run locally: on the task's own backend, or a local one for a cloud task.
const embeddingBackend = computed<'llamaCPP' | 'openVINO'>(() =>
  model.value.backend === 'cloud' ? textInference.embeddingBackend : model.value.backend,
)
const { items: embeddingModelItems } = useEmbeddingModelPicker(
  () => textInference.llmEmbeddingModels,
  embeddingBackend,
)
const ragAvailable = computed(() => capabilityCatalog.value.some((c) => c.id === 'rag'))
const ragEnabled = computed(() => ragAvailable.value && capabilities.value.includes('rag'))

// Keep the embedding model valid for the backend, without replacing a still-valid choice.
watch(
  [embeddingBackend, embeddingModelItems],
  ([backend, items]) => {
    const valid = items.some((item) => item.value === model.value.embeddingModel)
    if (valid && model.value.embeddingBackend === backend) return
    model.value = {
      ...model.value,
      embeddingBackend: backend,
      embeddingModel: valid ? model.value.embeddingModel : items[0]?.value,
    }
  },
  { immediate: true },
)

function setEmbeddingModel(value: string): void {
  model.value = { ...model.value, embeddingModel: value }
}

async function refreshCapabilityCatalog(): Promise<void> {
  capabilityCatalog.value = await window.electronAPI.agentMode.listCapabilities({
    toolSpecs: getAgentToolSpecs(),
    embeddingModel: model.value.embeddingModel,
  })
}

onMounted(async () => {
  void mcp.refreshAvailableServers()
  await refreshCapabilityCatalog()
})

watch(
  () => model.value.embeddingModel,
  () => void refreshCapabilityCatalog(),
)

function capabilityLabels(ids: string[]): string {
  return ids
    .map((id) => capabilityCatalog.value.find((entry) => entry.id === id)?.label ?? id)
    .join(', ')
}

// Same list as Agent Settings: the agent preset's local backends, plus Cloud Mode.
const backendItems = computed(() => {
  const local: LlmBackend[] =
    productMode.productMode === 'nvidia' ? ['llamaCPP'] : ['llamaCPP', 'openVINO']
  const backends: LlmBackend[] = cloudMode.isFeatureEnabled ? [...local, 'cloud'] : local
  return backends.map((backend) => ({
    label: textInferenceBackendDisplayName[backend] ?? backend,
    value: backend,
    active: isBackendRunning(backend),
  }))
})

function isBackendRunning(backend: LlmBackend): boolean {
  if (backend === 'cloud') return true
  const serviceName = backendToService[backend]
  return backendServices.info.find((s) => s.serviceName === serviceName)?.status === 'running'
}

const deviceServiceName = computed(
  () => backendToService[model.value.backend] ?? 'llamacpp-backend',
)

const localCatalog = computed(() => textInference.llmModels.filter((m) => m.type !== 'cloud'))
const catalogEntry = computed(() => taskCatalogEntry(model.value, localCatalog.value))
const capabilityModel = computed(() =>
  model.value.backend === 'cloud'
    ? cloudMode.providers.find((p) => p.id === model.value.providerId)?.modelCapabilities?.[
        model.value.model
      ]
    : catalogEntry.value,
)

const onNpu = computed(
  () =>
    model.value.backend === 'openVINO' &&
    !!backendServices.info
      .find((s) => s.serviceName === 'openvino-backend')
      ?.devices.find((d) => d.selected)
      ?.id.includes('NPU'),
)
const contextSizeEditable = computed(
  () => model.value.backend === 'llamaCPP' || (model.value.backend === 'openVINO' && onNpu.value),
)
const contextSize = computed({
  get: () => model.value.contextSize ?? DEFAULT_TASK_CONTEXT_SIZE,
  set: (value: number) => {
    const ceiling = catalogEntry.value?.maxContextSize
    model.value = { ...model.value, contextSize: ceiling ? Math.min(value, ceiling) : value }
  },
})
const contextSizeField = useContextSizeField(contextSize)

const showsThinking = computed(() =>
  taskModelSupportsThinkingToggle(model.value, localCatalog.value),
)
const thinkingEnabled = computed(() => model.value.thinkingEnabled ?? true)
const planningThinkingOnly = computed(() => model.value.planningThinkingOnly ?? true)

function setBackend(backend: string): void {
  const next = backend as LlmBackend
  model.value = {
    ...model.value,
    backend: next,
    model: '',
    providerId:
      next === 'cloud' ? (model.value.providerId ?? cloudMode.selectedProviderId) : undefined,
  }
}

function setProvider(providerId: string): void {
  model.value = { ...model.value, providerId, model: '' }
}

function setModel(value: string): void {
  model.value = { ...model.value, model: value }
}

function toggleCapability(id: string, event: Event): void {
  const checked = (event.target as HTMLInputElement).checked
  capabilities.value = checked
    ? [...new Set([...capabilities.value, id])]
    : capabilities.value.filter((c) => c !== id)
}

function removeStep(index: number): void {
  steps.value.splice(index, 1)
  if (steps.value.length === 0) steps.value.push('')
}

function invalid(message: string, code: string): void {
  errors.report(new Error(message), {
    category: 'validation',
    code: `agent-maker/${code}`,
    userMessage: message,
    surface: 'toast',
  })
}

async function save(): Promise<void> {
  if (saving.value) return
  const trimmedName = name.value.trim()
  const trimmedSteps = steps.value.map((s) => s.trim()).filter((s) => s.length > 0)
  if (!trimmedName) return invalid('Task name is required.', 'empty-name')
  if (trimmedSteps.length === 0) return invalid('At least one step is required.', 'empty-steps')
  if (!model.value.model) return invalid('Select a model for the task.', 'no-model')
  const cloud = model.value.backend === 'cloud'
  if (cloud && !model.value.providerId) {
    return invalid('Select a cloud provider for the task.', 'no-provider')
  }

  const now = Date.now()
  const task: AgentTask = {
    schemaVersion: 2,
    id: props.task?.id ?? `aipg-task-${crypto.randomUUID()}`,
    name: trimmedName,
    slug: props.task?.slug ?? '',
    steps: trimmedSteps,
    model: {
      backend: model.value.backend,
      model: model.value.model,
      providerId: cloud ? model.value.providerId : undefined,
      contextSize: cloud ? undefined : contextSize.value,
      thinkingEnabled: showsThinking.value ? thinkingEnabled.value : undefined,
      planningThinkingOnly: showsThinking.value ? planningThinkingOnly.value : undefined,
      embeddingModel: model.value.embeddingModel,
      embeddingBackend: model.value.embeddingModel ? embeddingBackend.value : undefined,
    },
    capabilities: [...capabilities.value],
    instructions: instructions.value.trim() || undefined,
    unsandboxed: unsandboxed.value || undefined,
    createdAt: props.task?.createdAt ?? now,
    updatedAt: now,
  }
  saving.value = true
  try {
    if (await agentMaker.saveTask(task)) emit('saved')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <form class="flex max-w-3xl flex-col gap-6 p-1" @submit.prevent="save">
    <div class="flex flex-col gap-2">
      <Label for="agent-task-name" class="whitespace-nowrap">
        {{ languages.AGENT_MAKER_TASK_NAME }}
      </Label>
      <input
        id="agent-task-name"
        v-model="name"
        class="h-[30px] w-full rounded-md border border-border bg-card px-3 text-sm text-foreground"
        :placeholder="languages.AGENT_MAKER_TASK_NAME_PLACEHOLDER"
      />
    </div>

    <!-- Model settings: same controls as Agent Settings, bound to the task. -->
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">{{ languages.AGENT_MAKER_BACKEND }}</Label>
      <DropDownNew
        title="Select Backend"
        :value="model.backend"
        :items="backendItems"
        @change="setBackend"
      />
    </div>
    <div v-if="model.backend === 'cloud'" class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">{{ languages.AGENT_MAKER_PROVIDER }}</Label>
      <ProviderSelector :model-value="model.providerId ?? ''" @update:model-value="setProvider" />
    </div>
    <div v-else class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">{{ languages.DEVICE }}</Label>
      <DeviceSelector :backend="deviceServiceName" />
    </div>
    <div
      role="group"
      :aria-label="languages.MODEL"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
    >
      <Label class="whitespace-nowrap">{{ languages.MODEL }}</Label>
      <div class="flex min-w-0 items-center gap-2">
        <div class="min-w-0 flex-1">
          <ModelSelector
            :key="`${model.backend}:${model.providerId ?? ''}`"
            :backend="model.backend"
            :provider-id="model.providerId"
            :model-value="model.model"
            :requirements="{ toolCalling: true }"
            @update:model-value="setModel"
          />
        </div>
        <CapabilityIcons v-if="capabilityModel" :model="capabilityModel" />
      </div>
    </div>
    <div v-if="contextSizeEditable" class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label for="agent-task-context-size" class="whitespace-nowrap">
        {{ languages.ANSWER_CONTEXT_SIZE }}
      </Label>
      <input
        id="agent-task-context-size"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        :value="contextSizeField.draft"
        class="rounded-sm text-foreground text-center h-7 w-24 leading-7 p-0 bg-transparent border border-border"
        @focus="contextSizeField.onFocus"
        @input="contextSizeField.onInput"
        @blur="contextSizeField.commit"
        @keydown.enter.prevent="contextSizeField.commit"
      />
    </div>
    <p class="text-xs text-muted-foreground">
      {{ languages.AGENT_MAKER_MODEL_HINT }}
      <template v-if="model.backend !== 'cloud'">
        {{ languages.DEVICE }}: {{ languages.AGENT_MAKER_DEVICE_HINT }}.
      </template>
    </p>

    <div v-if="showsThinking" class="flex flex-col gap-2">
      <Label class="whitespace-nowrap">{{ languages.AGENT_MAKER_THINKING }}</Label>
      <label class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          class="mt-0.5"
          :checked="thinkingEnabled"
          @change="model = { ...model, thinkingEnabled: !thinkingEnabled }"
        />
        <span class="text-foreground">{{ languages.AGENT_MAKER_THINK_BEFORE_ACTING }}</span>
      </label>
      <label class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          class="mt-0.5"
          :disabled="!thinkingEnabled"
          :checked="planningThinkingOnly"
          @change="model = { ...model, planningThinkingOnly: !planningThinkingOnly }"
        />
        <span class="text-foreground" :class="{ 'opacity-50': !thinkingEnabled }">
          {{ languages.AGENT_MAKER_PLANNING_ONLY }}
        </span>
      </label>
    </div>

    <div class="flex flex-col gap-2">
      <Label class="whitespace-nowrap">{{ languages.AGENT_MAKER_SHELL }}</Label>
      <label class="flex items-start gap-2 text-sm">
        <input v-model="unsandboxed" type="checkbox" class="mt-0.5" />
        <span class="text-foreground">{{ languages.AGENT_MAKER_UNSANDBOXED }}</span>
      </label>
      <p v-if="unsandboxed" class="text-xs text-amber-500">
        {{ languages.AGENT_MAKER_UNSANDBOXED_WARNING }}
      </p>
    </div>

    <div class="border-t border-border pt-4 flex flex-col gap-3">
      <Label class="whitespace-nowrap">{{ languages.AGENT_MAKER_STEPS }}</Label>
      <div v-for="(_, index) in steps" :key="index" class="flex items-start gap-2">
        <span class="mt-2 w-5 text-xs text-muted-foreground">{{ index + 1 }}.</span>
        <textarea
          v-model="steps[index]"
          :aria-label="`${languages.AGENT_MAKER_STEPS} ${index + 1}`"
          class="min-h-[2.5rem] flex-1 resize-y rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
          :placeholder="languages.AGENT_MAKER_STEP_PLACEHOLDER"
        />
        <button
          v-if="steps.length > 1"
          type="button"
          class="mt-1 rounded-md p-1 text-destructive hover:bg-destructive/10"
          :aria-label="languages.AGENT_MAKER_REMOVE_STEP.replace('{index}', String(index + 1))"
          @click="removeStep(index)"
        >
          <XMarkIcon class="size-4" />
        </button>
      </div>
      <Button
        type="button"
        variant="secondary"
        class="self-start px-3 py-1.5 rounded text-sm"
        @click="steps.push('')"
      >
        + {{ languages.AGENT_MAKER_ADD_STEP }}
      </Button>
    </div>

    <div class="flex flex-col gap-2">
      <Label for="agent-task-instructions" class="whitespace-nowrap">
        {{ languages.AGENT_MAKER_INSTRUCTIONS }}
      </Label>
      <textarea
        id="agent-task-instructions"
        v-model="instructions"
        class="min-h-[4rem] w-full resize-y rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
        :placeholder="languages.AGENT_MAKER_INSTRUCTIONS_PLACEHOLDER"
      />
    </div>

    <!-- Capabilities: same list and wording as Agent Settings. -->
    <div class="border-t border-border pt-4 flex flex-col gap-3">
      <Label class="whitespace-nowrap">{{ languages.AGENT_MAKER_CAPABILITIES }}</Label>
      <div class="flex flex-col gap-2">
        <label
          v-for="capability in builtInCapabilities"
          :key="capability.id"
          class="flex items-start gap-2 text-sm"
        >
          <input
            type="checkbox"
            class="mt-0.5"
            :disabled="!!capability.unavailableReason"
            :checked="capabilities.includes(capability.id)"
            @change="toggleCapability(capability.id, $event)"
          />
          <span class="flex flex-col">
            <span class="text-foreground">{{ capability.label }}</span>
            <span class="text-xs text-muted-foreground">{{ capability.summary }}</span>
            <span v-if="capability.requires.length > 0" class="text-xs text-muted-foreground">
              Also enables: {{ capabilityLabels(capability.requires) }}
            </span>
            <span v-if="capability.unavailableReason" class="text-xs text-amber-500">
              {{ capability.unavailableReason }}
            </span>
          </span>
        </label>
      </div>

      <!-- Same picker as Agent Settings, bound to the task. The model downloads on
           first actual document search, not from here. -->
      <div v-if="ragEnabled" class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">{{ languages.AGENT_MAKER_EMBEDDINGS }}</Label>
        <DropDownNew
          :title="languages.RAG_DOCUMENT_EMBEDDING_MODEL"
          :value="model.embeddingModel ?? ''"
          :items="embeddingModelItems"
          @change="setEmbeddingModel"
        />
      </div>

      <Label class="whitespace-nowrap mt-2">{{ languages.AGENT_MAKER_MCP_SERVERS }}</Label>
      <div v-if="mcp.allServers.length > 0" class="flex flex-col gap-2">
        <label
          v-for="server in mcp.allServers"
          :key="server.id"
          class="flex items-start gap-2 text-sm"
        >
          <input
            type="checkbox"
            class="mt-0.5"
            :checked="capabilities.includes(mcpCapabilityId(server.id))"
            @change="toggleCapability(mcpCapabilityId(server.id), $event)"
          />
          <span class="flex flex-col">
            <span class="text-foreground">{{ server.name }}</span>
            <span v-if="server.instructions" class="text-xs text-muted-foreground">
              {{ server.instructions }}
            </span>
          </span>
        </label>
      </div>
      <p v-else class="text-xs text-muted-foreground italic">
        No MCP servers configured. Add one under App Settings → MCP.
      </p>
    </div>

    <div class="border-t border-border pt-4 flex gap-3">
      <Button type="submit" :disabled="saving">{{ languages.AGENT_MAKER_SAVE }}</Button>
      <Button type="button" variant="secondary" @click="emit('cancel')">
        {{ languages.AGENT_MAKER_CANCEL }}
      </Button>
    </div>
  </form>
</template>
