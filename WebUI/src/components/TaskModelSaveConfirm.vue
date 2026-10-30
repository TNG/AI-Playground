<template>
  <AlertDialog v-model:open="open">
    <AlertDialogContent class="max-h-[90vh] overflow-y-auto">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ i18n.AGENT_TASK_MODELS_CONFIRM_TITLE }}</AlertDialogTitle>
        <AlertDialogDescription>
          {{ i18n.AGENT_TASK_MODELS_CONFIRM_DESCRIPTION }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <TaskModelWarningList
        :warnings="state.warnings.value"
        :downloading="state.downloading.value"
        actions
        @download="download"
      />
      <p v-if="state.downloadError.value" role="alert" class="text-xs text-destructive">
        {{ state.downloadError.value }}
      </p>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ i18n.COM_CANCEL }}</AlertDialogCancel>
        <AlertDialogAction @click="emit('confirm')">
          {{ i18n.AGENT_TASK_MODELS_CONFIRM_SAVE }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
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
import TaskModelWarningList from '@/components/TaskModelWarningList.vue'
import type { TaskModelWarningsState } from '@/assets/js/taskModelWarnings'
import type { TaskModelWarning } from '@/lib/taskModelNeeds'

const props = defineProps<{ state: TaskModelWarningsState }>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{ confirm: [] }>()

const i18n = useI18N().state

/**
 * The download dialog is not a portal, so this modal would make it unclickable: step aside
 * while it runs, then save if nothing is left missing, or come back with what is.
 */
async function download(list: readonly TaskModelWarning[]): Promise<void> {
  open.value = false
  await props.state.download(list)
  if (props.state.missingCount.value === 0 && !props.state.downloadError.value) emit('confirm')
  else open.value = true
}
</script>
