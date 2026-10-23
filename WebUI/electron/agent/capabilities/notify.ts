import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { NOTIFY_CAPABILITY_ID } from '@/types/agentCapabilities'
import { sendNotification } from '../notifier.ts'
import { jsonSchemaParameters, textResult } from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import type { AgentCapability } from './types.ts'

export const NOTIFY_USER_TOOL = 'notify_user'

const NOTIFY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string', description: 'Plain text to send. Keep it short.' },
  },
  required: ['message'],
}

async function buildNotifyTools(): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  return [
    pi.defineTool({
      name: NOTIFY_USER_TOOL,
      label: NOTIFY_USER_TOOL,
      description:
        "Send a short one-way notification to the user's phone. The user cannot reply to it. " +
        'Use only when the user asked for a notification or a Task step says so.',
      parameters: jsonSchemaParameters(NOTIFY_SCHEMA),
      execute: async (_toolCallId, params) => {
        const { message } = params as { message: string }
        const delivery = await sendNotification(message)
        return textResult(delivery.delivered ? 'delivered' : `not delivered: ${delivery.reason}`)
      },
    }) as ToolDefinition,
  ]
}

// No `unavailableReason`: Home Agent state can change mid-session, so delivery is
// checked at call time and the tool always exists.
export const notifyCapability: AgentCapability = {
  id: NOTIFY_CAPABILITY_ID,
  label: 'Phone notifications',
  summary: 'Can send the user a phone notification.',
  buildTools: buildNotifyTools,
  lazyEligible: true,
}
