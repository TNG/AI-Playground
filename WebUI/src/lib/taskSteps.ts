import type { AgentTaskStep } from '@/types/agentTaskIpc'

export function withStepAdded(steps: AgentTaskStep[]): AgentTaskStep[] {
  return [...steps, { id: crypto.randomUUID(), prompt: '' }]
}

/** An empty Step right after `afterId`; at the end when that Step is gone. */
export function withStepInserted(steps: AgentTaskStep[], afterId: string): AgentTaskStep[] {
  const index = steps.findIndex((step) => step.id === afterId)
  if (index < 0) return withStepAdded(steps)
  const inserted = { id: crypto.randomUUID(), prompt: '' }
  return [...steps.slice(0, index + 1), inserted, ...steps.slice(index + 1)]
}

/** Steps whose prompt says something, trimmed. */
export function stepPrompts(steps: readonly AgentTaskStep[]): string[] {
  return steps.map((step) => step.prompt.trim()).filter(Boolean)
}

/**
 * The turn that starts a run of Steps: how it will be carried out, the user's prompt for this run
 * (when there is one) as an adjustment that wins over the Steps, and Step 1.
 * Model-facing, so not translated.
 */
export function firstStepTurn(prompt: string, steps: readonly string[]): string {
  const plan =
    steps.length === 1
      ? 'Carry this out in one step:'
      : `Carry this out in ${steps.length} steps. I will send them one at a time; do only the ` +
        'current one, then stop.'
  const request = prompt.trim()
  const adjustment = request ? [`${ADJUSTMENT_OPEN}${request}${ADJUSTMENT_CLOSE}`, ''] : []
  return [plan, '', ...adjustment, stepTurn(1, steps)].join('\n')
}

const ADJUSTMENT_OPEN = 'For this run the user added: "'
const ADJUSTMENT_CLOSE =
  '"\nApply it to every step it is relevant to. Where it conflicts with a step, follow the user.'

/** The user's prompt inside a turn built by `firstStepTurn`, for runs that did not record it. */
export function runInputOf(turn: string): string | undefined {
  const start = turn.indexOf(ADJUSTMENT_OPEN)
  if (start < 0) return undefined
  const from = start + ADJUSTMENT_OPEN.length
  const end = turn.indexOf(ADJUSTMENT_CLOSE, from)
  return end < 0 ? undefined : turn.slice(from, end)
}

/** The turn for Step `index` (1-based) of a prompt's Steps. */
export function stepTurn(index: number, steps: readonly string[]): string {
  if (steps.length === 1) return steps[0]
  return `Step ${index} of ${steps.length}: ${steps[index - 1]}`
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
