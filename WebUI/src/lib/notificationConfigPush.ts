import { computed, watch, type WatchStopHandle } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useChannelQueue } from '@/assets/js/store/channelQueue'
import { useChannels } from '@/assets/js/store/channels'
import { useSessions } from '@/assets/js/store/sessions'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { registerSessionLabeler } from '@/assets/js/permissions/sessionPromptPort'
import { notificationSessionLabel } from '@/lib/notificationLabel'
import { fillTemplate } from '@/lib/fillTemplate'
import { registerChannelQuestionTemplates } from '@/lib/channelQuestionWording'
import { answerRouterCopyFrom, registerAnswerRouterCopy } from '@/lib/answerRouterWording'
import { registerChannelSessionPort } from '@/lib/channelSessionPort'
import type { NotificationConfig } from '@/types/notificationsIpc'

// Main delivers Notifications while the window is hidden, so it keeps its own copy.
// Composed here rather than in the Channels store, which agentMode's imports reach.

let stop: WatchStopHandle | null = null

async function pushRealShellFolders(
  folders: string[],
  errors: ReturnType<typeof useErrors>,
): Promise<void> {
  try {
    const result = await window.electronAPI?.sessions?.setRealShellFolders?.([...folders])
    if (result && !result.success) throw new Error(result.error)
  } catch (error) {
    errors.report(error, { code: 'sessions/real-shell-push-failed', surface: 'silent' })
  }
}

export function startNotificationConfigPush(): void {
  if (stop) return
  const channelStore = useChannels()
  const agentMode = useAgentMode()
  const sessions = useSessions()
  const i18n = useI18N()
  const errors = useErrors()
  const config = computed<NotificationConfig>(() => {
    const text = i18n.state
    return {
      channels: [...channelStore.notificationChannels],
      sessionOnScreen: sessions.openSessionId,
      realShellSessions: Object.values(agentMode.sessions)
        .filter((session) => agentMode.isUnsandboxed(session.workspaceDir))
        .map((session) => session.id),
      templates: {
        header: text.AGENT_NOTIFY_HEADER ?? '',
        paused: text.AGENT_NOTIFY_PAUSED ?? '',
        pauseReason: text.AGENT_NOTIFY_PAUSE_REASON ?? '',
        pauseKinds: {
          download: text.AGENT_NOTIFY_PAUSE_DOWNLOAD ?? '',
          'vram-warning': text.AGENT_NOTIFY_PAUSE_VRAM_WARNING ?? '',
          confirmation: text.AGENT_NOTIFY_PAUSE_CONFIRMATION ?? '',
          question: text.AGENT_NOTIFY_PAUSE_QUESTION ?? '',
        },
        failed: text.AGENT_NOTIFY_FAILED ?? '',
        sessionLabel: text.AGENT_NOTIFY_SESSION_LABEL ?? '',
        taskLabel: text.AGENT_NOTIFY_TASK_LABEL ?? '',
        untitled: text.AGENT_NOTIFY_UNTITLED ?? '',
        answerButton: text.AGENT_NOTIFY_ANSWER_BUTTON ?? '',
        answerOnComputer: text.AGENT_NOTIFY_ANSWER_ON_COMPUTER ?? '',
        answerInThread: text.AGENT_NOTIFY_ANSWER_IN_THREAD ?? '',
        answerByReply: text.AGENT_NOTIFY_ANSWER_BY_REPLY ?? '',
        queueDroppedOnQuit: text.CHANNEL_QUEUE_DROPPED_QUIT ?? '',
        agentStarted: text.CHANNEL_AGENT_STARTED ?? '',
      },
    }
  })
  const stopConfig = watch(config, (next) => window.electronAPI?.notifications?.setConfig?.(next), {
    immediate: true,
  })
  // Main keeps a Session using the real shell unreachable, so it hears every change.
  const realShellFolders = computed(() =>
    agentMode.unsandboxedWorkspaces.filter((folder) => agentMode.isUnsandboxed(folder)),
  )
  const stopRealShell = watch(
    () => JSON.stringify(realShellFolders.value),
    () => void pushRealShellFolders(realShellFolders.value, errors),
    { immediate: true },
  )
  stop = () => {
    stopConfig()
    stopRealShell()
  }
  // A Channel Question names its session the way main's Notifications do.
  const agentTasks = useAgentTasks()
  const channelQueue = useChannelQueue()
  agentTasks.contributeInFlightWork(() => channelQueue.inFlightWork)
  const label = (sessionId: string) =>
    notificationSessionLabel(
      config.value.templates,
      sessionId,
      agentMode.sessions[sessionId]?.title ?? '',
      agentTasks.tasks,
    )
  registerSessionLabeler(label)
  registerChannelSessionPort({
    harness: label,
    session: (sessionRef) =>
      fillTemplate(config.value.templates.sessionLabel, {
        title: sessions.sessions[sessionRef]?.title || (i18n.state.SESSIONS_UNTITLED ?? ''),
      }),
  })
  registerAnswerRouterCopy(() => answerRouterCopyFrom(i18n.state))
  registerChannelQuestionTemplates(() => {
    const text = i18n.state
    return {
      askOne: text.CHANNEL_QUESTION_DOWNLOAD_ONE ?? '',
      askMany: text.CHANNEL_QUESTION_DOWNLOAD_MANY ?? '',
      lookupFailed: text.CHANNEL_QUESTION_LOOKUP_FAILED ?? '',
      gated: text.CHANNEL_QUESTION_GATED ?? '',
      confirm: text.CHANNEL_QUESTION_CONFIRM ?? '',
      cancel: text.CHANNEL_QUESTION_CANCEL ?? '',
      confirmed: text.CHANNEL_QUESTION_CONFIRMED ?? '',
      cancelled: text.CHANNEL_QUESTION_CANCELLED ?? '',
      queued: text.CHANNEL_QUESTION_QUEUED ?? '',
      starting: text.CHANNEL_QUESTION_STARTING ?? '',
      progress: text.CHANNEL_QUESTION_PROGRESS ?? '',
      complete: text.CHANNEL_QUESTION_COMPLETE ?? '',
      failed: text.CHANNEL_QUESTION_FAILED ?? '',
      answeredInApp: text.CHANNEL_QUESTION_ANSWERED_IN_APP ?? '',
      answeredElsewhere: text.CHANNEL_QUESTION_ANSWERED_ELSEWHERE ?? '',
      declinedInApp: text.CHANNEL_QUESTION_DECLINED_IN_APP ?? '',
      closed: text.CHANNEL_QUESTION_CLOSED ?? '',
      unavailable: text.CHANNEL_QUESTION_UNAVAILABLE ?? '',
      stale: text.CHANNEL_QUESTION_STALE ?? '',
      alreadyDownloading: text.CHANNEL_QUESTION_ALREADY_DOWNLOADING ?? '',
      alreadyDownloadingFor: text.CHANNEL_QUESTION_ALREADY_DOWNLOADING_FOR ?? '',
      cancelledInApp: text.CHANNEL_QUESTION_CANCELLED_IN_APP ?? '',
      appClosed: text.CHANNEL_QUESTION_APP_CLOSED ?? '',
      forChat: text.MODEL_DOWNLOAD_FOR_CHAT ?? '',
      forOther: text.MODEL_DOWNLOAD_FOR_OTHER ?? '',
      forChannel: text.MODEL_DOWNLOAD_FOR_CHANNEL ?? '',
    }
  })
}
