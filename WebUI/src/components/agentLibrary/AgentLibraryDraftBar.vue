<script setup lang="ts">
import { computed, ref } from 'vue'
import { TrashIcon } from '@heroicons/vue/24/outline'
import {
  SAVE_TASK_BLOCKER_KEYS,
  useAgentTasks,
  type LibraryAgent,
} from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import { useUIStore } from '@/assets/js/store/ui'
import { Button } from '@/components/ui/button'
import { fillTemplate } from '@/lib/fillTemplate'
import { counted } from '@/lib/turnText'

const props = defineProps<{ agent: LibraryAgent }>()

const agentTasks = useAgentTasks()
const i18n = useI18N().state
const ui = useUIStore()

const busy = ref(false)
const confirmingDelete = ref(false)

const name = computed(() => ({ name: props.agent.name.trim() || i18n.AGENT_LIBRARY_UNNAMED }))

const status = computed(() => {
  if (!props.agent.saved) return i18n.AGENT_LIBRARY_NOT_SAVED_YET
  return props.agent.hasDraft ? i18n.AGENT_LIBRARY_UNSAVED : undefined
})

const blocker = computed(() => {
  const reason = agentTasks.draftBlocker(props.agent.id)
  return reason ? i18n[SAVE_TASK_BLOCKER_KEYS[reason]] : undefined
})

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

async function run(action: () => Promise<unknown>): Promise<void> {
  busy.value = true
  try {
    await action()
  } finally {
    busy.value = false
  }
}

const save = () => run(() => agentTasks.saveAgentDraft(props.agent.id))
const discard = () => run(() => agentTasks.discardAgentDraft(props.agent.id))

async function remove(): Promise<void> {
  confirmingDelete.value = false
  await run(async () => {
    if (await agentTasks.deleteTask(props.agent.id)) ui.selectLibraryAgent(undefined)
  })
}
</script>

<template>
  <footer class="flex flex-col gap-2 border-t border-border px-6 py-3">
    <div
      v-if="confirmingDelete"
      role="group"
      :aria-label="fillTemplate(i18n.AGENT_AGENTS_DELETE_LABEL, name)"
      class="flex items-center justify-between gap-2"
    >
      <span class="text-sm">{{ deleteQuestion }}</span>
      <div class="flex flex-none gap-2">
        <Button variant="secondary" size="sm" @click="confirmingDelete = false">
          {{ i18n.AGENT_AGENTS_CANCEL }}
        </Button>
        <Button variant="destructive" size="sm" :disabled="busy" @click="remove">
          {{ i18n.AGENT_AGENTS_DELETE }}
        </Button>
      </div>
    </div>
    <div v-else class="flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        class="text-destructive"
        :disabled="busy || !!deleteRefusal"
        :aria-label="fillTemplate(i18n.AGENT_AGENTS_DELETE_LABEL, name)"
        @click="confirmingDelete = true"
      >
        <TrashIcon class="size-4" />
        {{ i18n.AGENT_AGENTS_DELETE }}
      </Button>
      <span v-if="deleteRefusal" class="text-xs text-muted-foreground">{{ deleteRefusal }}</span>
      <span class="flex-1" />
      <span v-if="status" class="text-xs text-muted-foreground">{{ status }}</span>
      <span v-if="blocker" role="status" class="text-xs text-amber-500">{{ blocker }}</span>
      <Button variant="secondary" size="sm" :disabled="busy || !agent.hasDraft" @click="discard">
        {{ i18n.AGENT_LIBRARY_DISCARD }}
      </Button>
      <Button size="sm" :disabled="busy || !agent.hasDraft || !!blocker" @click="save">
        {{ i18n.AGENT_LIBRARY_SAVE }}
      </Button>
    </div>
  </footer>
</template>
