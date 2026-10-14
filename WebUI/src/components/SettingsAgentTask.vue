<template>
  <Collapsible v-model:open="open" class="border-t border-border pt-4 flex flex-col gap-3">
    <CollapsibleTrigger class="flex items-center justify-between gap-2 text-left cursor-pointer">
      <span class="text-sm font-medium">{{ i18n.AGENT_TASK_SECTION }}</span>
      <ChevronDownIcon class="size-4 transition-transform" :class="{ 'rotate-180': open }" />
    </CollapsibleTrigger>

    <CollapsibleContent class="flex flex-col gap-3">
      <p class="text-xs text-muted-foreground">{{ i18n.AGENT_TASK_SECTION_HINT }}</p>

      <Button
        variant="secondary"
        class="self-start px-3 py-1.5 rounded text-sm"
        :disabled="!hasSessionSteps"
        @click="createFromSession"
      >
        {{ i18n.AGENT_TASK_CREATE_FROM_SESSION }}
      </Button>

      <div class="flex flex-col gap-1.5">
        <Label for="agent-task-name">{{ i18n.AGENT_TASK_NAME }}</Label>
        <Input id="agent-task-name" v-model="agentTasks.draft.name" autocomplete="off" />
      </div>

      <div class="flex flex-col gap-1.5">
        <Label id="agent-task-steps">{{ i18n.AGENT_TASK_STEPS }}</Label>
        <TooltipProvider :delay-duration="200">
          <ol
            v-if="agentTasks.draft.steps.length > 0"
            aria-labelledby="agent-task-steps"
            class="flex flex-col gap-2"
          >
            <li
              v-for="(step, index) in agentTasks.draft.steps"
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
                v-model="step.prompt"
                :aria-label="stepTextLabel(index)"
                class="min-h-16 text-xs"
              />
            </li>
          </ol>
        </TooltipProvider>
        <p v-if="agentTasks.draft.steps.length === 0" class="text-xs text-muted-foreground italic">
          {{ i18n.AGENT_TASK_NO_STEPS_YET }}
        </p>
        <Button
          variant="secondary"
          class="self-start px-3 py-1.5 rounded text-sm"
          @click="agentTasks.addStep()"
        >
          <PlusIcon class="size-4" />
          {{ i18n.AGENT_TASK_ADD_STEP }}
        </Button>
      </div>

      <p class="text-xs text-muted-foreground break-all">{{ summary }}</p>

      <div class="flex flex-col gap-1.5">
        <Button
          class="self-start px-3 py-1.5 rounded text-sm"
          :disabled="!!agentTasks.draftBlocker || saving"
          :aria-describedby="blockerText ? 'agent-task-save-blocker' : undefined"
          @click="save"
        >
          {{ i18n.AGENT_TASK_SAVE }}
        </Button>
        <p v-if="blockerText" id="agent-task-save-blocker" class="text-xs text-amber-500">
          {{ blockerText }}
        </p>
      </div>
    </CollapsibleContent>
  </Collapsible>

  <AlertDialog v-model:open="confirmReplaceOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ i18n.AGENT_TASK_REPLACE_STEPS_TITLE }}</AlertDialogTitle>
        <AlertDialogDescription>{{
          i18n.AGENT_TASK_REPLACE_STEPS_DESCRIPTION
        }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ i18n.COM_CANCEL }}</AlertDialogCancel>
        <AlertDialogAction @click="agentTasks.createStepsFromSession()">
          {{ i18n.AGENT_TASK_REPLACE_STEPS_CONFIRM }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import { useAgentTasks, type SaveTaskBlocker } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import { textInferenceBackendDisplayName } from '@/assets/js/store/textInference'
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
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import * as toast from '@/assets/js/toast'

const agentTasks = useAgentTasks()
const i18n = useI18N().state

const open = ref(false)
const saving = ref(false)
const confirmReplaceOpen = ref(false)

const hasSessionSteps = computed(() => agentTasks.stepsFromSession().length > 0)

const BLOCKER_KEYS: Record<SaveTaskBlocker, string> = {
  name: 'AGENT_TASK_BLOCKED_NAME',
  'no-steps': 'AGENT_TASK_BLOCKED_NO_STEPS',
  'empty-step': 'AGENT_TASK_BLOCKED_EMPTY_STEP',
  'no-folder': 'AGENT_TASK_BLOCKED_NO_FOLDER',
}

const blockerText = computed(() =>
  agentTasks.draftBlocker ? i18n[BLOCKER_KEYS[agentTasks.draftBlocker]] : '',
)

const summary = computed(() => {
  const template = agentTasks.draftTemplate
  const unset = i18n.AGENT_TASK_SUMMARY_UNSET
  const values: Record<string, string> = {
    folder: template.workspaceDir || unset,
    model: template.model || unset,
    backend: template.backend ? textInferenceBackendDisplayName[template.backend] : unset,
    count: String(template.capabilityCount),
  }
  // A replacer function, so a `$` in a folder or model name is kept as typed.
  return i18n.AGENT_TASK_SUMMARY.replace(/\{(\w+)\}/g, (token, name) => values[name] ?? token)
})

type NumberedKey =
  | 'AGENT_TASK_STEP_LABEL'
  | 'AGENT_TASK_STEP_TEXT'
  | 'AGENT_TASK_MOVE_STEP_UP'
  | 'AGENT_TASK_MOVE_STEP_DOWN'
  | 'AGENT_TASK_REMOVE_STEP'

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
  kind: 'up' | 'down' | 'remove'
  label: string
  icon: Component
  disabled: boolean
  run: () => void
}

function stepControls(id: string, index: number): StepControl[] {
  const last = agentTasks.draft.steps.length - 1
  return [
    {
      kind: 'up',
      label: numbered('AGENT_TASK_MOVE_STEP_UP', index),
      icon: ArrowUpIcon,
      disabled: index === 0,
      run: () => agentTasks.moveStep(id, 'up'),
    },
    {
      kind: 'down',
      label: numbered('AGENT_TASK_MOVE_STEP_DOWN', index),
      icon: ArrowDownIcon,
      disabled: index === last,
      run: () => agentTasks.moveStep(id, 'down'),
    },
    {
      kind: 'remove',
      label: numbered('AGENT_TASK_REMOVE_STEP', index),
      icon: TrashIcon,
      disabled: false,
      run: () => agentTasks.removeStep(id),
    },
  ]
}

function createFromSession(): void {
  if (agentTasks.draft.steps.length > 0) confirmReplaceOpen.value = true
  else agentTasks.createStepsFromSession()
}

async function save(): Promise<void> {
  saving.value = true
  try {
    const result = await agentTasks.saveDraft()
    if (result.ok) toast.success(i18n.AGENT_TASK_SAVED.replace('{name}', result.task.name))
  } finally {
    saving.value = false
  }
}
</script>
