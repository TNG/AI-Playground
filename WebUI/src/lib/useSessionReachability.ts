import { computed } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useChannels } from '@/assets/js/store/channels'
import { useSessions } from '@/assets/js/store/sessions'
import { useSessionSettings } from '@/assets/js/store/sessionSettings'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'

/** Making a Session reachable from Channels, from the sessions panel. */
export function useSessionReachability() {
  const sessions = useSessions()
  const agentMode = useAgentMode()
  const sessionSettings = useSessionSettings()
  const channelStore = useChannels()
  const setupWizard = useSetupWizard()

  const channelsSetUp = computed(() => channelStore.hasConfiguredChannel)

  function usesRealShell(sessionRef: string): boolean {
    return Object.values(agentMode.sessions).some(
      (record) => record.sessionRef === sessionRef && agentMode.isUnsandboxed(record.workspaceDir),
    )
  }

  async function setReachable(sessionRef: string, reachable: boolean): Promise<void> {
    const defaults = agentMode.agentDefaults().capabilities
    const changed = await sessions.setReachable(sessionRef, reachable, defaults)
    if (changed && reachable && sessionRef === sessions.openSessionId) {
      await sessionSettings.reloadPreset(HARNESS_CHAT_PRESET)
    }
  }

  return {
    channelsSetUp,
    usesRealShell,
    setReachable,
    openChannelSetup: () => setupWizard.openHomeAgentSetup(),
  }
}
