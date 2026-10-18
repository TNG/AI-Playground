<template>
  <TooltipProvider :delay-duration="200">
    <SettingsPanel :title="i18n.AGENT_AGENTS_TITLE" switch-id="agent-agents">
      <p class="text-xs text-muted-foreground">{{ i18n.AGENT_AGENTS_HINT }}</p>

      <ul class="flex flex-col gap-1" :aria-label="i18n.AGENT_AGENTS_TITLE">
        <li
          :aria-label="loaded ? i18n.AGENT_AGENTS_NEW : i18n.AGENT_AGENTS_UNSAVED"
          :aria-current="loaded ? undefined : 'true'"
          class="flex flex-col gap-2 rounded-sm px-2 py-1.5"
          :class="loaded ? 'hover:bg-muted/60' : 'bg-primary/15'"
        >
          <button
            type="button"
            class="flex flex-col min-w-0 text-left disabled:cursor-default"
            :aria-pressed="!loaded"
            :disabled="!loaded || agentMode.processing"
            @click="selectUnsaved"
          >
            <span class="text-sm text-foreground truncate">
              {{ loaded ? i18n.AGENT_AGENTS_NEW : i18n.AGENT_AGENTS_UNSAVED }}
            </span>
            <span class="text-xs text-muted-foreground">
              {{ loaded ? i18n.AGENT_AGENTS_NEW_HINT : stepCount(agentMode.openSteps.length) }}
            </span>
          </button>
          <AgentNameField
            v-if="!loaded"
            v-model="newName"
            id-prefix="agent-agents-new"
            :label="i18n.AGENT_AGENTS_NAME"
            :placeholder="i18n.AGENT_AGENTS_NAME_PLACEHOLDER"
            :submit-label="i18n.AGENT_AGENTS_SAVE"
            :blocker="blockerTextFor(newName)"
            :busy="saving"
            @submit="requestSave({ kind: 'new', name: newName })"
          />
        </li>

        <li
          v-for="row in rows"
          :key="row.id"
          :aria-label="row.name"
          :aria-current="row.loaded ? 'true' : undefined"
          class="flex flex-col gap-2 rounded-sm px-2 py-1.5"
          :class="row.loaded ? 'bg-primary/15' : 'hover:bg-muted/60'"
        >
          <div class="flex items-center justify-between gap-2">
            <AgentNameField
              v-if="renamingId === row.id"
              v-model="renameValue"
              :id-prefix="`agent-agents-rename-${row.id}`"
              :label="row.renameLabel"
              :submit-label="i18n.AGENT_AGENTS_RENAME_SAVE"
              :cancel-label="i18n.AGENT_AGENTS_CANCEL"
              :blocker="renameValue.trim() ? '' : i18n.AGENT_TASK_BLOCKED_NAME"
              :busy="saving"
              autofocus
              class="flex-1"
              @submit="rename(row.id)"
              @cancel="renamingId = null"
            />
            <button
              v-else
              type="button"
              class="flex flex-col min-w-0 flex-1 text-left disabled:cursor-default"
              :aria-pressed="row.loaded"
              :aria-label="row.selectLabel"
              :disabled="row.loaded || agentMode.processing"
              @click="select(row.id)"
            >
              <span class="flex items-center gap-1.5 min-w-0">
                <span
                  class="w-2.5 h-2.5 flex-none rounded-full"
                  :class="row.running ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/40'"
                />
                <span class="text-sm text-foreground truncate">{{ row.name }}</span>
                <Tooltip v-if="row.problem">
                  <TooltipTrigger as-child>
                    <ExclamationTriangleIcon
                      role="img"
                      :aria-label="row.problem"
                      class="size-4 flex-none text-amber-500"
                    />
                  </TooltipTrigger>
                  <TooltipContent class="max-w-xs">{{ row.problem }}</TooltipContent>
                </Tooltip>
              </span>
              <span class="text-xs text-muted-foreground">{{ row.meta }}</span>
              <span v-if="row.progress" class="text-xs text-primary">{{ row.progress }}</span>
              <span
                v-else-if="row.outcome"
                class="text-xs break-words"
                :class="row.outcome.failed ? 'text-destructive' : 'text-muted-foreground'"
              >
                {{ row.outcome.label }}
              </span>
            </button>

            <div v-if="renamingId !== row.id" class="flex flex-none items-center">
              <AgentRowAction
                v-if="row.running"
                :label="row.stopLabel"
                :tooltip="i18n.AGENT_AGENTS_STOP"
                @click="agentTasks.stopTask(row.id)"
              >
                <StopIcon class="size-4" />
              </AgentRowAction>
              <AgentRowAction
                v-else
                :label="row.runLabel"
                :tooltip="i18n.AGENT_AGENTS_RUN_NOW"
                @click="runNow(row.id)"
              >
                <PlayIcon class="size-4" />
              </AgentRowAction>
              <AgentRowAction
                :label="row.scheduleLabel"
                :tooltip="row.scheduleTip"
                :active="row.scheduled"
                @click="openSchedule(row.id)"
              >
                <ClockSolidIcon v-if="row.scheduled" class="size-4" />
                <ClockIcon v-else class="size-4" />
              </AgentRowAction>
              <AgentRowAction
                :label="row.sessionsLabel"
                :tooltip="i18n.AGENT_AGENTS_SHOW_SESSIONS"
                @click="history.showTaskSessions(row.id)"
              >
                <QueueListIcon class="size-4" />
              </AgentRowAction>
              <AgentRowAction
                :label="row.renameLabel"
                :tooltip="i18n.AGENT_AGENTS_RENAME"
                @click="startRename(row.id, row.name)"
              >
                <PencilIcon class="size-4" />
              </AgentRowAction>
              <AgentRowAction
                :label="row.deleteLabel"
                :tooltip="i18n.AGENT_AGENTS_DELETE"
                :disabled="row.running"
                @click="confirmDeleteId = row.id"
              >
                <TrashIcon class="size-4" />
              </AgentRowAction>
            </div>
          </div>

          <div
            v-if="confirmDeleteId === row.id"
            role="group"
            :aria-label="row.deleteLabel"
            class="flex items-center justify-between gap-2"
          >
            <span class="text-xs text-foreground">{{ row.deleteQuestion }}</span>
            <div class="flex flex-none gap-1">
              <Button variant="secondary" size="sm" class="h-7" @click="confirmDeleteId = null">
                {{ i18n.AGENT_AGENTS_CANCEL }}
              </Button>
              <Button variant="destructive" size="sm" class="h-7" @click="remove(row.id)">
                {{ i18n.AGENT_AGENTS_DELETE }}
              </Button>
            </div>
          </div>

          <button
            v-if="row.sessionId"
            type="button"
            class="self-start text-xs text-primary underline-offset-2 hover:underline"
            @click="agentMode.openSession(row.sessionId)"
          >
            {{ i18n.AGENT_AGENTS_OPEN_RUN }}
          </button>

          <div
            v-if="row.loaded && changed"
            role="group"
            :aria-label="i18n.AGENT_AGENTS_CHANGED"
            class="flex flex-col gap-2 border-t border-primary/20 pt-2"
          >
            <AgentNameField
              v-if="savingAsNew"
              v-model="copyName"
              id-prefix="agent-agents-copy"
              :label="i18n.AGENT_AGENTS_NAME"
              :submit-label="i18n.AGENT_AGENTS_SAVE"
              :cancel-label="i18n.AGENT_AGENTS_CANCEL"
              :blocker="blockerTextFor(copyName)"
              :busy="saving"
              autofocus
              @submit="requestSave({ kind: 'new', name: copyName })"
              @cancel="savingAsNew = false"
            />
            <div v-else class="flex items-center justify-between gap-2">
              <span class="text-xs text-foreground">{{ i18n.AGENT_AGENTS_CHANGED }}</span>
              <div class="flex flex-none gap-1">
                <Button
                  size="sm"
                  class="h-7"
                  :disabled="!!blockerTextFor(row.name) || saving"
                  @click="requestSave({ kind: 'update', name: row.name })"
                >
                  {{ i18n.AGENT_AGENTS_UPDATE }}
                </Button>
                <Button variant="secondary" size="sm" class="h-7" @click="startSaveAsNew(row.name)">
                  {{ i18n.AGENT_AGENTS_SAVE_AS_NEW }}
                </Button>
              </div>
            </div>
            <p
              v-if="!savingAsNew && blockerTextFor(row.name)"
              class="text-xs text-muted-foreground"
            >
              {{ blockerTextFor(row.name) }}
            </p>
          </div>
        </li>
      </ul>
      <p v-if="rows.length === 0" class="text-sm text-muted-foreground text-center py-1">
        {{ i18n.AGENT_AGENTS_EMPTY }}
      </p>

      <TaskModelWarnings v-if="!loaded || changed" :state="modelWarnings" />
    </SettingsPanel>
  </TooltipProvider>

  <TaskScheduleDialog v-model:open="scheduleOpen" :task-id="scheduleTaskId" />
  <TaskModelSaveConfirm
    v-model:open="confirmModelsOpen"
    :state="modelWarnings"
    @confirm="save(pendingSave)"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  ClockIcon,
  ExclamationTriangleIcon,
  PencilIcon,
  PlayIcon,
  QueueListIcon,
  StopIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import { ClockIcon as ClockSolidIcon } from '@heroicons/vue/24/solid'
import type { AgentTaskOutcome } from '@/types/agentTaskIpc'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { SAVE_TASK_BLOCKER_KEYS, useAgentTasks } from '@/assets/js/store/agentTasks'
import { useErrors } from '@/assets/js/store/errors'
import { useHistorySessions } from '@/assets/js/store/historySessions'
import { useI18N } from '@/assets/js/store/i18n'
import AgentNameField from '@/components/AgentNameField.vue'
import AgentRowAction from '@/components/AgentRowAction.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import TaskModelSaveConfirm from '@/components/TaskModelSaveConfirm.vue'
import TaskModelWarnings from '@/components/TaskModelWarnings.vue'
import TaskScheduleDialog from '@/components/TaskScheduleDialog.vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTaskModelWarnings } from '@/assets/js/taskModelWarnings'
import { createAppError } from '@/assets/js/errors/appError'
import { describeSettingsProblems } from '@/lib/sessionSettingsProblems'
import { describeNextRun } from '@/lib/taskSchedule'
import * as toast from '@/assets/js/toast'

const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const errors = useErrors()
const history = useHistorySessions()
const i18nStore = useI18N()
const i18n = i18nStore.state

onMounted(() => void agentTasks.loadProblemSources())

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (token, key) =>
    key in values ? String(values[key]) : token,
  )
}

function stepCount(count: number): string {
  return fill(i18n.AGENT_TASKS_STEP_COUNT, { count })
}

const loaded = computed(() => agentTasks.openSessionTask)
const changed = computed(() => agentTasks.openSessionAgentChanged)

const newName = ref('')
const copyName = ref('')
const savingAsNew = ref(false)
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const confirmDeleteId = ref<string | null>(null)

watch(
  () => loaded.value?.id,
  () => {
    savingAsNew.value = false
  },
)

const rows = computed(() =>
  agentTasks.tasks.map((task) => {
    const state = agentTasks.taskState(task.id)
    const run = 'running' in state ? state.running : undefined
    const outcome = 'idle' in state ? state.idle : undefined
    const reasons = describeSettingsProblems(agentTasks.taskProblems(task.id), i18n)
    const schedule = scheduleOf(task.id)
    const label = { name: task.name }
    return {
      id: task.id,
      name: task.name,
      loaded: loaded.value?.id === task.id,
      meta: [stepCount(task.steps.length), schedule.line].filter(Boolean).join(' · '),
      running: run !== undefined,
      sessionId: run?.sessionId,
      progress:
        run && fill(i18n.AGENT_TASKS_RUNNING_STEP, { step: run.stepIndex, count: run.stepCount }),
      outcome: outcome && {
        label: [outcomeLabel(outcome), outcome.kind === 'failed' ? outcomeMessage(outcome) : '']
          .filter(Boolean)
          .join(': '),
        failed: outcome.kind === 'failed',
      },
      problem: reasons ? fill(i18n.AGENT_TASKS_PROBLEM, { reason: reasons }) : undefined,
      scheduled: schedule.enabled,
      scheduleTip: schedule.line ?? i18n.AGENT_AGENTS_NOT_SCHEDULED,
      selectLabel: fill(i18n.AGENT_AGENTS_SELECT_LABEL, label),
      stopLabel: fill(i18n.AGENT_TASKS_STOP, label),
      runLabel: fill(i18n.AGENT_AGENTS_RUN_LABEL, label),
      scheduleLabel: fill(i18n.AGENT_AGENTS_SCHEDULE_LABEL, label),
      sessionsLabel: fill(i18n.AGENT_AGENTS_SESSIONS_LABEL, label),
      renameLabel: fill(i18n.AGENT_AGENTS_RENAME_LABEL, label),
      deleteLabel: fill(i18n.AGENT_AGENTS_DELETE_LABEL, label),
      deleteQuestion: fill(i18n.AGENT_AGENTS_DELETE_CONFIRM, label),
    }
  }),
)

function scheduleOf(id: string): { enabled: boolean; line?: string } {
  const { schedule, nextRunAt } = agentTasks.taskSchedule(id)
  if (!schedule) return { enabled: false }
  if (!schedule.enabled) return { enabled: false, line: i18n.AGENT_TASKS_SCHEDULE_PAUSED }
  if (nextRunAt === undefined) return { enabled: true }
  const time = describeNextRun(nextRunAt, Date.now(), i18nStore.langName, {
    today: i18n.AGENT_TASKS_NEXT_RUN_TODAY,
    tomorrow: i18n.AGENT_TASKS_NEXT_RUN_TOMORROW,
  })
  return { enabled: true, line: fill(i18n.AGENT_TASKS_NEXT_RUN, { time }) }
}

function outcomeLabel({ kind, stepIndex, stepCount, reason }: AgentTaskOutcome): string {
  const step = { step: stepIndex ?? '', count: stepCount }
  switch (kind) {
    case 'completed':
      return i18n.AGENT_TASKS_OUTCOME_COMPLETED
    case 'failed':
      if (reason === 'not-started') return i18n.AGENT_TASKS_OUTCOME_NOT_STARTED
      return stepIndex
        ? fill(i18n.AGENT_TASKS_OUTCOME_FAILED_AT_STEP, step)
        : i18n.AGENT_TASKS_OUTCOME_FAILED
    case 'stopped':
      return stepIndex
        ? fill(i18n.AGENT_TASKS_OUTCOME_STOPPED_AT_STEP, step)
        : i18n.AGENT_TASKS_OUTCOME_STOPPED
  }
}

function outcomeMessage({ message, reason }: AgentTaskOutcome): string | undefined {
  if (reason === 'app-closed') return i18n.AGENT_TASKS_OUTCOME_APP_CLOSED
  if (reason === 'download-declined') return i18n.AGENT_TASKS_OUTCOME_DOWNLOAD_DECLINED
  return message
}

function resetInlineEdits(): void {
  renamingId.value = null
  confirmDeleteId.value = null
  savingAsNew.value = false
}

async function select(id: string): Promise<void> {
  resetInlineEdits()
  await agentTasks.loadAgent(id)
}

async function selectUnsaved(): Promise<void> {
  resetInlineEdits()
  await agentMode.newSession()
}

function startRename(id: string, name: string): void {
  resetInlineEdits()
  renamingId.value = id
  renameValue.value = name
}

async function rename(id: string): Promise<void> {
  saving.value = true
  try {
    if ((await agentTasks.renameAgent(id, renameValue.value)).ok) renamingId.value = null
  } finally {
    saving.value = false
  }
}

async function remove(id: string): Promise<void> {
  confirmDeleteId.value = null
  await agentTasks.deleteTask(id)
}

function startSaveAsNew(name: string): void {
  copyName.value = fill(i18n.AGENT_AGENTS_COPY_NAME, { name })
  savingAsNew.value = true
}

const scheduleOpen = ref(false)
const scheduleTaskId = ref<string | null>(null)

function openSchedule(id: string): void {
  scheduleTaskId.value = id
  scheduleOpen.value = true
}

async function runNow(id: string): Promise<void> {
  const result = await agentTasks.runTask(id)
  if (result.ok || result.reason !== 'settings-problems') return
  errors.report(
    createAppError({
      category: 'validation',
      code: 'agent-tasks/run-blocked',
      severity: 'warning',
      surface: 'toast',
      userMessage: fill(i18n.AGENT_TASKS_RUN_BLOCKED, { reason: result.message }),
    }),
  )
}

type PendingSave = { kind: 'new' | 'update'; name: string }

const saving = ref(false)
const confirmModelsOpen = ref(false)
const pendingSave = ref<PendingSave>({ kind: 'new', name: '' })

const modelWarnings = useTaskModelWarnings(() => agentMode.openSessionSettings, {
  chatModelSteps: () => agentMode.openSteps,
})

function blockerTextFor(name: string): string {
  const blocker = agentTasks.saveAgentBlocker(name)
  return blocker ? i18n[SAVE_TASK_BLOCKER_KEYS[blocker]] : ''
}

/** Missing models do not block saving, but the user confirms them before the Agent is stored. */
function requestSave(request: PendingSave): void {
  pendingSave.value = request
  if (modelWarnings.missingCount.value > 0) confirmModelsOpen.value = true
  else void save(request)
}

async function save({ kind, name }: PendingSave): Promise<void> {
  const target = loaded.value
  saving.value = true
  try {
    const result =
      kind === 'update' && target
        ? await agentTasks.updateAgent(target.id, name)
        : await agentTasks.saveAgent(name)
    if (!result.ok) return
    toast.success(fill(i18n.AGENT_AGENTS_SAVED, { name: result.task.name }))
    if (kind === 'new') newName.value = ''
    savingAsNew.value = false
  } finally {
    saving.value = false
  }
}
</script>
