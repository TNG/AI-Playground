<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { PlayIcon, StopIcon } from '@heroicons/vue/24/solid'
import {
  SAVE_TASK_BLOCKER_KEYS,
  useAgentTasks,
  type LibraryAgent,
  type StartTrialRunResult,
} from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import type { PendingAudioTurn } from '@/assets/js/store/sessionAudio'
import type { PendingMediaTurn } from '@/assets/js/store/sessions'
import SessionTurnBlock from '@/components/SessionTurnBlock.vue'
import { Button } from '@/components/ui/button'
import { fillTemplate } from '@/lib/fillTemplate'
import { resolveMountedFolders } from '@/lib/mountedFolders'
import { trialRunItems } from '@/lib/trialRunTimeline'

const props = defineProps<{ agent: LibraryAgent }>()

const agentTasks = useAgentTasks()
const i18n = useI18N().state

/** The Step the Trial Run ends after; 0 runs every Step. */
const lastStep = ref(0)
const confirmingFolders = ref(false)
const refusal = ref<string>()

watch(
  () => props.agent.steps.length,
  (count) => {
    if (lastStep.value > count) lastStep.value = 0
  },
)

const inFlight = computed(() => agentTasks.trialRunInFlight(props.agent.id))

const folders = computed(() =>
  resolveMountedFolders(props.agent.settingsTemplate.mountedFolders ?? []),
)

const items = computed(() => {
  const view = agentTasks.trialRunView(props.agent.id)
  return view ? trialRunItems<PendingMediaTurn, PendingAudioTurn>(view) : []
})

function refusalText(result: Exclude<StartTrialRunResult, { ok: true }>): string | undefined {
  if (result.reason === 'no-steps' || result.reason === 'empty-step') {
    return i18n[SAVE_TASK_BLOCKER_KEYS[result.reason]]
  }
  return 'message' in result ? result.message : undefined
}

function requestRun(): void {
  refusal.value = undefined
  if (folders.value.length > 0) confirmingFolders.value = true
  else void start()
}

async function start(): Promise<void> {
  confirmingFolders.value = false
  const result = await agentTasks.startTrialRun(
    props.agent.id,
    lastStep.value > 0 ? { lastStep: lastStep.value } : {},
  )
  refusal.value = result.ok ? undefined : refusalText(result)
}
</script>

<template>
  <section class="flex max-w-3xl flex-col gap-3" aria-labelledby="agent-library-trial-heading">
    <div class="flex flex-col gap-1">
      <h2 id="agent-library-trial-heading" class="text-sm font-semibold">
        {{ i18n.AGENT_LIBRARY_TRIAL_RUN }}
      </h2>
      <p class="text-xs text-muted-foreground">{{ i18n.AGENT_LIBRARY_TRIAL_RUN_HINT }}</p>
    </div>

    <div
      v-if="confirmingFolders"
      role="group"
      :aria-label="i18n.AGENT_LIBRARY_TRIAL_RUN"
      class="flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2"
    >
      <p class="text-sm">
        {{
          fillTemplate(i18n.AGENT_LIBRARY_TRIAL_RUN_FOLDERS_NOTICE, {
            folders: folders.map((folder) => folder.hostPath).join(', '),
          })
        }}
      </p>
      <div class="flex justify-end gap-2">
        <Button variant="secondary" size="sm" @click="confirmingFolders = false">
          {{ i18n.AGENT_AGENTS_CANCEL }}
        </Button>
        <Button size="sm" :disabled="inFlight" @click="start">
          {{ i18n.AGENT_LIBRARY_TRIAL_RUN_FOLDERS_CONFIRM }}
        </Button>
      </div>
    </div>

    <div v-else class="flex flex-wrap items-center gap-2">
      <label class="flex items-center gap-2 text-sm">
        {{ i18n.AGENT_LIBRARY_TRIAL_RUN_STOP_AFTER }}
        <select
          v-model.number="lastStep"
          :disabled="inFlight"
          class="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option :value="0">{{ i18n.AGENT_LIBRARY_TRIAL_RUN_LAST_STEP }}</option>
          <option v-for="(_step, index) in agent.steps" :key="index" :value="index + 1">
            {{ fillTemplate(i18n.AGENT_LIBRARY_TRIAL_RUN_STEP, { number: String(index + 1) }) }}
          </option>
        </select>
      </label>
      <Button
        v-if="inFlight"
        variant="secondary"
        size="sm"
        @click="agentTasks.stopTrialRun(agent.id)"
      >
        <StopIcon class="size-4" />
        {{ i18n.AGENT_LIBRARY_TRIAL_RUN_STOP }}
      </Button>
      <Button v-else size="sm" @click="requestRun">
        <PlayIcon class="size-4" />
        {{ i18n.AGENT_LIBRARY_TRIAL_RUN_START }}
      </Button>
      <span v-if="refusal" role="status" class="text-xs text-amber-500">{{ refusal }}</span>
    </div>

    <div v-if="items.length > 0" class="flex flex-col gap-6">
      <SessionTurnBlock
        v-for="item in items"
        :key="item.id"
        :item="item"
        :chat-key="`trial-run:${agent.id}`"
      />
    </div>
    <p v-else-if="!inFlight" class="text-xs text-muted-foreground">
      {{ i18n.AGENT_LIBRARY_TRIAL_RUN_EMPTY }}
    </p>
  </section>
</template>
