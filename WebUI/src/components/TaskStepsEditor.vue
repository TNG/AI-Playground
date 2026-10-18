<template>
  <div class="flex flex-col gap-1.5">
    <Label :id="`${idPrefix}-steps`" class="sr-only">{{ i18n.AGENT_TASK_STEPS }}</Label>
    <TooltipProvider :delay-duration="200">
      <ol
        v-if="steps.length > 0"
        :aria-labelledby="`${idPrefix}-steps`"
        class="flex flex-col gap-2"
      >
        <li
          v-for="(step, index) in steps"
          :key="step.id"
          :aria-label="stepLabel(index)"
          class="flex flex-col gap-1 rounded-sm border border-border px-2 py-1.5"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {{ stepLabel(index) }}
            </span>
            <div class="flex items-center gap-1">
              <Tooltip v-for="control in stepControls(step.id, index)" :key="control.kind">
                <TooltipTrigger as-child>
                  <button
                    type="button"
                    class="size-6 flex items-center justify-center rounded-xs bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                    :aria-label="control.label"
                    :disabled="control.disabled"
                    @click="control.run"
                  >
                    <component :is="control.icon" class="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{{ control.label }}</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <Textarea
            :model-value="step.prompt"
            :aria-label="stepTextLabel(index)"
            class="min-h-16 text-xs"
            @update:model-value="(prompt) => update(withStepPrompt(steps, step.id, String(prompt)))"
          />
        </li>
      </ol>
    </TooltipProvider>
    <p v-if="steps.length === 0" class="text-xs text-muted-foreground italic">
      {{ i18n.AGENT_TASK_NO_STEPS_YET }}
    </p>
    <Button
      variant="secondary"
      class="self-start px-3 py-1.5 rounded text-sm"
      @click="update(withStepAdded(steps))"
    >
      <PlusIcon class="size-4" />
      {{ i18n.AGENT_TASK_ADD_STEP }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from '@heroicons/vue/24/outline'
import type { AgentTaskStep } from '@/types/agentTaskIpc'
import { useI18N } from '@/assets/js/store/i18n'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  withStepAdded,
  withStepInserted,
  withStepMoved,
  withStepPrompt,
  withStepRemoved,
} from '@/lib/taskSteps'

const props = defineProps<{
  steps: AgentTaskStep[]
  idPrefix: string
}>()

const emit = defineEmits<{
  'update:steps': [steps: AgentTaskStep[]]
}>()

const i18n = useI18N().state

function update(steps: AgentTaskStep[]): void {
  emit('update:steps', steps)
}

type NumberedKey =
  | 'AGENT_TASK_STEP_LABEL'
  | 'AGENT_TASK_STEP_TEXT'
  | 'AGENT_TASK_MOVE_STEP_UP'
  | 'AGENT_TASK_MOVE_STEP_DOWN'
  | 'AGENT_TASK_REMOVE_STEP'
  | 'AGENT_STEPS_INSERT_AFTER'

function numbered(key: NumberedKey, index: number): string {
  return i18n[key].replace('{number}', String(index + 1))
}

function stepLabel(index: number): string {
  return numbered('AGENT_TASK_STEP_LABEL', index)
}

function stepTextLabel(index: number): string {
  return numbered('AGENT_TASK_STEP_TEXT', index)
}

type StepControl = {
  kind: 'insert' | 'up' | 'down' | 'remove'
  label: string
  icon: Component
  disabled: boolean
  run: () => void
}

function stepControls(id: string, index: number): StepControl[] {
  const last = props.steps.length - 1
  return [
    {
      kind: 'insert',
      label: numbered('AGENT_STEPS_INSERT_AFTER', index),
      icon: PlusIcon,
      disabled: false,
      run: () => update(withStepInserted(props.steps, id)),
    },
    {
      kind: 'up',
      label: numbered('AGENT_TASK_MOVE_STEP_UP', index),
      icon: ArrowUpIcon,
      disabled: index === 0,
      run: () => update(withStepMoved(props.steps, id, 'up')),
    },
    {
      kind: 'down',
      label: numbered('AGENT_TASK_MOVE_STEP_DOWN', index),
      icon: ArrowDownIcon,
      disabled: index === last,
      run: () => update(withStepMoved(props.steps, id, 'down')),
    },
    {
      kind: 'remove',
      label: numbered('AGENT_TASK_REMOVE_STEP', index),
      icon: TrashIcon,
      disabled: false,
      run: () => update(withStepRemoved(props.steps, id)),
    },
  ]
}
</script>
