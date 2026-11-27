import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useSessions } from '@/assets/js/store/sessions'

/** Whatever the preset, a prompt sent mid-run starts after the open Session's Agent Run. */
export function useAgentRunHold() {
  const agentTasks = useAgentTasks()
  const promptStore = usePromptStore()
  const sessions = useSessions()

  return async function afterAgentRun(send: () => unknown, prompt?: string): Promise<void> {
    const sessionRef = sessions.openSessionId
    if (await agentTasks.afterAgentRun(sessionRef, prompt)) {
      await send()
      return
    }
    promptStore.promptSubmitted = false
    // Left behind in its own Session, which puts it back in the bar on return.
    if (prompt && sessionRef !== sessions.openSessionId) promptStore.injectPromptText('')
  }
}
