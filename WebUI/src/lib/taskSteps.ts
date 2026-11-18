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
 * The one turn an Agent Run is sent: how to carry out the Steps, every Step numbered, and the
 * user's prompt for this run (when there is one) as an adjustment that wins over the Steps.
 * Model-facing, so not translated.
 */
export function runPrompt(prompt: string, steps: readonly string[]): string {
  const numbered = steps.map((step, index) => `${index + 1}. ${step}`).join('\n')
  const request = prompt.trim()
  const adjustment = request ? ['', `${ADJUSTMENT_OPEN}${request}${ADJUSTMENT_CLOSE}`] : []
  return [RUN_INSTRUCTION, '', numbered, ...adjustment].join('\n')
}

const RUN_INSTRUCTION =
  'Carry out these steps now. They are instructions, not a script: follow them in order ' +
  'unless a step says otherwise, and a step may be conditional or repeat. Do the work ' +
  "directly; stop only when a step needs the user's input, then ask for it in your reply; " +
  'the answer arrives as the next message. In your replies, tell the user only what matters ' +
  'to them: results, findings and questions. Do not announce your plan or which step you are ' +
  'on, and do not repeat the steps.'

const ADJUSTMENT_OPEN = 'For this run the user added: "'
const ADJUSTMENT_CLOSE =
  '"\nApply it to every step it is relevant to. Where it conflicts with a step, follow the user.'

/** The Start Prompt inside a run's first turn, run prompt or old first Step, when not recorded. */
export function runInputOf(turn: string): string | undefined {
  const start = turn.indexOf(ADJUSTMENT_OPEN)
  if (start < 0) return undefined
  const from = start + ADJUSTMENT_OPEN.length
  const end = turn.indexOf(ADJUSTMENT_CLOSE, from)
  return end < 0 ? undefined : turn.slice(from, end)
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
