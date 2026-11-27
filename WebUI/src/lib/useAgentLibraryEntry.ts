import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useUIStore } from '@/assets/js/store/ui'

/** The ways into the Agent Library from a Session: a new Agent, or the whole list. */
export function useAgentLibraryEntry() {
  const agentTasks = useAgentTasks()
  const ui = useUIStore()

  async function newAgent(): Promise<void> {
    const draft = await agentTasks.createAgentDraft()
    ui.openAgentLibrary({ agentId: draft.agentId })
  }

  function manageAgents(agentId?: string): void {
    ui.openAgentLibrary(agentId ? { agentId } : {})
  }

  return { newAgent, manageAgents }
}
