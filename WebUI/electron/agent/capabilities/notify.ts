import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { NOTIFY_CAPABILITY_ID } from '@/types/agentCapabilities'
import { sendNotification } from '../notifier.ts'
import { allowedAttachmentExtensions } from '../notificationAttachments.ts'
import { jsonSchemaParameters, textResult } from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import type { AgentCapability, CapabilityHost } from './types.ts'

export const NOTIFY_USER_TOOL = 'notify_user'

const NOTIFY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string', description: 'Plain text to send. Keep it short.' },
    attachments: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Workspace-relative path of one file to send with the message, which becomes its ' +
        `caption. Allowed: ${allowedAttachmentExtensions()}.`,
    },
  },
  required: ['message'],
}

async function buildNotifyTools(host: CapabilityHost): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  return [
    pi.defineTool({
      name: NOTIFY_USER_TOOL,
      label: NOTIFY_USER_TOOL,
      description:
        "Send a short notification to the user's Home Agent channel (Telegram, Slack or LAN " +
        'chat), which reaches them away from AI Playground. The user can answer it; an answer ' +
        'arrives in this session as their next message. ' +
        'Call it whenever the user asks to be notified, pinged, messaged, alerted or told about ' +
        'something ("let me know when it is done", "notify me if it fails"), even without naming ' +
        'a device or channel, and when a Task step says so. Do not call it otherwise. ' +
        'To show the user a file (an image, video or speech clip you generated), pass it in ' +
        `\`attachments\` (${allowedAttachmentExtensions()}); generated files are not sent ` +
        'unless attached, and the user cannot open a workspace path, so attach the file instead ' +
        'of naming its location.',
      promptSnippet: 'Notify the user on their Home Agent channel (Telegram, Slack, LAN chat)',
      promptGuidelines: [
        'When the user asks to be notified, pinged, messaged or told when something happens, ' +
          'call notify_user once it happens; a reply in this chat does not count as notifying them',
      ],
      parameters: jsonSchemaParameters(NOTIFY_SCHEMA),
      execute: async (_toolCallId, params) => {
        const { message, attachments } = params as { message: string; attachments?: string[] }
        const delivery = await sendNotification(message, {
          sessionId: host.sessionId,
          ...(attachments?.length
            ? { attachments: { workspaceDir: host.workspaceDir, paths: attachments } }
            : {}),
        })
        return textResult(delivery.delivered ? 'delivered' : `not delivered: ${delivery.reason}`)
      },
    }) as ToolDefinition,
  ]
}

// No `unavailableReason`: Home Agent state can change mid-session, so delivery is
// checked at call time and the tool always exists.
export const notifyCapability: AgentCapability = {
  id: NOTIFY_CAPABILITY_ID,
  label: 'Channel notifications',
  summary:
    'Sends the user a notification on their Home Agent channel. Activate it whenever the user ' +
    'asks to be notified, pinged or told when something happens.',
  buildTools: buildNotifyTools,
  lazyEligible: true,
}
