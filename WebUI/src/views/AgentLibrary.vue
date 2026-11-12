<script setup lang="ts">
// Full-window overlay over whatever Session is showing; it belongs to no Session.
import {
  computed,
  onMounted,
  onUnmounted,
  ref,
  watch,
  watchEffect,
  type ComponentPublicInstance,
} from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { XMarkIcon } from '@heroicons/vue/24/solid'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useAgentTrialRuns } from '@/assets/js/store/agentTrialRuns'
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

const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const agentTrialRuns = useAgentTrialRuns()
const i18n = useI18N().state
const ui = useUIStore()
const sessions = useSessions()

const root = ref<HTMLElement | null>(null)

type EditorTab = 'steps' | 'inferencing' | 'attributes' | 'schedules' | 'trial'

const TAB_LABELS = {
  steps: 'AGENT_LIBRARY_STEPS',
  inferencing: 'SESSION_TAB_INFERENCING',
  attributes: 'SESSION_TAB_ATTRIBUTES',
  schedules: 'AGENT_LIBRARY_SCHEDULES',
  trial: 'AGENT_LIBRARY_TRIAL_RUN',
} as const satisfies Record<EditorTab, string>

// Below this width the Trial Run pane does not fit beside the tabs, so it becomes one of them.
const wide = useMediaQuery('(min-width: 1024px)')

const tabs = computed((): EditorTab[] => [
  'steps',
  'inferencing',
  'attributes',
  'schedules',
  ...(wide.value ? [] : (['trial'] as const)),
])

const pickedTab = ref<EditorTab>('steps')
watch(
  () => ui.agentLibrary,
  (view) => {
    if (view?.showTrialRun && !wide.value) pickedTab.value = 'trial'
  },
  { immediate: true },
)
const shownTab = computed(() => (tabs.value.includes(pickedTab.value) ? pickedTab.value : 'steps'))

const tabRefs = new Map<EditorTab, HTMLElement>()

function setTabRef(tab: EditorTab, el: Element | ComponentPublicInstance | null) {
  if (el instanceof HTMLElement) tabRefs.set(tab, el)
  else tabRefs.delete(tab)
}

function onTabKeydown(event: KeyboardEvent) {
  const list = tabs.value
  const at = list.indexOf(shownTab.value)
  const target =
    event.key === 'ArrowRight'
      ? list[(at + 1) % list.length]
      : event.key === 'ArrowLeft'
        ? list[(at - 1 + list.length) % list.length]
        : event.key === 'Home'
          ? list[0]
          : event.key === 'End'
            ? list[list.length - 1]
            : undefined
  if (!target) return
  event.preventDefault()
  pickedTab.value = target
  tabRefs.get(target)?.focus()
}

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

watchEffect(() => {
  const paneOnScreen = wide.value || shownTab.value === 'trial'
  const run = selected.value && agentTrialRuns.trialRuns[selected.value.id]
  agentMode.setAgentLibraryShowing({
    open: true,
    trialRunSessionId: paneOnScreen && run ? run.harnessSessionId : null,
  })
})

onUnmounted(() => agentMode.setAgentLibraryShowing({ open: false, trialRunSessionId: null }))

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

      <main v-if="selected" :key="selected.id" class="flex min-w-0 flex-1">
        <div class="flex min-w-0 flex-1 flex-col">
          <div class="flex-none px-6 py-4">
            <AgentLibraryDetails :agent="selected" />
          </div>
          <div
            role="tablist"
            :aria-label="i18n.AGENT_LIBRARY_EDITOR_TABS"
            class="flex flex-none gap-1 border-b border-border px-4"
            @keydown="onTabKeydown"
          >
            <button
              v-for="tab in tabs"
              :id="`agent-library-tab-${tab}`"
              :key="tab"
              :ref="(el) => setTabRef(tab, el)"
              role="tab"
              type="button"
              :aria-selected="shownTab === tab"
              :aria-controls="`agent-library-tabpanel-${tab}`"
              :tabindex="shownTab === tab ? 0 : -1"
              class="relative -mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors"
              :class="
                shownTab === tab
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              "
              @click="pickedTab = tab"
            >
              {{ i18n[TAB_LABELS[tab]] }}
            </button>
          </div>
          <div
            v-for="tab in tabs"
            v-show="shownTab === tab"
            :id="`agent-library-tabpanel-${tab}`"
            :key="tab"
            role="tabpanel"
            :aria-labelledby="`agent-library-tab-${tab}`"
            class="flex min-h-0 flex-1 flex-col"
            :class="{ 'overflow-y-auto px-6 py-4': tab !== 'trial' }"
          >
            <AgentLibrarySteps v-if="tab === 'steps'" :agent="selected" />
            <AgentLibrarySettings
              v-else-if="tab === 'inferencing' || tab === 'attributes'"
              :agent="selected"
              :part="tab"
            />
            <AgentLibrarySchedules
              v-else-if="tab === 'schedules'"
              :agent="selected"
              :session-ref="sessionFilter"
            />
            <AgentLibraryTrialRun v-else :agent="selected" class="flex-1" />
          </div>
          <AgentLibraryDraftBar :agent="selected" />
        </div>
        <AgentLibraryTrialRun
          v-if="wide"
          :agent="selected"
          class="w-lg flex-none border-l border-border xl:w-2xl"
        />
      </main>
      <p v-else class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {{ sessionFilter ? i18n.AGENT_LIBRARY_SESSION_NONE : i18n.AGENT_LIBRARY_EMPTY }}
      </p>
    </div>
  </div>
</template>
