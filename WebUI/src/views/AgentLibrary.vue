<script setup lang="ts">
// Full-window overlay over whatever Session is showing; it belongs to no Session.
import { computed, onMounted, ref } from 'vue'
import { XMarkIcon } from '@heroicons/vue/24/solid'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import { useSessions } from '@/assets/js/store/sessions'
import { useUIStore } from '@/assets/js/store/ui'
import AgentLibraryDetails from '@/components/agentLibrary/AgentLibraryDetails.vue'
import AgentLibraryDraftBar from '@/components/agentLibrary/AgentLibraryDraftBar.vue'
import AgentLibraryList from '@/components/agentLibrary/AgentLibraryList.vue'
import AgentLibrarySchedules from '@/components/agentLibrary/AgentLibrarySchedules.vue'
import AgentLibrarySettings from '@/components/agentLibrary/AgentLibrarySettings.vue'
import AgentLibrarySteps from '@/components/agentLibrary/AgentLibrarySteps.vue'
import AgentLibraryTrialRun from '@/components/agentLibrary/AgentLibraryTrialRun.vue'
import { fillTemplate } from '@/lib/fillTemplate'

const emit = defineEmits<{ (e: 'close'): void }>()

const agentTasks = useAgentTasks()
const i18n = useI18N().state
const ui = useUIStore()
const sessions = useSessions()

const root = ref<HTMLElement | null>(null)

const sessionFilter = computed(() => ui.agentLibrary?.sessionRef)

const sessionFilterLabel = computed(() => {
  const ref = sessionFilter.value
  if (!ref) return ''
  const session = sessions.sessions[ref]?.title || i18n.SESSIONS_UNTITLED
  return fillTemplate(i18n.AGENT_LIBRARY_SESSION_FILTER, { session })
})

const listed = computed(() => {
  const ref = sessionFilter.value
  if (!ref) return agentTasks.libraryAgents
  const scheduled = new Set(agentTasks.agentsScheduledIn(ref))
  return agentTasks.libraryAgents.filter((agent) => scheduled.has(agent.id))
})

const selected = computed(() => {
  const agents = listed.value
  const wanted = ui.agentLibrary?.agentId
  return agents.find((agent) => agent.id === wanted) ?? agents[0]
})

onMounted(() => {
  // Escape is handled on the overlay, which receives no key events until something in it has focus.
  root.value?.focus()
})
</script>

<template>
  <div
    ref="root"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    :aria-label="i18n.AGENT_LIBRARY_TITLE"
    class="absolute inset-0 z-10 flex flex-col bg-background text-foreground focus:outline-none"
    @keydown.esc="emit('close')"
  >
    <header class="flex items-center justify-between border-b border-border px-4 py-3">
      <h1 class="text-lg font-semibold">{{ i18n.AGENT_LIBRARY_TITLE }}</h1>
      <button
        type="button"
        :aria-label="i18n.AGENT_LIBRARY_CLOSE"
        class="flex size-7 items-center justify-center rounded hover:bg-muted"
        @click="emit('close')"
      >
        <XMarkIcon class="size-5" />
      </button>
    </header>

    <div
      v-if="sessionFilter"
      class="flex items-center gap-3 border-b border-border px-4 py-2 text-sm"
    >
      <span class="min-w-0 truncate">{{ sessionFilterLabel }}</span>
      <button
        type="button"
        class="flex-none text-primary hover:underline"
        @click="ui.clearLibrarySessionFilter()"
      >
        {{ i18n.AGENT_LIBRARY_SESSION_FILTER_CLEAR }}
      </button>
    </div>

    <div class="flex min-h-0 flex-1">
      <AgentLibraryList :selected-id="selected?.id" :agents="listed" />

      <main v-if="selected" :key="selected.id" class="flex min-w-0 flex-1 flex-col">
        <div class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-4">
          <AgentLibraryDetails :agent="selected" />
          <AgentLibrarySteps :agent="selected" />
          <AgentLibrarySettings :agent="selected" />
          <AgentLibraryTrialRun :agent="selected" />
          <AgentLibrarySchedules :agent="selected" :session-ref="sessionFilter" />
        </div>
        <AgentLibraryDraftBar :agent="selected" />
      </main>
      <p v-else class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {{ sessionFilter ? i18n.AGENT_LIBRARY_SESSION_NONE : i18n.AGENT_LIBRARY_EMPTY }}
      </p>
    </div>
  </div>
</template>
