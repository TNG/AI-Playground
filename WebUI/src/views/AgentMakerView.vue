<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAgentMaker } from '@/assets/js/store/agentMaker'
import { useTextInference } from '@/assets/js/store/textInference'
import { useI18N } from '@/assets/js/store/i18n'
import { useErrors } from '@/assets/js/store/errors'
import { buildSamplingParams, type InferenceForTurn } from '@/assets/js/store/agentModeTurn'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { openAiApiBase } from '@/lib/inferenceApiBase'
import type { AgentTask } from '@/types/agentMakerIpc'
import type { AgentModeModelConfig } from '@/types/agentIpc'
import { DEFAULT_CAPABILITY_IDS } from '@/types/agentCapabilities'

const agentMaker = useAgentMaker()
const textInference = useTextInference()
const cloudMode = useCloudMode()
const errors = useErrors()
const { state: i18nState } = useI18N()

type View = 'list' | 'form' | 'runs'
const view = ref<View>('list')
const editingTask = ref<AgentTask | null>(null)
const selectedTaskId = ref<string | null>(null)

// Form state
const formName = ref('')
const formSteps = ref<string[]>([''])
const formInstructions = ref('')
const formCapabilities = ref<string[]>([...DEFAULT_CAPABILITY_IDS])
const formUnsandboxed = ref(false)
const formContextSize = ref<number | undefined>(undefined)
const formMaxNewTokens = ref<number | undefined>(undefined)
const saving = ref(false)

onMounted(() => {
  void agentMaker.init()
})

const tasks = computed(() => [...agentMaker.tasks].sort((a, b) => b.updatedAt - a.updatedAt))

function newTask(): void {
  editingTask.value = null
  formName.value = ''
  formSteps.value = ['']
  formInstructions.value = ''
  formCapabilities.value = [...DEFAULT_CAPABILITY_IDS]
  formUnsandboxed.value = false
  formContextSize.value = undefined
  formMaxNewTokens.value = undefined
  view.value = 'form'
}

function editTask(task: AgentTask): void {
  editingTask.value = task
  formName.value = task.name
  formSteps.value = [...task.steps]
  formInstructions.value = task.instructions ?? ''
  formCapabilities.value = [...task.capabilities]
  formUnsandboxed.value = task.unsandboxed ?? false
  formContextSize.value = task.contextSize
  formMaxNewTokens.value = task.maxNewTokens
  view.value = 'form'
}

function backToList(): void {
  view.value = 'list'
  selectedTaskId.value = null
}

function viewRuns(taskId: string): void {
  selectedTaskId.value = taskId
  view.value = 'runs'
}

const selectedTask = computed(() =>
  selectedTaskId.value ? agentMaker.findTask(selectedTaskId.value) : null,
)

const selectedTaskRuns = computed(() =>
  selectedTaskId.value ? agentMaker.taskRuns(selectedTaskId.value) : [],
)

function addStep(): void {
  formSteps.value.push('')
}

function toggleCapability(id: string): void {
  formCapabilities.value = formCapabilities.value.includes(id)
    ? formCapabilities.value.filter((c) => c !== id)
    : [...formCapabilities.value, id]
}

function removeStep(index: number): void {
  formSteps.value.splice(index, 1)
  if (formSteps.value.length === 0) formSteps.value.push('')
}

async function saveForm(): Promise<void> {
  if (saving.value) return
  const name = formName.value.trim()
  if (!name) {
    errors.report(new Error('Task name is required'), {
      category: 'validation',
      code: 'agent-maker/empty-name',
      userMessage: 'Task name is required.',
      surface: 'toast',
    })
    return
  }
  const steps = formSteps.value.map((s) => s.trim()).filter((s) => s.length > 0)
  if (steps.length === 0) {
    errors.report(new Error('At least one step is required'), {
      category: 'validation',
      code: 'agent-maker/empty-steps',
      userMessage: 'At least one step is required.',
      surface: 'toast',
    })
    return
  }

  // Freeze the current model config from textInference.
  saving.value = true
  try {
    const modelConfig = await captureModelConfig()
    if (!modelConfig) return

    const now = Date.now()
    const task: AgentTask = {
      schemaVersion: 1,
      id: editingTask.value?.id ?? `aipg-task-${crypto.randomUUID()}`,
      name,
      slug: '', // main side generates from name and ensures uniqueness
      steps,
      modelConfig,
      capabilities: [...formCapabilities.value],
      instructions: formInstructions.value.trim() || undefined,
      contextSize: formContextSize.value,
      maxNewTokens: formMaxNewTokens.value,
      unsandboxed: formUnsandboxed.value || undefined,
      llamaCppArgs:
        textInference.backend === 'llamaCPP'
          ? (textInference.llmModels.find((m) => m.type === 'llamaCPP' && m.active)?.llamaCppArgs ??
            undefined)
          : undefined,
      modelRepoId:
        textInference.backend === 'cloud' ? undefined : (textInference.activeModel ?? undefined),
      presetName: 'Agent',
      createdAt: editingTask.value?.createdAt ?? now,
      updatedAt: now,
    }
    await agentMaker.saveTask(task)
    view.value = 'list'
  } catch (error) {
    errors.report(error, {
      category: 'unknown',
      code: 'agent-maker/save-failed',
      userMessage: 'Could not save the task.',
      surface: 'toast',
    })
  } finally {
    saving.value = false
  }
}

async function deleteTask(taskId: string): Promise<void> {
  await agentMaker.deleteTask(taskId)
  if (selectedTaskId.value === taskId) {
    selectedTaskId.value = null
    view.value = 'list'
  }
}

async function runTask(taskId: string): Promise<void> {
  await agentMaker.startRun(taskId)
}

async function openRun(sessionId: string): Promise<void> {
  await agentMaker.openRun(sessionId)
}

/**
 * Capture the current model config from textInference/cloudMode, the same way
 * buildTurnConfig does — but frozen as an AgentModeModelConfig on the task.
 */
async function captureModelConfig(): Promise<AgentModeModelConfig | null> {
  if (textInference.backend === 'cloud') {
    const upstreamBaseUrl = cloudMode.activeProviderBaseUrl
    if (!upstreamBaseUrl) {
      errors.report(new Error('No cloud provider configured'), {
        category: 'validation',
        code: 'agent-maker/no-cloud-provider',
        userMessage: 'Set up a cloud provider before creating a task.',
        surface: 'toast',
      })
      return null
    }
    const proxyBaseUrl = await cloudMode.ensureProxyUrl()
    const model = textInference.activeModel ?? ''
    return {
      source: 'cloud',
      model,
      proxyBaseUrl,
      upstreamBaseUrl,
      providerId: cloudMode.selectedProviderId,
      authStyle: cloudMode.activeProviderAuthStyle,
      supportsVision: textInference.modelSupportsVision,
      reasoningAdvertised: cloudMode.capabilitiesFor(model).reasoningAdvertised,
      contextWindow: textInference.maxContextSizeFromModel
        ? textInference.effectiveContextWindow
        : undefined,
    }
  }
  const baseUrl = textInference.localBackendUrl
  if (!baseUrl) {
    errors.report(new Error('No local backend available'), {
      category: 'validation',
      code: 'agent-maker/no-backend',
      userMessage: 'Select a local backend and model in Agent Settings first.',
      surface: 'toast',
    })
    return null
  }
  const activeModel = textInference.activeModel
  if (!activeModel) {
    errors.report(new Error('No model selected'), {
      category: 'validation',
      code: 'agent-maker/no-model',
      userMessage: 'Select a model in Agent Settings first.',
      surface: 'toast',
    })
    return null
  }
  const servedModelId = activeModel.split('/').join('---')
  return {
    source: 'local',
    model: servedModelId,
    backend: textInference.backend as 'llamaCPP' | 'openVINO',
    device: textInference.getCurrentDeviceId() ?? undefined,
    deviceName: textInference.getCurrentDeviceName() ?? undefined,
    baseUrl: openAiApiBase(baseUrl),
    contextWindow: textInference.effectiveContextWindow,
    supportsVision: textInference.modelSupportsVision,
    samplingParams: buildSamplingParams(textInference as unknown as InferenceForTurn),
  }
}

const currentModelLabel = computed(() => {
  if (textInference.backend === 'cloud') {
    return textInference.activeModel ?? 'Cloud model'
  }
  return textInference.activeModel ?? 'No model selected'
})
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-foreground/10 px-6 py-4">
      <h2 class="text-lg font-semibold">{{ i18nState.AGENT_MAKER_TITLE }}</h2>
      <div class="flex gap-2">
        <button
          v-if="view !== 'list'"
          class="rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5"
          @click="backToList"
        >
          {{ i18nState.AGENT_MAKER_BACK }}
        </button>
        <button
          v-if="view === 'list'"
          class="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
          @click="newTask"
        >
          {{ i18nState.AGENT_MAKER_NEW_TASK }}
        </button>
      </div>
    </div>

    <!-- Task list -->
    <div v-if="view === 'list'" class="flex-1 overflow-y-auto px-6 py-4">
      <p v-if="tasks.length === 0" class="text-foreground/50 text-sm">
        {{ i18nState.AGENT_MAKER_EMPTY }}
      </p>
      <div v-else class="flex flex-col gap-2">
        <div
          v-for="task in tasks"
          :key="task.id"
          class="flex items-center justify-between rounded-lg border border-foreground/10 p-4"
        >
          <div class="min-w-0 flex-1">
            <div class="font-medium">{{ task.name }}</div>
            <div class="text-foreground/50 text-xs">
              {{ task.steps.length }} {{ task.steps.length === 1 ? 'step' : 'steps' }} ·
              {{ task.modelConfig.model.split('/').pop() ?? task.modelConfig.model }}
            </div>
          </div>
          <div class="flex shrink-0 gap-2">
            <button
              class="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
              @click="runTask(task.id)"
            >
              {{ i18nState.AGENT_MAKER_RUN }}
            </button>
            <button
              class="rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5"
              @click="viewRuns(task.id)"
            >
              {{ i18nState.AGENT_MAKER_HISTORY }}
            </button>
            <button
              class="rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5"
              @click="editTask(task)"
            >
              {{ i18nState.AGENT_MAKER_EDIT }}
            </button>
            <button
              class="rounded-md px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
              @click="deleteTask(task.id)"
            >
              {{ i18nState.AGENT_MAKER_DELETE }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Create / edit form -->
    <div v-else-if="view === 'form'" class="flex-1 overflow-y-auto px-6 py-4">
      <div class="flex flex-col gap-4">
        <div>
          <label class="mb-1 block text-sm font-medium">{{
            i18nState.AGENT_MAKER_TASK_NAME
          }}</label>
          <input
            v-model="formName"
            class="w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm"
            :placeholder="i18nState.AGENT_MAKER_TASK_NAME_PLACEHOLDER"
          />
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium">{{ i18nState.AGENT_MAKER_MODEL }}</label>
          <p class="text-foreground/50 text-xs">{{ currentModelLabel }}</p>
          <p class="text-foreground/40 text-xs">{{ i18nState.AGENT_MAKER_MODEL_HINT }}</p>
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium">{{ i18nState.AGENT_MAKER_STEPS }}</label>
          <div class="flex flex-col gap-2">
            <div v-for="(_, index) in formSteps" :key="index" class="flex items-start gap-2">
              <span class="mt-2 text-xs text-foreground/40">{{ index + 1 }}.</span>
              <textarea
                v-model="formSteps[index]"
                class="min-h-[2.5rem] flex-1 resize-y rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm"
                :placeholder="i18nState.AGENT_MAKER_STEP_PLACEHOLDER"
              />
              <button
                v-if="formSteps.length > 1"
                class="mt-1 rounded-md px-2 py-1 text-sm text-destructive hover:bg-destructive/10"
                @click="removeStep(index)"
              >
                ✕
              </button>
            </div>
          </div>
          <button
            class="mt-2 rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5"
            @click="addStep"
          >
            + {{ i18nState.AGENT_MAKER_ADD_STEP }}
          </button>
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium">{{
            i18nState.AGENT_MAKER_INSTRUCTIONS
          }}</label>
          <textarea
            v-model="formInstructions"
            class="min-h-[4rem] w-full resize-y rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm"
            :placeholder="i18nState.AGENT_MAKER_INSTRUCTIONS_PLACEHOLDER"
          />
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium">{{
            i18nState.AGENT_MAKER_CAPABILITIES
          }}</label>
          <div class="flex flex-col gap-1">
            <label
              v-for="cap in [
                { id: 'media', label: 'Media (image/video generation)' },
                { id: 'web-debug', label: 'Web Debug (browser inspection)' },
              ]"
              :key="cap.id"
              class="flex items-center gap-2 text-sm"
            >
              <input
                :checked="formCapabilities.includes(cap.id)"
                type="checkbox"
                @change="toggleCapability(cap.id)"
              />
              {{ cap.label }}
            </label>
          </div>
        </div>

        <div class="flex gap-3">
          <button
            class="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            :disabled="saving"
            @click="saveForm"
          >
            {{ i18nState.AGENT_MAKER_SAVE }}
          </button>
          <button class="rounded-md px-4 py-2 text-sm hover:bg-foreground/5" @click="view = 'list'">
            {{ i18nState.AGENT_MAKER_CANCEL }}
          </button>
        </div>
      </div>
    </div>

    <!-- Run history -->
    <div v-else-if="view === 'runs'" class="flex-1 overflow-y-auto px-6 py-4">
      <div v-if="!selectedTask" class="text-foreground/50 text-sm">
        {{ i18nState.AGENT_MAKER_TASK_NOT_FOUND }}
      </div>
      <div v-else>
        <h3 class="mb-3 text-base font-medium">{{ selectedTask.name }}</h3>
        <p v-if="selectedTaskRuns.length === 0" class="text-foreground/50 text-sm">
          {{ i18nState.AGENT_MAKER_NO_RUNS }}
        </p>
        <div v-else class="flex flex-col gap-2">
          <div
            v-for="run in selectedTaskRuns"
            :key="run.id"
            class="flex items-center justify-between rounded-lg border border-foreground/10 p-3"
          >
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium">
                <span
                  :class="{
                    'text-green-500': run.taskRunStatus === 'completed',
                    'text-red-500': run.taskRunStatus === 'failed',
                    'text-blue-500': run.taskRunStatus === 'running',
                  }"
                >
                  {{ run.taskRunStatus ?? 'interacted' }}
                </span>
                · {{ new Date(run.updatedAt).toLocaleString() }}
              </div>
              <div v-if="run.taskRunError" class="text-foreground/50 text-xs">
                {{ run.taskRunError }}
              </div>
            </div>
            <button
              class="shrink-0 rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5"
              @click="openRun(run.id)"
            >
              {{ i18nState.AGENT_MAKER_OPEN }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
