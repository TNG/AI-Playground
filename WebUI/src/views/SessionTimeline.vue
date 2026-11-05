<template>
  <ScrollToBottomButton v-if="showScrollButton" @click="scrollToBottom()" />
  <div
    id="chatPanel"
    ref="panel"
    class="flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 flex flex-col relative"
  >
    <!-- Game Agent works on one game at a time, and what to do with that game
         belongs next to it, reachable once the timeline has scrolled past it. -->
    <div v-if="showsGameBar" class="sticky top-0 z-5 flex justify-end pl-32 pr-32">
      <GameBar />
    </div>
    <template v-if="items.length === 0 && !chatBusy">
      <AgentEmptyState v-if="inAgentMode && !agentMode.processing" />
      <div v-else class="flex-1 flex items-center justify-center text-muted-foreground text-center">
        {{ languages.SESSION_TIMELINE_EMPTY }}
      </div>
    </template>
    <div v-else class="w-full flex flex-col gap-6">
      <SessionTurnBlock
        v-for="item in items"
        :key="item.id"
        :item="item"
        :last-chat-message-id="lastChatMessageId"
        :chat-key="chatKey"
        @resend="agentMode.resendNotRun()"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useActivities } from '@/assets/js/store/activities'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useArtifactRuns } from '@/assets/js/store/artifactRuns'
import { useConfirmations } from '@/assets/js/store/confirmations'
import { useConversations } from '@/assets/js/store/conversations'
import { useI18N } from '@/assets/js/store/i18n'
import { useMediaAgentRuns } from '@/assets/js/store/mediaAgentRuns'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useSessionAudio } from '@/assets/js/store/sessionAudio'
import { useSessions } from '@/assets/js/store/sessions'
import AgentEmptyState from '@/components/AgentEmptyState.vue'
import GameBar from '@/components/GameBar.vue'
import ScrollToBottomButton from '@/components/ScrollToBottomButton.vue'
import SessionTurnBlock from '@/components/SessionTurnBlock.vue'
import { sessionChatKey } from '@/lib/sessionChat'
import { sessionTimelineItems } from '@/lib/sessionTimeline'
import type { LiveChatStatus, MediaStepStatus } from '@/lib/turnTypes'
import { useStickToBottom } from '@/lib/useStickToBottom'

/**
 * The main area for a Session in every mode: each turn of its timeline, settled or
 * still running, drawn the same way whichever preset is active.
 */
const sessions = useSessions()
const chat = useOpenAiCompatibleChat()
const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const sessionAudio = useSessionAudio()
const promptStore = usePromptStore()
const activities = useActivities()
const confirmations = useConfirmations()
const conversations = useConversations()
const artifactRuns = useArtifactRuns()
const mediaRuns = useMediaAgentRuns()
const languages = useI18N().state
const panel = ref<HTMLElement | null>(null)

const chatKey = computed(() => sessionChatKey(sessions.openSessionId ?? ''))
const chatLive = computed(() => {
  if (!sessions.openSessionId) return []
  if (conversations.activeKey === chatKey.value) return chat.messages ?? []
  return chat.getMessagesForKey(chatKey.value) ?? []
})
const agentLive = computed(() =>
  sessions.openSessionId ? agentMode.liveTurnsIn(sessions.openSessionId) : [],
)

const chatActivity = computed(() => activities.chatActivity(chatKey.value, ['generation']))
const chatConfirmation = computed(() => confirmations.forConversation(chatKey.value) !== null)
const chatBusy = computed(() => !!chatActivity.value || chatConfirmation.value)

const chatStatus = computed<LiveChatStatus>(() => {
  const activity = chatActivity.value
  return {
    running: chatConfirmation.value || chat.answeringIn(chatKey.value),
    activity: activity && {
      label: activity.label,
      ...(activity.progress !== undefined ? { progress: activity.progress } : {}),
      ...(activity.category === 'browsing' ? { browsing: true } : {}),
    },
    questionKey: chatKey.value,
    error: chat.turnErrorIn(chatKey.value),
  }
})

const mediaSteps = computed(() =>
  Object.fromEntries(
    mediaRuns.runs.flatMap((run) => {
      const step = run.steps.findLast((candidate) => candidate.state === 'running')
      if (!step) return []
      const status: MediaStepStatus = {
        label: step.label,
        ...(step.progress !== undefined ? { progress: step.progress } : {}),
      }
      return [[run.id, status]]
    }),
  ),
)

const items = computed(() =>
  sessionTimelineItems(
    sessions.openTimeline,
    {
      chat: chatLive.value,
      chatStatus: chatStatus.value,
      agents: agentLive.value,
      agentRunsInFlight: agentTasks.runHarnessSessions,
      media: sessions.openSessionId ? sessions.pendingTurns[sessions.openSessionId] : null,
      mediaSteps: mediaSteps.value,
      audio: sessionAudio.pendingTurn,
      artifactRuns: artifactRuns.state,
    },
    { deletedUrls: sessions.openDeletedFiles },
  ),
)

const lastChatMessageId = computed(() => chatLive.value.at(-1)?.id)

const inAgentMode = computed(() => promptStore.getCurrentMode() === 'agent')
const showsGameBar = computed(() => inAgentMode.value && agentMode.agentWorkspaceKind === 'games')

const { showScrollButton, scrollToBottom } = useStickToBottom(panel)

watch(
  () => sessions.openSessionId,
  () => nextTick(() => scrollToBottom(false)),
)

onMounted(() => scrollToBottom(false))

defineExpose({ scrollToBottom })
</script>
