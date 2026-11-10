<script setup lang="ts">
// The open Session's side of Schedules: every Agent scheduled in it, each change written at once.
import { computed, ref } from 'vue'
import { PencilSquareIcon, PlusIcon, TrashIcon } from '@heroicons/vue/24/outline'
import { useAgentTasks, type SessionScheduleEntry } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import { useSessions } from '@/assets/js/store/sessions'
import AgentRowAction from '@/components/AgentRowAction.vue'
import TaskScheduleDialog from '@/components/TaskScheduleDialog.vue'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { TooltipProvider } from '@/components/ui/tooltip'
import { describeNextRun } from '@/lib/taskSchedule'
import { fillTemplate } from '@/lib/fillTemplate'
import type { AgentTaskScheduleUnit } from '@/types/agentTaskIpc'

const agentTasks = useAgentTasks()
const sessionsStore = useSessions()
const i18nStore = useI18N()
const i18n = i18nStore.state

const UNIT_KEYS = {
  minutes: 'AGENT_TASK_SCHEDULE_UNIT_MINUTES',
  hours: 'AGENT_TASK_SCHEDULE_UNIT_HOURS',
  days: 'AGENT_TASK_SCHEDULE_UNIT_DAYS',
  weeks: 'AGENT_TASK_SCHEDULE_UNIT_WEEKS',
} as const satisfies Record<AgentTaskScheduleUnit, string>

const sessionRef = computed(() => sessionsStore.openSessionId)

const rows = computed(() =>
  sessionRef.value
    ? agentTasks.sessionSchedules(sessionRef.value).map((entry) => {
        const agent = { agent: agentName(entry.agentId) }
        return {
          entry,
          title: agent.agent,
          every: fillTemplate(i18n.AGENT_LIBRARY_SCHEDULE_EVERY, {
            count: entry.schedule.every,
            unit: i18n[UNIT_KEYS[entry.schedule.unit]],
          }),
          status: statusOf(entry),
          activeLabel: fillTemplate(i18n.SESSION_SCHEDULES_ACTIVE_LABEL, agent),
          changeLabel: fillTemplate(i18n.SESSION_SCHEDULES_CHANGE, agent),
          removeLabel: fillTemplate(i18n.SESSION_SCHEDULES_REMOVE, agent),
        }
      })
    : [],
)

const addable = computed(() =>
  sessionRef.value ? agentTasks.schedulableAgents(sessionRef.value) : [],
)

const dialogOpen = ref(false)
const editing = ref<string | null>(null)
const adding = ref(false)

function agentName(agentId: string): string {
  return agentTasks.tasks.find((task) => task.id === agentId)?.name ?? ''
}

function statusOf({ schedule, nextRunAt }: SessionScheduleEntry): string {
  if (!schedule.enabled) return i18n.AGENT_TASKS_SCHEDULE_PAUSED
  if (nextRunAt === undefined) return ''
  const time = describeNextRun(nextRunAt, Date.now(), i18nStore.langName, {
    today: i18n.AGENT_TASKS_NEXT_RUN_TODAY,
    tomorrow: i18n.AGENT_TASKS_NEXT_RUN_TOMORROW,
  })
  return fillTemplate(i18n.AGENT_TASKS_NEXT_RUN, { time })
}

function setActive(entry: SessionScheduleEntry, enabled: boolean): void {
  if (!sessionRef.value) return
  void agentTasks.setSchedule(entry.agentId, { ...entry.schedule, enabled }, sessionRef.value)
}

function remove(agentId: string): void {
  if (sessionRef.value) void agentTasks.removeSchedule(agentId, sessionRef.value)
}

function change(agentId: string): void {
  editing.value = agentId
  adding.value = false
  dialogOpen.value = true
}

function add(): void {
  editing.value = null
  adding.value = true
  dialogOpen.value = true
}
</script>

<template>
  <div class="flex flex-col gap-3 px-4 py-3 text-foreground">
    <p v-if="!sessionRef" class="text-sm text-muted-foreground">
      {{ i18n.SESSION_SCHEDULES_NO_SESSION }}
    </p>
    <TooltipProvider v-else :delay-duration="200">
      <ul v-if="rows.length > 0" class="flex max-w-xl flex-col gap-1">
        <li
          v-for="row in rows"
          :key="row.entry.agentId"
          class="flex items-center gap-3 rounded-md bg-muted px-3 py-2"
        >
          <Switch
            :model-value="row.entry.schedule.enabled"
            :aria-label="row.activeLabel"
            @update:model-value="(enabled: boolean) => setActive(row.entry, enabled)"
          />
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-sm">{{ row.title }}</span>
            <span class="truncate text-xs text-muted-foreground">
              {{ row.every }}<template v-if="row.status"> · {{ row.status }}</template>
            </span>
          </div>
          <AgentRowAction :label="row.changeLabel" @click="change(row.entry.agentId)">
            <PencilSquareIcon class="size-4" />
          </AgentRowAction>
          <AgentRowAction :label="row.removeLabel" @click="remove(row.entry.agentId)">
            <TrashIcon class="size-4" />
          </AgentRowAction>
        </li>
      </ul>
      <p v-else class="text-sm text-muted-foreground">{{ i18n.SESSION_SCHEDULES_NONE }}</p>
      <div v-if="addable.length > 0 || rows.length === 0" class="flex items-center gap-3">
        <Button variant="secondary" size="sm" :disabled="addable.length === 0" @click="add">
          <PlusIcon class="size-4" />
          {{ i18n.AGENT_LIBRARY_SCHEDULE_ADD }}
        </Button>
        <span v-if="addable.length === 0" class="text-xs text-muted-foreground">
          {{ i18n.SESSION_SCHEDULES_NO_AGENT }}
        </span>
      </div>
      <TaskScheduleDialog
        v-model:open="dialogOpen"
        :task-id="editing"
        :session-ref="sessionRef ?? undefined"
        :agents="adding ? addable : undefined"
      />
    </TooltipProvider>
  </div>
</template>
