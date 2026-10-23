import { computed, watch, type WatchStopHandle } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useHomeAgent } from '@/assets/js/store/homeAgent'
import { useI18N } from '@/assets/js/store/i18n'
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
}
