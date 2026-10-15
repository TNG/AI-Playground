<template>
  <div v-if="draft" class="flex flex-col gap-6 p-1">
    <div
      role="group"
      :aria-label="bannerText"
      class="flex flex-col gap-3 rounded-md border border-primary/60 bg-primary/10 py-3 pl-3 pr-10"
    >
      <span class="text-sm font-medium text-foreground break-words">{{ bannerText }}</span>
      <div class="flex flex-wrap items-center gap-2">
        <Button
          class="px-3 py-1.5 rounded text-sm"
          :disabled="!!agentTasks.editBlocker || saving"
          :aria-describedby="describedBy"
          @click="save"
        >
          {{ i18n.AGENT_TASK_EDIT_SAVE }}
        </Button>
        <Button variant="secondary" class="px-3 py-1.5 rounded text-sm" @click="discard">
          {{ i18n.AGENT_TASK_EDIT_DISCARD }}
        </Button>
      </div>
      <p v-if="blockerText" id="task-edit-save-blocker" class="text-xs text-amber-500">
        {{ blockerText }}
      </p>
      <p v-if="saveError" id="task-edit-save-error" role="alert" class="text-xs text-destructive">
        {{ saveError }}
      </p>
      <p v-if="running" class="text-xs text-muted-foreground">
        {{ i18n.AGENT_TASK_EDIT_RUNNING_NOTE }}
      </p>
    </div>

    <div class="flex flex-col gap-1.5">
      <Label for="task-edit-name">{{ i18n.AGENT_TASK_NAME }}</Label>
      <Input id="task-edit-name" v-model="draft.name" autocomplete="off" />
    </div>

    <div class="flex flex-col gap-2">
      <Label>{{ i18n.AGENT_TASK_EDIT_FOLDER }}</Label>
      <div class="flex items-center gap-3">
        <Button variant="secondary" class="px-3 py-1.5 rounded text-sm" @click="pickFolder">
          {{ i18n.AGENT_TASK_EDIT_SELECT_FOLDER }}
        </Button>
        <span v-if="draft.workspaceDir" class="text-sm text-muted-foreground break-all">
          {{ draft.workspaceDir }}
        </span>
        <span v-else class="text-sm text-muted-foreground italic">
          {{ i18n.AGENT_TASK_EDIT_NO_FOLDER }}
        </span>
      </div>
      <p class="text-xs text-muted-foreground">{{ i18n.AGENT_TASK_EDIT_FOLDER_HINT }}</p>
    </div>

    <TaskStepsEditor v-model:steps="draft.steps" id-prefix="task-edit" />

    <SettingsTaskTemplate :workspace-dir="draft.workspaceDir" :template="draft.settingsTemplate" />

    <TaskModelWarnings :template="draft.settingsTemplate" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { SAVE_TASK_BLOCKER_KEYS, useAgentTasks } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import SettingsTaskTemplate from '@/components/SettingsTaskTemplate.vue'
import TaskModelWarnings from '@/components/TaskModelWarnings.vue'
import TaskStepsEditor from '@/components/TaskStepsEditor.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import * as toast from '@/assets/js/toast'

const agentTasks = useAgentTasks()
const i18n = useI18N().state

const saving = ref(false)
/** Why the last Save stored nothing, when its chat model was not downloaded. */
const saveError = ref('')
watch(
  () => agentTasks.editingTaskId,
  () => (saveError.value = ''),
)

const draft = computed(() => agentTasks.editDraft)

const bannerText = computed(() =>
  i18n.AGENT_TASK_EDITING.replace('{name}', agentTasks.editedTask?.name ?? ''),
)

const running = computed(() => {
  const id = agentTasks.editingTaskId
  return id !== null && 'running' in agentTasks.taskState(id)
})

const blockerText = computed(() =>
  agentTasks.editBlocker ? i18n[SAVE_TASK_BLOCKER_KEYS[agentTasks.editBlocker]] : '',
)

const describedBy = computed(
  () =>
    [blockerText.value && 'task-edit-save-blocker', saveError.value && 'task-edit-save-error']
      .filter(Boolean)
      .join(' ') || undefined,
)

// Its own dialog: the session sidebar's picker adopts the folder for the Open Session.
async function pickFolder(): Promise<void> {
  const picking = draft.value
  const result = await window.electronAPI.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: i18n.AGENT_TASK_EDIT_FOLDER_DIALOG_TITLE,
  })
  if (result.canceled || result.filePaths.length === 0) return
  if (picking && picking === draft.value) picking.workspaceDir = result.filePaths[0]
}

async function save(): Promise<void> {
  saving.value = true
  try {
    saveError.value = ''
    const result = await agentTasks.saveEdit()
    if (!result.ok && 'message' in result) saveError.value = result.message
    if (result.ok) toast.success(i18n.AGENT_TASK_EDIT_SAVED.replace('{name}', result.task.name))
  } finally {
    saving.value = false
  }
}

function discard(): void {
  agentTasks.discardEdit()
}
</script>
