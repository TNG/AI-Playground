<template>
  <TooltipProvider :delay-duration="200">
    <div role="group" :aria-label="i18n.AGENT_AGENTS_NAME" class="flex flex-col gap-2">
      <div class="flex items-center gap-1.5">
        <input
          id="agent-save-bar-name"
          v-model="name"
          autocomplete="off"
          :aria-label="i18n.AGENT_AGENTS_NAME"
          :aria-describedby="status ? 'agent-save-bar-status' : undefined"
          :placeholder="i18n.AGENT_AGENTS_UNTITLED"
          class="flex h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm font-semibold text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
          @keydown.enter.prevent="savePrimary"
        />
        <Button size="sm" class="h-8 flex-none" :disabled="!canSave" @click="savePrimary">
          {{ i18n.AGENT_AGENTS_SAVE }}
        </Button>
        <Button
          v-if="loaded && dirty"
          variant="secondary"
          size="sm"
          class="h-8 flex-none"
          :disabled="!!blockerTextFor(newCopyName) || saving"
          @click="requestSave({ kind: 'new', name: newCopyName })"
        >
          {{ i18n.AGENT_AGENTS_SAVE_AS_NEW }}
        </Button>
        <AgentRowAction
          v-if="loaded"
          :label="i18n.AGENT_AGENTS_NEW"
          :disabled="agentMode.processing"
          @click="agentMode.newSession()"
        >
          <PlusIcon class="size-4" />
        </AgentRowAction>
      </div>
      <p
        v-if="status"
        id="agent-save-bar-status"
        class="text-xs"
        :class="blocker ? 'text-muted-foreground' : 'text-amber-500'"
      >
        {{ status }}
      </p>
      <TaskModelWarnings v-if="dirty" :state="modelWarnings" />
    </div>
  </TooltipProvider>

  <TaskModelSaveConfirm
    v-model:open="confirmModelsOpen"
    :state="modelWarnings"
    @confirm="save(pendingSave)"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { PlusIcon } from '@heroicons/vue/24/outline'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { SAVE_TASK_BLOCKER_KEYS, useAgentTasks } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import AgentRowAction from '@/components/AgentRowAction.vue'
import TaskModelSaveConfirm from '@/components/TaskModelSaveConfirm.vue'
import TaskModelWarnings from '@/components/TaskModelWarnings.vue'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useTaskModelWarnings } from '@/assets/js/taskModelWarnings'
import * as toast from '@/assets/js/toast'

const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const i18n = useI18N().state

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (token, key) => (key in values ? values[key] : token))
}

const loaded = computed(() => agentTasks.openSessionTask)
const name = ref('')

watch(
  () => [loaded.value?.id, loaded.value?.name],
  () => {
    name.value = loaded.value?.name ?? ''
  },
  { immediate: true },
)

const renamed = computed(() => !!loaded.value && name.value.trim() !== loaded.value.name)
const setupChanged = computed(() => agentTasks.openSessionAgentChanged)
const dirty = computed(() => !loaded.value || setupChanged.value || renamed.value)

/** A copy keeps a typed name; untouched, it is named after the Agent it was loaded from. */
const newCopyName = computed(() =>
  renamed.value || !loaded.value
    ? name.value
    : fill(i18n.AGENT_AGENTS_COPY_NAME, { name: loaded.value.name }),
)

function blockerTextFor(candidate: string): string {
  const found = agentTasks.saveAgentBlocker(candidate)
  return found ? i18n[SAVE_TASK_BLOCKER_KEYS[found]] : ''
}

const blocker = computed(() => (dirty.value ? blockerTextFor(name.value) : ''))
const status = computed(
  () => blocker.value || (loaded.value && dirty.value ? i18n.AGENT_AGENTS_CHANGED : ''),
)

const saving = ref(false)
const canSave = computed(() => dirty.value && !blocker.value && !saving.value)

type PendingSave = { kind: 'new' | 'update' | 'rename'; name: string }

const confirmModelsOpen = ref(false)
const pendingSave = ref<PendingSave>({ kind: 'new', name: '' })

const modelWarnings = useTaskModelWarnings(() => agentMode.openSessionSettings, {
  chatModelSteps: () => agentMode.openSteps,
})

function savePrimary(): void {
  if (!canSave.value) return
  const kind = !loaded.value ? 'new' : setupChanged.value ? 'update' : 'rename'
  requestSave({ kind, name: name.value })
}

/** Missing models do not block saving, but the user confirms them before the Agent is stored. */
function requestSave(request: PendingSave): void {
  pendingSave.value = request
  if (request.kind !== 'rename' && modelWarnings.missingCount.value > 0) {
    confirmModelsOpen.value = true
  } else {
    void save(request)
  }
}

async function save({ kind, name: chosen }: PendingSave): Promise<void> {
  const target = loaded.value
  saving.value = true
  try {
    const result =
      kind === 'update' && target
        ? await agentTasks.updateAgent(target.id, chosen)
        : kind === 'rename' && target
          ? await agentTasks.renameAgent(target.id, chosen)
          : await agentTasks.saveAgent(chosen)
    if (!result.ok) return
    name.value = result.task.name
    toast.success(fill(i18n.AGENT_AGENTS_SAVED, { name: result.task.name }))
  } finally {
    saving.value = false
  }
}
</script>
