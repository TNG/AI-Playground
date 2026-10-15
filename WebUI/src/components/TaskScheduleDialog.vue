<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-md max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ i18n.AGENT_TASK_SCHEDULE_DESCRIPTION }}</DialogDescription>
      </DialogHeader>
      <form class="flex flex-col gap-4" @submit.prevent="save">
        <div class="flex items-center gap-3">
          <Switch id="task-schedule-active" v-model="active" />
          <Label for="task-schedule-active">{{ i18n.AGENT_TASK_SCHEDULE_ACTIVE }}</Label>
        </div>
        <fieldset class="flex flex-col gap-1.5">
          <legend class="text-sm font-medium text-foreground mb-1.5">
            {{ i18n.AGENT_TASK_SCHEDULE_EVERY }}
          </legend>
          <div class="flex gap-2">
            <Input
              v-model="every"
              type="number"
              min="1"
              step="1"
              class="w-24"
              :aria-label="i18n.AGENT_TASK_SCHEDULE_COUNT"
              :aria-invalid="everyError ? 'true' : undefined"
              :aria-describedby="everyError ? 'task-schedule-every-error' : undefined"
            />
            <select
              v-model="unit"
              :aria-label="i18n.AGENT_TASK_SCHEDULE_UNIT"
              class="h-9 flex-1 rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option v-for="option in unitOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </div>
          <p v-if="everyError" id="task-schedule-every-error" class="text-xs text-destructive">
            {{ everyError }}
          </p>
        </fieldset>
        <div class="flex flex-col gap-1.5">
          <Label for="task-schedule-start">{{ i18n.AGENT_TASK_SCHEDULE_STARTING }}</Label>
          <Input
            id="task-schedule-start"
            v-model="start"
            type="datetime-local"
            :aria-invalid="problem === 'missing-start' ? 'true' : undefined"
            :aria-describedby="
              problem === 'missing-start' ? 'task-schedule-start-error' : undefined
            "
            @update:model-value="startTouched = true"
          />
          <p
            v-if="problem === 'missing-start'"
            id="task-schedule-start-error"
            class="text-xs text-destructive"
          >
            {{ i18n.AGENT_TASK_SCHEDULE_ERROR_START }}
          </p>
        </div>
        <p role="status" class="text-sm text-muted-foreground">{{ preview }}</p>
        <template v-if="active && task">
          <p class="text-sm text-muted-foreground">
            {{ i18n.AGENT_TASK_SCHEDULE_PAUSES_FOR_MODELS }}
          </p>
          <TaskModelWarnings :template="task.settingsTemplate" :chat-model-steps="task.steps" />
        </template>
        <DialogFooter class="gap-2">
          <Button
            v-if="hasSchedule"
            type="button"
            variant="destructive"
            class="sm:mr-auto"
            :disabled="busy"
            @click="remove"
          >
            {{ i18n.AGENT_TASK_SCHEDULE_REMOVE }}
          </Button>
          <Button type="button" variant="ghost" @click="open = false">
            {{ i18n.COM_CANCEL }}
          </Button>
          <Button type="submit" :disabled="problem !== null || busy">
            {{ i18n.AGENT_TASK_SCHEDULE_SAVE }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  AGENT_TASK_SCHEDULE_UNITS,
  MIN_SCHEDULE_MINUTES,
  type AgentTaskSchedule,
  type AgentTaskScheduleUnit,
} from '@/types/agentTaskIpc'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import TaskModelWarnings from '@/components/TaskModelWarnings.vue'
import {
  describeNextRun,
  nextSlotAfter,
  scheduleIntervalMs,
  scheduleProblem,
} from '@/lib/taskSchedule'

const props = defineProps<{
  taskId: string | null
}>()

const open = defineModel<boolean>('open', { required: true })

const agentTasks = useAgentTasks()
const i18nStore = useI18N()
const i18n = i18nStore.state

const task = computed(() => agentTasks.tasks.find((entry) => entry.id === props.taskId))
const title = computed(() => i18n.AGENT_TASKS_SCHEDULE.replace('{name}', task.value?.name ?? ''))
const hasSchedule = computed(() => task.value?.schedule !== undefined)

const UNIT_KEYS = {
  minutes: 'AGENT_TASK_SCHEDULE_UNIT_MINUTES',
  hours: 'AGENT_TASK_SCHEDULE_UNIT_HOURS',
  days: 'AGENT_TASK_SCHEDULE_UNIT_DAYS',
  weeks: 'AGENT_TASK_SCHEDULE_UNIT_WEEKS',
} as const satisfies Record<AgentTaskScheduleUnit, string>

const unitOptions = computed(() =>
  AGENT_TASK_SCHEDULE_UNITS.map((value) => ({ value, label: i18n[UNIT_KEYS[value]] })),
)

const active = ref(true)
const every = ref<string | number>(1)
const unit = ref<AgentTaskScheduleUnit>('days')
const start = ref('')
// A new Schedule's start follows "now + one interval" until the user picks one.
const startTouched = ref(false)
const busy = ref(false)

watch(open, (isOpen) => {
  if (isOpen) reset()
})

function reset(): void {
  const existing = task.value?.schedule
  active.value = existing?.enabled ?? true
  every.value = existing?.every ?? 1
  unit.value = existing?.unit ?? 'days'
  startTouched.value = existing !== undefined
  start.value = existing ? toLocalInput(existing.startAt) : defaultStart()
  busy.value = false
}

watch([every, unit], () => {
  if (!startTouched.value) start.value = defaultStart()
})

function defaultStart(): string {
  const count = Number(every.value)
  const interval = Number.isInteger(count) && count >= 1 ? count : 1
  return toLocalInput(Date.now() + scheduleIntervalMs(interval, unit.value))
}

function toLocalInput(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

const schedule = computed<AgentTaskSchedule>(() => ({
  every: every.value === '' ? Number.NaN : Number(every.value),
  unit: unit.value,
  // A datetime-local value has no offset, so it parses as local time.
  startAt: start.value ? new Date(start.value).getTime() : Number.NaN,
  enabled: active.value,
}))

const problem = computed(() => scheduleProblem(schedule.value))

const everyError = computed(() => {
  if (problem.value === 'invalid-count') return i18n.AGENT_TASK_SCHEDULE_ERROR_EVERY
  if (problem.value === 'too-short') {
    return i18n.AGENT_TASK_SCHEDULE_ERROR_TOO_SHORT.replace(
      '{minutes}',
      String(MIN_SCHEDULE_MINUTES),
    )
  }
  return null
})

const preview = computed(() => {
  if (!active.value) return i18n.AGENT_TASKS_SCHEDULE_PAUSED
  if (problem.value) return ''
  const now = Date.now()
  const label = describeNextRun(nextSlotAfter(schedule.value, now), now, i18nStore.langName, {
    today: i18n.AGENT_TASKS_NEXT_RUN_TODAY,
    tomorrow: i18n.AGENT_TASKS_NEXT_RUN_TOMORROW,
  })
  return i18n.AGENT_TASKS_NEXT_RUN.replace('{time}', label)
})

async function save(): Promise<void> {
  if (!props.taskId || problem.value || busy.value) return
  busy.value = true
  try {
    if ((await agentTasks.setSchedule(props.taskId, schedule.value)).ok) open.value = false
  } finally {
    busy.value = false
  }
}

async function remove(): Promise<void> {
  if (!props.taskId || busy.value) return
  busy.value = true
  try {
    if (await agentTasks.removeSchedule(props.taskId)) open.value = false
  } finally {
    busy.value = false
  }
}
</script>
