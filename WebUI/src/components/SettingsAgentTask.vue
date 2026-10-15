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

      <TaskStepsEditor v-model:steps="agentTasks.draft.steps" id-prefix="agent-task" />

      <p class="text-xs text-muted-foreground break-all">{{ summary }}</p>

      <TaskModelWarnings :state="modelWarnings" />

      <div class="flex flex-col gap-1.5">
        <Button
          class="self-start px-3 py-1.5 rounded text-sm"
          :disabled="!!agentTasks.draftBlocker || saving"
          :aria-describedby="describedBy"
          @click="requestSave"
        >
          {{ i18n.AGENT_TASK_SAVE }}
        </Button>
        <p v-if="blockerText" id="agent-task-save-blocker" class="text-xs text-amber-500">
          {{ blockerText }}
        </p>
        <p
          v-if="saveError"
          id="agent-task-save-error"
          role="alert"
          class="text-xs text-destructive"
        >
          {{ saveError }}
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

  <TaskModelSaveConfirm v-model:open="confirmModelsOpen" :state="modelWarnings" @confirm="save" />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDownIcon } from '@heroicons/vue/24/outline'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { SAVE_TASK_BLOCKER_KEYS, useAgentTasks } from '@/assets/js/store/agentTasks'
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
import TaskModelSaveConfirm from '@/components/TaskModelSaveConfirm.vue'
import TaskModelWarnings from '@/components/TaskModelWarnings.vue'
import TaskStepsEditor from '@/components/TaskStepsEditor.vue'
import { useTaskModelWarnings } from '@/assets/js/taskModelWarnings'
import * as toast from '@/assets/js/toast'

const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const i18n = useI18N().state

const open = ref(false)
const saving = ref(false)
/** Why the last Save stored nothing, when its chat model was not downloaded. */
const saveError = ref('')
const confirmReplaceOpen = ref(false)
const confirmModelsOpen = ref(false)

const modelWarnings = useTaskModelWarnings(() => agentMode.openSessionSettings)

const hasSessionSteps = computed(() => agentTasks.stepsFromSession().length > 0)

const blockerText = computed(() =>
  agentTasks.draftBlocker ? i18n[SAVE_TASK_BLOCKER_KEYS[agentTasks.draftBlocker]] : '',
)

const describedBy = computed(
  () =>
    [blockerText.value && 'agent-task-save-blocker', saveError.value && 'agent-task-save-error']
      .filter(Boolean)
      .join(' ') || undefined,
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

function createFromSession(): void {
  if (agentTasks.draft.steps.length > 0) confirmReplaceOpen.value = true
  else agentTasks.createStepsFromSession()
}

/** Missing models do not block saving, but the user confirms them before the Task is stored. */
function requestSave(): void {
  if (modelWarnings.missingCount.value > 0) confirmModelsOpen.value = true
  else void save()
}

async function save(): Promise<void> {
  saving.value = true
  try {
    saveError.value = ''
    const result = await agentTasks.saveDraft()
    if (!result.ok && 'message' in result) saveError.value = result.message
    if (result.ok) toast.success(i18n.AGENT_TASK_SAVED.replace('{name}', result.task.name))
  } finally {
    saving.value = false
  }
}
</script>
