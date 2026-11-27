export type AgentLibraryTab = 'steps' | 'inferencing' | 'attributes' | 'schedules' | 'trial'

/** The Harness Session of the Trial Run whose pane the Agent Library has on screen, if any. */
export function trialRunOnScreen(library: {
  selectedAgentId: string | undefined
  trialRunSessionOf: (agentId: string) => string | undefined
  wide: boolean
  shownTab: AgentLibraryTab
}): string | null {
  if (!library.selectedAgentId) return null
  if (!library.wide && library.shownTab !== 'trial') return null
  return library.trialRunSessionOf(library.selectedAgentId) ?? null
}
