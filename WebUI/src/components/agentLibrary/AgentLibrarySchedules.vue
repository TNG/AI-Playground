<script setup lang="ts">
// Schedules and Channel starts belong to the saved Agent, not its Draft: each change here is
// written at once.
import { computed, ref } from 'vue'
import { PencilSquareIcon, PlusIcon, TrashIcon } from '@heroicons/vue/24/outline'
import {
  useAgentTasks,
  type AgentScheduleEntry,
  type LibraryAgent,
} from '@/assets/js/store/agentTasks'
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

const props = defineProps<{ agent: LibraryAgent; sessionRef?: string }>()

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

const rows = computed(() =>
  agentTasks
    .agentSchedules(props.agent.id)
    .filter((entry) => !props.sessionRef || entry.sessionRef === props.sessionRef)
    .map((entry) => {
      const session = { session: sessionTitle(entry.sessionRef) }
      return {
        entry,
        title: session.session,
        every: fillTemplate(i18n.AGENT_LIBRARY_SCHEDULE_EVERY, {
          count: entry.schedule.every,
          unit: i18n[UNIT_KEYS[entry.schedule.unit]],
        }),
        status: statusOf(entry),
        activeLabel: fillTemplate(i18n.AGENT_LIBRARY_SCHEDULE_ACTIVE_LABEL, session),
        changeLabel: fillTemplate(i18n.AGENT_LIBRARY_SCHEDULE_CHANGE, session),
        removeLabel: fillTemplate(i18n.AGENT_LIBRARY_SCHEDULE_REMOVE, session),
      }
    }),
)

const startableFromChannel = computed(
  () => agentTasks.tasks.find((task) => task.id === props.agent.id)?.startableFromChannel === true,
)

const addable = computed(() =>
  agentTasks
    .schedulableSessions(props.agent.id)
    .filter((session) => !props.sessionRef || session.id === props.sessionRef),
)

const dialogOpen = ref(false)
const editing = ref<string | undefined>()
const adding = ref(false)

function sessionTitle(sessionRef: string): string {
  return sessionsStore.sessions[sessionRef]?.title || i18n.SESSIONS_UNTITLED
}

function statusOf({ schedule, nextRunAt }: AgentScheduleEntry): string {
  if (!schedule.enabled) return i18n.AGENT_TASKS_SCHEDULE_PAUSED
  if (nextRunAt === undefined) return ''
  const time = describeNextRun(nextRunAt, Date.now(), i18nStore.langName, {
    today: i18n.AGENT_TASKS_NEXT_RUN_TODAY,
    tomorrow: i18n.AGENT_TASKS_NEXT_RUN_TOMORROW,
  })
  return fillTemplate(i18n.AGENT_TASKS_NEXT_RUN, { time })
}

function setActive(entry: AgentScheduleEntry, enabled: boolean): void {
  void agentTasks.setSchedule(props.agent.id, { ...entry.schedule, enabled }, entry.sessionRef)
}

function change(sessionRef: string): void {
  editing.value = sessionRef
  adding.value = false
  dialogOpen.value = true
}

function add(): void {
  editing.value = undefined
  adding.value = true
  dialogOpen.value = true
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <p v-if="!agent.saved" class="text-sm text-muted-foreground">
      {{ i18n.AGENT_LIBRARY_SCHEDULES_SAVE_FIRST }}
    </p>
    <TooltipProvider v-else :delay-duration="200">
      <label class="flex max-w-xl items-start gap-3 rounded-md bg-muted px-3 py-2">
        <Switch
          :model-value="startableFromChannel"
          :aria-label="i18n.AGENT_LIBRARY_STARTABLE_FROM_CHANNEL"
          @update:model-value="
            (startable: boolean) => agentTasks.setStartableFromChannel(agent.id, startable)
          "
        />
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="text-sm">{{ i18n.AGENT_LIBRARY_STARTABLE_FROM_CHANNEL }}</span>
          <span class="text-xs text-muted-foreground">
            {{ i18n.AGENT_LIBRARY_STARTABLE_FROM_CHANNEL_INFO }}
          </span>
        </span>
      </label>
      <ul v-if="rows.length > 0" class="flex max-w-xl flex-col gap-1">
        <li
          v-for="row in rows"
          :key="row.entry.sessionRef"
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
          <AgentRowAction :label="row.changeLabel" @click="change(row.entry.sessionRef)">
            <PencilSquareIcon class="size-4" />
          </AgentRowAction>
          <AgentRowAction
            :label="row.removeLabel"
            @click="agentTasks.removeSchedule(agent.id, row.entry.sessionRef)"
          >
            <TrashIcon class="size-4" />
          </AgentRowAction>
        </li>
      </ul>
      <p v-else class="text-sm text-muted-foreground">{{ i18n.AGENT_LIBRARY_SCHEDULES_NONE }}</p>
      <div v-if="addable.length > 0 || rows.length === 0" class="flex items-center gap-3">
        <Button variant="secondary" size="sm" :disabled="addable.length === 0" @click="add">
          <PlusIcon class="size-4" />
          {{ i18n.AGENT_LIBRARY_SCHEDULE_ADD }}
        </Button>
        <span v-if="addable.length === 0" class="text-xs text-muted-foreground">
          {{ i18n.AGENT_LIBRARY_SCHEDULE_NO_SESSION }}
        </span>
      </div>
      <TaskScheduleDialog
        v-model:open="dialogOpen"
        :task-id="agent.id"
        :session-ref="editing"
        :sessions="adding ? addable : undefined"
      />
    </TooltipProvider>
  </div>
</template>
