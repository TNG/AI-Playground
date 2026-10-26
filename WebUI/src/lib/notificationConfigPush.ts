import { computed, watch, type WatchStopHandle } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useHomeAgent } from '@/assets/js/store/homeAgent'
import { useI18N } from '@/assets/js/store/i18n'
import { registerSessionLabeler } from '@/assets/js/permissions/sessionPromptPort'
import { notificationSessionLabel } from '@/lib/notificationLabel'
import { registerChannelQuestionTemplates } from '@/lib/channelQuestionWording'
import { registerAnswerRouterCopy } from '@/lib/answerRouterWording'
import { registerAgentAnswerSessions } from '@/lib/agentAnswerSessions'
import type { NotificationConfig } from '@/types/notificationsIpc'

// Main delivers Notifications while the window is hidden, so it keeps its own copy.
// Composed here rather than in the homeAgent store, which agentMode's imports reach.

let stop: WatchStopHandle | null = null

export function startNotificationConfigPush(): void {
  if (stop) return
  const homeAgent = useHomeAgent()
  const agentMode = useAgentMode()
  const i18n = useI18N()
  const config = computed<NotificationConfig>(() => {
    const text = i18n.state
    return {
      ...homeAgent.notificationRoute,
      autoNotify: homeAgent.autoNotify,
      sessionInView: agentMode.sessionInView,
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
      },
    }
  })
  stop = watch(config, (next) => window.electronAPI?.notifications?.setConfig?.(next), {
    immediate: true,
  })
  // A Channel Question names its session the way main's Notifications do.
  const agentTasks = useAgentTasks()
  const label = (sessionId: string) =>
    notificationSessionLabel(
      config.value.templates,
      sessionId,
      agentMode.sessions[sessionId]?.title ?? '',
      agentTasks.tasks,
    )
  registerSessionLabeler(label)
  registerAgentAnswerSessions(label)
  registerAnswerRouterCopy(() => {
    const text = i18n.state
    return {
      starting: text.AGENT_ANSWER_STARTING ?? '',
      queued: text.AGENT_ANSWER_QUEUED ?? '',
      notSent: text.AGENT_ANSWER_NOT_SENT ?? '',
      noSession: text.AGENT_ANSWER_NO_SESSION ?? '',
      realShell: text.AGENT_ANSWER_REAL_SHELL ?? '',
      fixOnDesktop: text.AGENT_ANSWER_FIX_ON_DESKTOP ?? '',
      textOnly: text.AGENT_ANSWER_TEXT_ONLY ?? '',
      noSpeech: text.AGENT_ANSWER_NO_SPEECH ?? '',
    }
  })
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
      forHomeAgent: text.MODEL_DOWNLOAD_FOR_HOME_AGENT ?? '',
    }
  })
}
