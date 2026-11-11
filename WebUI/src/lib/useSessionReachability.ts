import { computed } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useChannels } from '@/assets/js/store/channels'
import { useSessions } from '@/assets/js/store/sessions'
import { useSessionSettings } from '@/assets/js/store/sessionSettings'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'
import { reachabilityIndicator } from '@/lib/reachabilityIndicator'

/** Making the open Session reachable from Channels, from the prompt bar. */
export function useSessionReachability() {
  const sessions = useSessions()
  const agentMode = useAgentMode()
  const sessionSettings = useSessionSettings()
  const channelStore = useChannels()
  const setupWizard = useSetupWizard()

  function usesRealShell(sessionRef: string): boolean {
    return Object.values(agentMode.sessions).some(
      (record) => record.sessionRef === sessionRef && agentMode.isUnsandboxed(record.workspaceDir),
    )
  }

  const indicator = computed(() => {
    const session = sessions.openSession
    return reachabilityIndicator({
      session,
      channelsSetUp: channelStore.hasConfiguredChannel,
      realShell: !!session && usesRealShell(session.id),
    })
  })

  async function setReachable(sessionRef: string, reachable: boolean): Promise<void> {
    const defaults = agentMode.agentDefaults().capabilities
    const changed = await sessions.setReachable(sessionRef, reachable, defaults)
    if (changed && reachable && sessionRef === sessions.openSessionId) {
      await sessionSettings.reloadPreset(HARNESS_CHAT_PRESET)
    }
  }

  async function activate(): Promise<void> {
    const state = indicator.value
    const sessionRef = sessions.openSessionId
    if (!state || !sessionRef) return
    if (state.action === 'setUp') setupWizard.openChannelsSetup()
    else if (state.action === 'toggle') await setReachable(sessionRef, !state.reachable)
  }

  return { indicator, activate }
}
