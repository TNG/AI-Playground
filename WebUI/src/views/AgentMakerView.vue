<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAgentMaker, type AgentRunStatus } from '@/assets/js/store/agentMaker'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useMediaAgentRuns } from '@/assets/js/store/mediaAgentRuns'
import { useI18N } from '@/assets/js/store/i18n'
import AgentTaskForm from '@/components/AgentTaskForm.vue'
import ModeNavigation from '@/components/ModeNavigation.vue'
import { busyLabelOf } from '@/lib/agentTranscript'
import type { AgentTask } from '@/types/agentMakerIpc'

const agentMaker = useAgentMaker()
const agentMode = useAgentMode()
const mediaRuns = useMediaAgentRuns()
const { state: i18nState } = useI18N()

type View = 'list' | 'form' | 'runs'
const view = ref<View>('list')
const editingTask = ref<AgentTask | null>(null)
const selectedTaskId = ref<string | null>(null)

onMounted(() => {
  void agentMaker.init()
  if (agentMaker.focusTaskId) {
    viewRuns(agentMaker.focusTaskId)
    agentMaker.focusTaskId = null
  }
})

const tasks = computed(() => [...agentMaker.tasks].sort((a, b) => b.updatedAt - a.updatedAt))

const selectedTask = computed(() =>
  selectedTaskId.value ? agentMaker.findTask(selectedTaskId.value) : null,
)
const selectedTaskRuns = computed(() =>
  selectedTaskId.value ? agentMaker.taskRuns(selectedTaskId.value) : [],
)

const activeRun = computed(() => agentMaker.activeRun)
const runBusyLabel = computed(() =>
  activeRun.value && agentMode.activeSessionId === activeRun.value.sessionId
    ? busyLabelOf(agentMode.messages.at(-1)?.parts ?? [], (toolCallId) =>
        mediaRuns.activeStepLabel(toolCallId),
      )
    : '',
)

function isRunning(taskId: string): boolean {
  return activeRun.value?.taskId === taskId
}

function openForm(task: AgentTask | null): void {
  editingTask.value = task
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

function modelLabel(task: AgentTask): string {
  return task.model.model.split('/').at(-1) ?? task.model.model
}

function stepProgress(): string {
  const run = activeRun.value
  if (!run) return ''
  return i18nState.AGENT_MAKER_STEP_PROGRESS.replace(
    '{current}',
    String(run.stepIndex + 1),
  ).replace('{total}', String(run.stepCount))
}

const STATUS_LABEL_KEYS: Record<AgentRunStatus, string> = {
  running: 'AGENT_MAKER_STATUS_RUNNING',
  completed: 'AGENT_MAKER_STATUS_COMPLETED',
  failed: 'AGENT_MAKER_STATUS_FAILED',
  stopped: 'AGENT_MAKER_STATUS_STOPPED',
  interrupted: 'AGENT_MAKER_STATUS_INTERRUPTED',
}

const STATUS_CLASSES: Record<AgentRunStatus, string> = {
  running: 'text-blue-500',
  completed: 'text-green-500',
  failed: 'text-red-500',
  stopped: 'text-muted-foreground',
  interrupted: 'text-amber-500',
}

function statusLabel(status: AgentRunStatus): string {
  return i18nState[STATUS_LABEL_KEYS[status]]
}

async function deleteTask(taskId: string): Promise<void> {
  await agentMaker.deleteTask(taskId)
  if (selectedTaskId.value === taskId) backToList()
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <div
      class="mx-auto flex w-full max-w-4xl shrink-0 items-center justify-between border-b border-border px-6 py-4"
    >
      <h2 class="text-lg font-semibold">{{ i18nState.AGENT_MAKER_TITLE }}</h2>
      <div class="flex gap-2">
        <button
          v-if="view !== 'list'"
          class="rounded-md px-3 py-1.5 text-sm hover:bg-muted"
          @click="backToList"
        >
          {{ i18nState.AGENT_MAKER_BACK }}
        </button>
        <button
          v-if="view === 'list'"
          class="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
          @click="openForm(null)"
        >
          {{ i18nState.AGENT_MAKER_NEW_TASK }}
        </button>
      </div>
    </div>

    <!-- Centered like the other modes, so nothing runs under the fixed corner controls. -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-4xl px-6 pt-4 pb-16">
        <!-- Task list -->
        <div v-if="view === 'list'">
          <p v-if="tasks.length === 0" class="text-sm text-muted-foreground">
            {{ i18nState.AGENT_MAKER_EMPTY }}
          </p>
          <ul v-else class="flex flex-col gap-2">
            <li
              v-for="task in tasks"
              :key="task.id"
              :aria-label="task.name"
              class="flex flex-col gap-3 rounded-lg border border-border p-4"
            >
              <div class="flex items-center justify-between gap-4">
                <div class="min-w-0 flex-1">
                  <div class="font-medium">{{ task.name }}</div>
                  <div class="text-xs text-muted-foreground">
                    {{
                      i18nState.AGENT_MAKER_STEP_COUNT.replace('{count}', String(task.steps.length))
                    }}
                    · {{ modelLabel(task) }}
                  </div>
                </div>
                <div class="flex shrink-0 gap-2">
                  <button
                    v-if="!isRunning(task.id)"
                    class="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    :disabled="!agentMaker.canStartRun"
                    @click="agentMaker.startRun(task.id)"
                  >
                    {{ i18nState.AGENT_MAKER_RUN }}
                  </button>
                  <button
                    class="rounded-md px-3 py-1.5 text-sm hover:bg-muted"
                    @click="viewRuns(task.id)"
                  >
                    {{ i18nState.AGENT_MAKER_HISTORY }}
                  </button>
                  <button
                    class="rounded-md px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                    :disabled="isRunning(task.id)"
                    @click="openForm(task)"
                  >
                    {{ i18nState.AGENT_MAKER_EDIT }}
                  </button>
                  <button
                    class="rounded-md px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    :disabled="isRunning(task.id)"
                    @click="deleteTask(task.id)"
                  >
                    {{ i18nState.AGENT_MAKER_DELETE }}
                  </button>
                </div>
              </div>

              <!-- Live progress of this task's run -->
              <div
                v-if="isRunning(task.id) && activeRun"
                role="status"
                class="flex items-center justify-between gap-4 rounded-md bg-muted px-3 py-2"
              >
                <div class="flex min-w-0 items-center gap-2 text-sm">
                  <span
                    class="inline-block size-2 shrink-0 animate-pulse rounded-full bg-primary"
                  />
                  <span class="font-medium">{{ stepProgress() }}</span>
                  <span class="truncate text-muted-foreground">
                    {{ task.steps[activeRun.stepIndex] }}
                  </span>
                  <span v-if="runBusyLabel" class="shrink-0 text-xs text-muted-foreground">
                    · {{ runBusyLabel }}
                  </span>
                </div>
                <div class="flex shrink-0 gap-2">
                  <button
                    class="rounded-md px-3 py-1.5 text-sm hover:bg-background"
                    @click="agentMaker.openRun(activeRun.sessionId)"
                  >
                    {{ i18nState.AGENT_MAKER_OPEN_IN_AGENT }}
                  </button>
                  <button
                    class="rounded-md px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
                    @click="agentMaker.stopRun()"
                  >
                    {{ i18nState.AGENT_MAKER_STOP }}
                  </button>
                </div>
              </div>
            </li>
          </ul>
        </div>

        <!-- Create / edit form -->
        <div v-else-if="view === 'form'">
          <AgentTaskForm :task="editingTask" @saved="backToList" @cancel="backToList" />
        </div>

        <!-- Run history -->
        <div v-else-if="view === 'runs'">
          <div v-if="!selectedTask" class="text-sm text-muted-foreground">
            {{ i18nState.AGENT_MAKER_TASK_NOT_FOUND }}
          </div>
          <div v-else>
            <h3 class="mb-3 text-base font-medium">{{ selectedTask.name }}</h3>
            <p v-if="selectedTaskRuns.length === 0" class="text-sm text-muted-foreground">
              {{ i18nState.AGENT_MAKER_NO_RUNS }}
            </p>
            <ul v-else class="flex flex-col gap-2">
              <li
                v-for="run in selectedTaskRuns"
                :key="run.id"
                class="flex items-center justify-between rounded-lg border border-border p-3"
              >
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium">
                    <span :class="STATUS_CLASSES[agentMaker.runStatus(run)]">
                      {{ statusLabel(agentMaker.runStatus(run)) }}
                    </span>
                    · {{ new Date(run.createdAt).toLocaleString() }}
                    <span v-if="activeRun?.sessionId === run.id" class="text-muted-foreground">
                      · {{ stepProgress() }}
                    </span>
                  </div>
                  <div v-if="run.taskRunError" class="text-xs text-muted-foreground">
                    {{ run.taskRunError }}
                  </div>
                </div>
                <div class="flex shrink-0 gap-2">
                  <button
                    v-if="activeRun?.sessionId === run.id"
                    class="rounded-md px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
                    @click="agentMaker.stopRun()"
                  >
                    {{ i18nState.AGENT_MAKER_STOP }}
                  </button>
                  <button
                    class="rounded-md px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                    :disabled="!!activeRun && activeRun.sessionId !== run.id"
                    @click="agentMaker.openRun(run.id)"
                  >
                    {{ i18nState.AGENT_MAKER_OPEN_IN_AGENT }}
                  </button>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- Agent Maker has no prompt bar, so the mode navigation sits in its own footer. -->
    <div class="shrink-0">
      <div class="mx-auto flex w-full max-w-3xl items-center px-4 pt-2 pb-4">
        <ModeNavigation />
      </div>
    </div>
  </div>
</template>
