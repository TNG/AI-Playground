<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  SAVE_TASK_BLOCKER_KEYS,
  useAgentTasks,
  type LibraryAgent,
} from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import { Button } from '@/components/ui/button'

const props = defineProps<{ agent: LibraryAgent }>()

const agentTasks = useAgentTasks()
const i18n = useI18N().state

const busy = ref(false)

const status = computed(() => {
  if (!props.agent.saved) return i18n.AGENT_LIBRARY_NOT_SAVED_YET
  return props.agent.hasDraft ? i18n.AGENT_LIBRARY_UNSAVED : undefined
})

const blocker = computed(() => {
  const reason = agentTasks.draftBlocker(props.agent.id)
  return reason ? i18n[SAVE_TASK_BLOCKER_KEYS[reason]] : undefined
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
</script>

<template>
  <footer class="flex flex-wrap items-center gap-2 border-t border-border px-6 py-3">
    <span class="flex-1" />
    <span v-if="status" class="text-xs text-muted-foreground">{{ status }}</span>
    <span v-if="blocker" role="status" class="text-xs text-amber-500">{{ blocker }}</span>
    <Button variant="secondary" size="sm" :disabled="busy || !agent.hasDraft" @click="discard">
      {{ i18n.AGENT_LIBRARY_DISCARD }}
    </Button>
    <Button size="sm" :disabled="busy || !agent.hasDraft || !!blocker" @click="save">
      {{ i18n.AGENT_LIBRARY_SAVE }}
    </Button>
  </footer>
</template>
