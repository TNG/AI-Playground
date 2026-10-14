<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle>{{ i18n.AGENT_TASKS_TITLE }}</DialogTitle>
        <DialogDescription>{{ i18n.AGENT_TASKS_DESCRIPTION }}</DialogDescription>
      </DialogHeader>

      <p v-if="agentTasks.tasks.length === 0" class="text-sm text-muted-foreground">
        {{ i18n.AGENT_TASKS_EMPTY }}
      </p>
      <TooltipProvider v-else :delay-duration="200">
        <ul
          :aria-label="i18n.AGENT_TASKS_TITLE"
          class="flex flex-col gap-2 max-h-[55vh] overflow-y-auto py-1 pr-1"
        >
          <li
            v-for="row in rows"
            :key="row.id"
            :aria-label="row.name"
            class="flex items-center gap-3 rounded-md border border-border bg-muted/40 px-3 py-2"
          >
            <span class="flex flex-col min-w-0 flex-1">
              <span class="text-sm text-foreground truncate">{{ row.name }}</span>
              <span class="text-xs text-muted-foreground">{{ row.stepCount }}</span>
              <template v-if="row.outcome">
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
            <Tooltip>
              <TooltipTrigger as-child>
                <button
                  type="button"
                  class="size-7 flex-none flex items-center justify-center rounded-xs bg-muted hover:bg-destructive/20 disabled:opacity-40 disabled:cursor-not-allowed"
                  :aria-label="row.deleteLabel"
                  :disabled="deleting.has(row.id)"
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
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'
import { TrashIcon } from '@heroicons/vue/24/outline'
import type { AgentTaskOutcome } from '@/types/agentTaskIpc'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const open = defineModel<boolean>('open', { required: true })

const agentTasks = useAgentTasks()
const i18n = useI18N().state

const deleting = reactive(new Set<string>())

function fill(template: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (result, [name, value]) => result.replace(`{${name}}`, String(value)),
    template,
  )
}

const rows = computed(() =>
  agentTasks.tasks.map((task) => {
    const outcome = agentTasks.taskState(task.id).idle
    return {
      id: task.id,
      name: task.name,
      stepCount: fill(i18n.AGENT_TASKS_STEP_COUNT, { count: task.steps.length }),
      deleteLabel: fill(i18n.AGENT_TASKS_DELETE, { name: task.name }),
      outcome: outcome && {
        label: outcomeLabel(outcome),
        failed: outcome.kind === 'failed',
        message: outcome.kind === 'failed' ? outcome.message : undefined,
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

async function remove(id: string): Promise<void> {
  deleting.add(id)
  try {
    await agentTasks.deleteTask(id)
  } finally {
    deleting.delete(id)
  }
}
</script>
