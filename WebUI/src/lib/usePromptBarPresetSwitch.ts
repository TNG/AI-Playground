import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import { useConversations, HOME_AGENT_CHAT_PRESET_NAME } from '@/assets/js/store/conversations'
import { useSessionChat } from '@/assets/js/store/sessionChat'
import { useHomeAgent } from '@/assets/js/store/homeAgent'

/**
 * Switch the preset from a prompt-bar control and route the conversation alongside it, mirroring
 * SettingsChatInferencing: Home Agent jumps to its remote thread; leaving a Home Agent thread for
 * another preset returns to the Session's chat so nothing is written into Home Agent state.
 */
export function usePromptBarPresetSwitch() {
  const presetSwitching = usePresetSwitching()
  const conversations = useConversations()
  const sessionChat = useSessionChat()
  const homeAgent = useHomeAgent()

  return async (presetName: string) => {
    const switchingToHomeAgent = presetName === HOME_AGENT_CHAT_PRESET_NAME
    const onHomeAgentThread = conversations.getThreadKind(conversations.activeKey) === 'homeAgent'
    const result = await presetSwitching.switchPreset(presetName)
    if (result.success) {
      if (switchingToHomeAgent) {
        conversations.activeKey = homeAgent.ensureActiveRemoteConversation()
      } else if (onHomeAgentThread) {
        sessionChat.returnToSessionChat()
      }
    }
    return result
  }
}
