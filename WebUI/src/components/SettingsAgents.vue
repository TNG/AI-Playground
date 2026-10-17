<template>
  <TooltipProvider :delay-duration="200">
    <SettingsPanel :title="i18n.AGENT_AGENTS_TITLE" switch-id="agent-agents">
      <p class="text-xs text-muted-foreground">{{ i18n.AGENT_AGENTS_HINT }}</p>

      <ul v-if="rows.length > 0" class="flex flex-col gap-1" :aria-label="i18n.AGENT_AGENTS_TITLE">
        <li
          v-for="row in rows"
          :key="row.id"
          :aria-label="row.name"
          :aria-current="row.loaded ? 'true' : undefined"
          class="flex items-center justify-between gap-3 rounded-sm px-2 py-1.5"
          :class="row.loaded ? 'bg-primary/15' : ''"
        >
          <div class="flex flex-col min-w-0">
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
          </div>

          <div class="flex flex-none items-center gap-1">
            <Button
              v-if="row.running"
              variant="secondary"
              size="sm"
              class="px-3 py-1.5 rounded text-sm"
              :aria-label="row.stopLabel"
              @click="agentTasks.stopTask(row.id)"
            >
              {{ i18n.AGENT_AGENTS_STOP }}
            </Button>
            <Button
              v-else
              variant="secondary"
              size="sm"
              class="px-3 py-1.5 rounded text-sm"
              :aria-label="row.loadLabel"
              :disabled="agentMode.processing"
              @click="agentTasks.loadAgent(row.id)"
            >
              {{ i18n.AGENT_AGENTS_LOAD }}
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon" class="h-7 w-7" :aria-label="row.menuLabel">
                  <EllipsisHorizontalIcon class="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem v-if="row.sessionId" @select="openSession(row.sessionId)">
                  {{ i18n.AGENT_AGENTS_OPEN_RUN }}
                </DropdownMenuItem>
                <DropdownMenuItem @select="openSchedule(row.id)">
                  {{ i18n.AGENT_AGENTS_SCHEDULE }}
                </DropdownMenuItem>
                <DropdownMenuItem v-if="!row.running" @select="runNow(row.id)">
                  {{ i18n.AGENT_AGENTS_RUN_NOW }}
                </DropdownMenuItem>
                <DropdownMenuItem @select="history.showTaskSessions(row.id)">
                  {{ i18n.AGENT_AGENTS_SHOW_SESSIONS }}
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="text-destructive focus:text-destructive"
                  :disabled="row.running"
                  @select="agentTasks.deleteTask(row.id)"
                >
                  {{ i18n.AGENT_AGENTS_DELETE }}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </li>
      </ul>
      <p v-else class="text-sm text-muted-foreground text-center py-2">
        {{ i18n.AGENT_AGENTS_EMPTY }}
      </p>

      <div class="flex flex-col gap-1.5 border-t border-border pt-3">
        <Label for="agent-agents-name">{{ i18n.AGENT_AGENTS_NAME }}</Label>
        <div class="flex items-center gap-2">
          <Input
            id="agent-agents-name"
            v-model="name"
            autocomplete="off"
            :placeholder="i18n.AGENT_AGENTS_NAME_PLACEHOLDER"
          />
          <Button
            v-if="loaded"
            class="px-3 py-1.5 rounded text-sm flex-none"
            :disabled="!!blocker || saving"
            :aria-describedby="describedBy"
            @click="requestSave('update')"
          >
            {{ i18n.AGENT_AGENTS_UPDATE }}
          </Button>
          <Button
            :variant="loaded ? 'secondary' : 'default'"
            class="px-3 py-1.5 rounded text-sm flex-none"
            :disabled="!!blocker || saving"
            :aria-describedby="describedBy"
            @click="requestSave('new')"
          >
            {{ loaded ? i18n.AGENT_AGENTS_SAVE_AS_NEW : i18n.AGENT_AGENTS_SAVE }}
          </Button>
        </div>
        <p v-if="blockerText" id="agent-agents-save-blocker" class="text-xs text-muted-foreground">
          {{ blockerText }}
        </p>
        <p
          v-if="saveError"
          id="agent-agents-save-error"
          role="alert"
          class="text-xs text-destructive"
        >
          {{ saveError }}
        </p>
        <TaskModelWarnings :state="modelWarnings" />
      </div>
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
import { EllipsisHorizontalIcon, ExclamationTriangleIcon } from '@heroicons/vue/24/outline'
import type { AgentTaskOutcome } from '@/types/agentTaskIpc'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { SAVE_TASK_BLOCKER_KEYS, useAgentTasks } from '@/assets/js/store/agentTasks'
import { useErrors } from '@/assets/js/store/errors'
import { useHistorySessions } from '@/assets/js/store/historySessions'
import { useI18N } from '@/assets/js/store/i18n'
import SettingsPanel from '@/components/SettingsPanel.vue'
import TaskModelSaveConfirm from '@/components/TaskModelSaveConfirm.vue'
import TaskModelWarnings from '@/components/TaskModelWarnings.vue'
import TaskScheduleDialog from '@/components/TaskScheduleDialog.vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

const loaded = computed(() => agentTasks.openSessionTask)

const name = ref('')
watch(
  () => loaded.value?.id,
  () => {
    name.value = loaded.value?.name ?? ''
  },
  { immediate: true },
)

const rows = computed(() =>
  agentTasks.tasks.map((task) => {
    const state = agentTasks.taskState(task.id)
    const run = 'running' in state ? state.running : undefined
    const outcome = 'idle' in state ? state.idle : undefined
    const reasons = describeSettingsProblems(agentTasks.taskProblems(task.id), i18n)
    const steps = fill(i18n.AGENT_TASKS_STEP_COUNT, { count: task.steps.length })
    const schedule = scheduleLine(task.id)
    return {
      id: task.id,
      name: task.name,
      loaded: loaded.value?.id === task.id,
      meta: [steps, schedule].filter(Boolean).join(' · '),
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
      loadLabel: fill(i18n.AGENT_AGENTS_LOAD_LABEL, { name: task.name }),
      stopLabel: fill(i18n.AGENT_TASKS_STOP, { name: task.name }),
      menuLabel: fill(i18n.AGENT_AGENTS_MENU_LABEL, { name: task.name }),
    }
  }),
)

function scheduleLine(id: string): string | undefined {
  const { schedule, nextRunAt } = agentTasks.taskSchedule(id)
  if (!schedule) return undefined
  if (!schedule.enabled) return i18n.AGENT_TASKS_SCHEDULE_PAUSED
  if (nextRunAt === undefined) return undefined
  const time = describeNextRun(nextRunAt, Date.now(), i18nStore.langName, {
    today: i18n.AGENT_TASKS_NEXT_RUN_TODAY,
    tomorrow: i18n.AGENT_TASKS_NEXT_RUN_TOMORROW,
  })
  return fill(i18n.AGENT_TASKS_NEXT_RUN, { time })
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

const scheduleOpen = ref(false)
const scheduleTaskId = ref<string | null>(null)

function openSchedule(id: string): void {
  scheduleTaskId.value = id
  scheduleOpen.value = true
}

async function openSession(sessionId: string): Promise<void> {
  await agentMode.openSession(sessionId)
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

const saving = ref(false)
/** Why the last save stored nothing, when its chat model was not downloaded. */
const saveError = ref('')
const confirmModelsOpen = ref(false)
const pendingSave = ref<'new' | 'update'>('new')

const modelWarnings = useTaskModelWarnings(() => agentMode.openSessionSettings)

const blocker = computed(() => agentTasks.saveAgentBlocker(name.value))
const blockerText = computed(() =>
  blocker.value ? i18n[SAVE_TASK_BLOCKER_KEYS[blocker.value]] : '',
)
const describedBy = computed(
  () =>
    [blockerText.value && 'agent-agents-save-blocker', saveError.value && 'agent-agents-save-error']
      .filter(Boolean)
      .join(' ') || undefined,
)

/** Missing models do not block saving, but the user confirms them before the Agent is stored. */
function requestSave(kind: 'new' | 'update'): void {
  pendingSave.value = kind
  if (modelWarnings.missingCount.value > 0) confirmModelsOpen.value = true
  else void save(kind)
}

async function save(kind: 'new' | 'update'): Promise<void> {
  const target = loaded.value
  saving.value = true
  try {
    saveError.value = ''
    const result =
      kind === 'update' && target
        ? await agentTasks.updateAgent(target.id, name.value)
        : await agentTasks.saveAgent(name.value)
    if (!result.ok && 'message' in result) saveError.value = result.message
    if (result.ok) toast.success(fill(i18n.AGENT_AGENTS_SAVED, { name: result.task.name }))
  } finally {
    saving.value = false
  }
}
</script>
