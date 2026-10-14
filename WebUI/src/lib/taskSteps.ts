import type { AgentTaskStep } from '@/types/agentTaskIpc'

export function withStepAdded(steps: AgentTaskStep[]): AgentTaskStep[] {
  return [...steps, { id: crypto.randomUUID(), prompt: '' }]
}

export function withStepRemoved(steps: AgentTaskStep[], id: string): AgentTaskStep[] {
  return steps.filter((step) => step.id !== id)
}

export function withStepPrompt(
  steps: AgentTaskStep[],
  id: string,
  prompt: string,
): AgentTaskStep[] {
  return steps.map((step) => (step.id === id ? { ...step, prompt } : step))
}

/** The order is unchanged when the Step is already at that end. */
export function withStepMoved(
  steps: AgentTaskStep[],
  id: string,
  direction: 'up' | 'down',
): AgentTaskStep[] {
  const from = steps.findIndex((step) => step.id === id)
  const to = direction === 'up' ? from - 1 : from + 1
  if (from < 0 || to < 0 || to >= steps.length) return steps
  const moved = [...steps]
  ;[moved[from], moved[to]] = [moved[to], moved[from]]
  return moved
}
