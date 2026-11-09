<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { PlayIcon, StopIcon } from '@heroicons/vue/24/solid'
import { SAVE_TASK_BLOCKER_KEYS, type LibraryAgent } from '@/assets/js/store/agentTasks'
import { useAgentTrialRuns, type StartTrialRunResult } from '@/assets/js/store/agentTrialRuns'
import { useI18N } from '@/assets/js/store/i18n'
import type { PendingAudioTurn } from '@/assets/js/store/sessionAudio'
import type { PendingMediaTurn } from '@/assets/js/store/sessions'
import SessionTurnBlock from '@/components/SessionTurnBlock.vue'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { fillTemplate } from '@/lib/fillTemplate'
import { resolveMountedFolders } from '@/lib/mountedFolders'
import { trialRunItems } from '@/lib/trialRunTimeline'
import { useStickToBottom } from '@/lib/useStickToBottom'

const props = defineProps<{ agent: LibraryAgent }>()

const agentTrialRuns = useAgentTrialRuns()
const i18n = useI18N().state

const input = ref('')
const confirmingFolders = ref(false)
const refusal = ref<string>()
const panel = ref<HTMLElement | null>(null)

const inFlight = computed(() => agentTrialRuns.trialRunInFlight(props.agent.id))

const folders = computed(() =>
  resolveMountedFolders(props.agent.settingsTemplate.mountedFolders ?? []),
)

const items = computed(() => {
  const view = agentTrialRuns.trialRunView(props.agent.id)
  return view ? trialRunItems<PendingMediaTurn, PendingAudioTurn>(view) : []
})

const { scrollToBottom } = useStickToBottom(panel)
onMounted(() => scrollToBottom(false))

function refusalText(result: Exclude<StartTrialRunResult, { ok: true }>): string | undefined {
  if (result.reason === 'no-steps' || result.reason === 'empty-step') {
    return i18n[SAVE_TASK_BLOCKER_KEYS[result.reason]]
  }
  return 'message' in result ? result.message : undefined
}

function requestRun(): void {
  if (inFlight.value) return
  refusal.value = undefined
  if (folders.value.length > 0) confirmingFolders.value = true
  else void start()
}

async function start(): Promise<void> {
  confirmingFolders.value = false
  const typed = input.value.trim()
  const result = await agentTrialRuns.startTrialRun(props.agent.id, typed ? { input: typed } : {})
  refusal.value = result.ok ? undefined : refusalText(result)
  if (result.ok) {
    input.value = ''
    scrollToBottom(false)
  }
}
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-col" aria-labelledby="agent-library-trial-heading">
    <header class="flex flex-none flex-col gap-1 border-b border-border px-4 py-3">
      <h2 id="agent-library-trial-heading" class="text-sm font-semibold">
        {{ i18n.AGENT_LIBRARY_TRIAL_RUN }}
      </h2>
      <p class="text-xs text-muted-foreground">{{ i18n.AGENT_LIBRARY_TRIAL_RUN_HINT }}</p>
    </header>

    <div
      ref="panel"
      role="log"
      :aria-label="i18n.AGENT_LIBRARY_TRIAL_RUN"
      class="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 py-4"
    >
      <div v-if="items.length > 0" class="flex w-full flex-col gap-6">
        <SessionTurnBlock
          v-for="item in items"
          :key="item.id"
          :item="item"
          :chat-key="`trial-run:${agent.id}`"
        />
      </div>
      <p
        v-else-if="!inFlight"
        class="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground"
      >
        {{ i18n.AGENT_LIBRARY_TRIAL_RUN_EMPTY }}
      </p>
    </div>

    <footer class="flex flex-none flex-col gap-2 border-t border-border px-4 py-3">
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

      <Textarea
        :model-value="input"
        rows="2"
        class="max-h-40 min-h-0 resize-none text-sm"
        :aria-label="i18n.AGENT_LIBRARY_TRIAL_RUN_INPUT"
        :placeholder="i18n.AGENT_LIBRARY_TRIAL_RUN_INPUT"
        :disabled="inFlight"
        @update:model-value="(text) => (input = String(text))"
        @keydown.enter.exact.prevent="requestRun"
      />

      <div class="flex flex-wrap items-center gap-2">
        <span v-if="refusal" role="status" class="min-w-0 flex-1 text-xs text-amber-500">
          {{ refusal }}
        </span>
        <Button
          v-if="inFlight"
          variant="secondary"
          size="sm"
          class="ml-auto"
          @click="agentTrialRuns.stopTrialRun(agent.id)"
        >
          <StopIcon class="size-4" />
          {{ i18n.AGENT_LIBRARY_TRIAL_RUN_STOP }}
        </Button>
        <Button v-else size="sm" class="ml-auto" :disabled="confirmingFolders" @click="requestRun">
          <PlayIcon class="size-4" />
          {{ i18n.AGENT_LIBRARY_TRIAL_RUN_START }}
        </Button>
      </div>
    </footer>
  </section>
</template>
