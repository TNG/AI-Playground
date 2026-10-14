<template>
  <SideModalBase
    :is-visible="isVisible"
    :title="i18n.AGENT_TASKS_MANAGE"
    side="left"
    @close="$emit('close')"
  >
    <p v-if="agentTasks.tasks.length === 0" class="text-sm text-muted-foreground">
      {{ i18n.AGENT_TASKS_EMPTY }}
    </p>
    <TooltipProvider v-else :delay-duration="200">
      <ul class="flex flex-col gap-2">
        <li
          v-for="row in rows"
          :key="row.id"
          :aria-label="row.name"
          :aria-current="row.editing ? 'true' : undefined"
          class="flex items-center gap-3 rounded-md border px-3 py-2"
          :class="row.editing ? 'border-primary bg-primary/15' : 'border-border bg-muted/40'"
        >
          <span class="flex flex-col min-w-0 flex-1">
            <span class="flex items-center gap-1.5 min-w-0">
              <span class="text-sm text-foreground truncate">{{ row.name }}</span>
              <Tooltip v-if="row.blocked">
                <TooltipTrigger as-child>
                  <ExclamationTriangleIcon
                    role="img"
                    :aria-label="row.blocked.marker"
                    class="size-4 flex-none text-amber-500"
                  />
                </TooltipTrigger>
                <TooltipContent class="max-w-xs">{{ row.blocked.marker }}</TooltipContent>
              </Tooltip>
            </span>
            <span class="text-xs text-muted-foreground">{{ row.stepCount }}</span>
            <span v-if="row.progress" class="text-xs text-primary">{{ row.progress }}</span>
            <template v-else-if="row.outcome">
              <span
                class="text-xs"
                :class="row.outcome.failed ? 'text-destructive' : 'text-muted-foreground'"
              >
                {{ row.outcome.label }}
              </span>
              <span v-if="row.outcome.message" class="text-xs text-muted-foreground break-words">
                {{ row.outcome.message }}
              </span>
            </template>
          </span>
          <Tooltip v-if="row.sessionId">
            <TooltipTrigger as-child>
              <button
                type="button"
                class="size-7 flex-none flex items-center justify-center rounded-xs bg-muted hover:bg-primary/20"
                :aria-label="row.openLabel"
                @click="openSession(row.sessionId)"
              >
                <ArrowTopRightOnSquareIcon class="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{{ row.openLabel }}</TooltipContent>
          </Tooltip>
          <Tooltip v-if="row.running">
            <TooltipTrigger as-child>
              <button
                type="button"
                class="size-7 flex-none flex items-center justify-center rounded-xs bg-muted hover:bg-destructive/20"
                :aria-label="row.stopLabel"
                @click="agentTasks.stopTask(row.id)"
              >
                <StopIcon class="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{{ row.stopLabel }}</TooltipContent>
          </Tooltip>
          <Tooltip v-else>
            <TooltipTrigger as-child>
              <!-- aria-disabled, not disabled: a disabled button gets no hover or focus for its tooltip. -->
              <button
                type="button"
                class="size-7 flex-none flex items-center justify-center rounded-xs bg-muted hover:bg-primary/20 aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-muted"
                :aria-label="row.runLabel"
                :aria-disabled="row.blocked ? 'true' : undefined"
                :aria-describedby="row.blocked ? `task-run-blocked-${row.id}` : undefined"
                @click="row.blocked || run(row.id)"
              >
                <PlayIcon class="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent class="max-w-xs">{{ row.blocked?.run ?? row.runLabel }}</TooltipContent>
          </Tooltip>
          <span
            v-if="row.blocked && !row.running"
            :id="`task-run-blocked-${row.id}`"
            class="sr-only"
          >
            {{ row.blocked.run }}
          </span>
          <Tooltip>
            <TooltipTrigger as-child>
              <button
                type="button"
                class="size-7 flex-none flex items-center justify-center rounded-xs bg-muted hover:bg-primary/20"
                :aria-label="row.editLabel"
                :aria-pressed="row.editing"
                @click="editTask(row.id)"
              >
                <PencilSquareIcon class="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{{ row.editLabel }}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <button
                type="button"
                class="size-7 flex-none flex items-center justify-center rounded-xs bg-muted hover:bg-destructive/20 disabled:opacity-40 disabled:cursor-not-allowed"
                :aria-label="row.deleteLabel"
                :disabled="row.running || deleting.has(row.id)"
                @click="remove(row.id)"
              >
                <TrashIcon class="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{{ row.deleteLabel }}</TooltipContent>
          </Tooltip>
        </li>
      </ul>
    </TooltipProvider>
  </SideModalBase>

  <AlertDialog v-model:open="runUnsavedOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ i18n.AGENT_TASKS_RUN_UNSAVED_TITLE }}</AlertDialogTitle>
        <AlertDialogDescription>{{
          i18n.AGENT_TASKS_RUN_UNSAVED_DESCRIPTION
        }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ i18n.COM_CANCEL }}</AlertDialogCancel>
        <AlertDialogAction @click="runSaved">
          {{ i18n.AGENT_TASKS_RUN_UNSAVED_CONFIRM }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  ArrowTopRightOnSquareIcon,
  ExclamationTriangleIcon,
  PencilSquareIcon,
  PlayIcon,
  StopIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import type { AgentTaskOutcome } from '@/types/agentTaskIpc'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import SideModalBase from '@/components/SideModalBase.vue'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useTaskEditLeaveGuard } from '@/assets/js/taskEditLeaveGuard'
import { createAppError } from '@/assets/js/errors/appError'
import { describeSettingsProblems } from '@/lib/sessionSettingsProblems'

const props = defineProps<{
  isVisible: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const errors = useErrors()
const i18n = useI18N().state
const { leaveTaskEdit, editTask } = useTaskEditLeaveGuard()

watch(
  () => props.isVisible,
  (visible) => {
    if (visible) void agentTasks.loadProblemSources()
  },
  { immediate: true },
)

const deleting = reactive(new Set<string>())

function fill(template: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (result, [name, value]) => result.replace(`{${name}}`, String(value)),
    template,
  )
}

const rows = computed(() =>
  agentTasks.tasks.map((task) => {
    const state = agentTasks.taskState(task.id)
    const run = 'running' in state ? state.running : undefined
    const outcome = 'idle' in state ? state.idle : undefined
    const reasons = describeSettingsProblems(agentTasks.taskProblems(task.id), i18n)
    return {
      id: task.id,
      name: task.name,
      stepCount: fill(i18n.AGENT_TASKS_STEP_COUNT, { count: task.steps.length }),
      running: run !== undefined,
      sessionId: run?.sessionId,
      progress:
        run && fill(i18n.AGENT_TASKS_RUNNING_STEP, { step: run.stepIndex, count: run.stepCount }),
      runLabel: fill(i18n.AGENT_TASKS_RUN, { name: task.name }),
      stopLabel: fill(i18n.AGENT_TASKS_STOP, { name: task.name }),
      openLabel: fill(i18n.AGENT_TASKS_OPEN_SESSION, { name: task.name }),
      deleteLabel: fill(i18n.AGENT_TASKS_DELETE, { name: task.name }),
      editLabel: fill(i18n.AGENT_TASKS_EDIT, { name: task.name }),
      editing: agentTasks.editingTaskId === task.id,
      blocked: reasons
        ? {
            marker: fill(i18n.AGENT_TASKS_PROBLEM, { reason: reasons }),
            run: fill(i18n.AGENT_TASKS_RUN_BLOCKED, { reason: reasons }),
          }
        : undefined,
      outcome: outcome && {
        label: outcomeLabel(outcome),
        failed: outcome.kind === 'failed',
        message: outcome.kind === 'failed' ? outcomeMessage(outcome) : undefined,
      },
    }
  }),
)

function outcomeLabel({ kind, stepIndex, stepCount }: AgentTaskOutcome): string {
  const step = { step: stepIndex ?? '', count: stepCount }
  switch (kind) {
    case 'completed':
      return i18n.AGENT_TASKS_OUTCOME_COMPLETED
    case 'failed':
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
  return reason === 'app-closed' ? i18n.AGENT_TASKS_OUTCOME_APP_CLOSED : message
}

async function openSession(sessionId: string): Promise<void> {
  if (!(await leaveTaskEdit())) return
  emit('close')
  await agentMode.openSession(sessionId)
}

// Kept apart from the open state: the dialog may close before its action's click runs.
const runUnsavedOpen = ref(false)
const runUnsavedId = ref<string | null>(null)

function run(id: string): void {
  if (agentTasks.editingTaskId === id && agentTasks.editDirty) {
    runUnsavedId.value = id
    runUnsavedOpen.value = true
  } else {
    void runSavedTask(id)
  }
}

function runSaved(): void {
  if (runUnsavedId.value) void runSavedTask(runUnsavedId.value)
  runUnsavedId.value = null
}

async function runSavedTask(id: string): Promise<void> {
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

async function remove(id: string): Promise<void> {
  deleting.add(id)
  try {
    await agentTasks.deleteTask(id)
  } finally {
    deleting.delete(id)
  }
}
</script>
