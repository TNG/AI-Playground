<script setup lang="ts">
import { computed, ref } from 'vue'
import { EllipsisVerticalIcon } from '@heroicons/vue/24/outline'
import { useAgentTasks, type LibraryAgent } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import { useUIStore } from '@/assets/js/store/ui'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { fillTemplate } from '@/lib/fillTemplate'
import { counted } from '@/lib/turnText'

const props = defineProps<{ agent: LibraryAgent; selected: boolean }>()

const agentTasks = useAgentTasks()
const i18n = useI18N().state
const ui = useUIStore()

const menuOpen = ref(false)
const busy = ref(false)

const name = computed(() => ({ name: props.agent.name.trim() || i18n.AGENT_LIBRARY_UNNAMED }))

const running = computed(() => agentTasks.runningSessionCount(props.agent.id))

const deleteRefusal = computed(() =>
  running.value > 0
    ? counted(running.value, [
        i18n.AGENT_AGENTS_DELETE_RUNNING_ONE,
        i18n.AGENT_AGENTS_DELETE_RUNNING_MANY,
      ])
    : undefined,
)

const deleteQuestion = computed(() => {
  const scheduled = agentTasks.scheduledSessionCount(props.agent.id)
  const question =
    scheduled > 0
      ? counted(scheduled, [
          i18n.AGENT_AGENTS_DELETE_CONFIRM_SCHEDULED_ONE,
          i18n.AGENT_AGENTS_DELETE_CONFIRM_SCHEDULED_MANY,
        ])
      : i18n.AGENT_AGENTS_DELETE_CONFIRM
  return fillTemplate(question, name.value)
})

async function remove(): Promise<void> {
  menuOpen.value = false
  busy.value = true
  try {
    if ((await agentTasks.deleteTask(props.agent.id)) && props.selected) {
      ui.selectLibraryAgent(undefined)
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <DropdownMenu v-model:open="menuOpen">
    <DropdownMenuTrigger as-child>
      <Button
        variant="ghost"
        size="icon"
        class="h-6 w-6 flex-none"
        :aria-label="fillTemplate(i18n.AGENT_LIBRARY_AGENT_OPTIONS, name)"
      >
        <EllipsisVerticalIcon class="size-4" aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="end"
      class="min-w-28 max-w-64"
      :onCloseAutoFocus="(event) => event.preventDefault?.()"
    >
      <AlertDialog @update:open="(open) => !open && (menuOpen = false)">
        <AlertDialogTrigger as-child>
          <DropdownMenuItem
            class="text-destructive"
            :disabled="busy || !!deleteRefusal"
            @select="(event: Event) => event.preventDefault()"
          >
            {{ i18n.AGENT_AGENTS_DELETE }}
          </DropdownMenuItem>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{{
              fillTemplate(i18n.AGENT_AGENTS_DELETE_LABEL, name)
            }}</AlertDialogTitle>
            <AlertDialogDescription>{{ deleteQuestion }}</AlertDialogDescription>
            <p v-if="deleteRefusal" role="status" class="text-sm text-amber-500">
              {{ deleteRefusal }}
            </p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{{ i18n.AGENT_AGENTS_CANCEL }}</AlertDialogCancel>
            <AlertDialogAction :disabled="busy || !!deleteRefusal" @click="remove">
              {{ i18n.AGENT_AGENTS_DELETE }}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <p v-if="deleteRefusal" class="px-2 pb-1.5 text-xs text-muted-foreground">
        {{ deleteRefusal }}
      </p>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
