<template>
  <AlertDialog :open="asking" @update:open="(open) => open || answer(false)">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ i18n.AGENT_TASK_DISCARD_TITLE }}</AlertDialogTitle>
        <AlertDialogDescription>{{ description }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <!-- Plain buttons: the dialog's open state is the pending question, so only
             answering closes it. -->
        <Button variant="outline" @click="answer(false)">{{ i18n.COM_CANCEL }}</Button>
        <Button variant="destructive" @click="answer(true)">
          {{ i18n.AGENT_TASK_EDIT_DISCARD }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useTaskEditLeaveGuard } from '@/assets/js/taskEditLeaveGuard'

const agentTasks = useAgentTasks()
const i18n = useI18N().state
const { asking, answer } = useTaskEditLeaveGuard()

const description = computed(() =>
  i18n.AGENT_TASK_DISCARD_DESCRIPTION.replace('{name}', agentTasks.editedTask?.name ?? ''),
)
</script>
