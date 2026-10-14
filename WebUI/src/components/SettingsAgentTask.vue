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
        @click="agentTasks.createStepsFromSession()"
      >
        {{ i18n.AGENT_TASK_CREATE_FROM_SESSION }}
      </Button>

      <div class="flex flex-col gap-1.5">
        <Label for="agent-task-name">{{ i18n.AGENT_TASK_NAME }}</Label>
        <Input id="agent-task-name" v-model="agentTasks.draft.name" autocomplete="off" />
      </div>

      <div class="flex flex-col gap-1.5">
        <Label id="agent-task-steps">{{ i18n.AGENT_TASK_STEPS }}</Label>
        <ol
          v-if="agentTasks.draft.steps.length > 0"
          aria-labelledby="agent-task-steps"
          class="flex flex-col gap-2"
        >
          <li
            v-for="(step, index) in agentTasks.draft.steps"
            :key="step.id"
            :aria-label="stepLabel(index)"
            class="flex flex-col gap-0.5 rounded-sm border border-border px-2 py-1.5"
          >
            <span class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {{ stepLabel(index) }}
            </span>
            <span class="text-xs text-foreground whitespace-pre-wrap break-words">
              {{ step.prompt }}
            </span>
          </li>
        </ol>
        <p v-else class="text-xs text-muted-foreground italic">
          {{ i18n.AGENT_TASK_NO_STEPS_YET }}
        </p>
      </div>

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
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDownIcon } from '@heroicons/vue/24/outline'
import { useAgentTasks, type SaveTaskBlocker } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import * as toast from '@/assets/js/toast'

const agentTasks = useAgentTasks()
const i18n = useI18N().state

const open = ref(false)
const saving = ref(false)

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

function stepLabel(index: number): string {
  return i18n.AGENT_TASK_STEP_LABEL.replace('{number}', String(index + 1))
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
