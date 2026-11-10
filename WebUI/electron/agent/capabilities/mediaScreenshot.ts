import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { executeChatScreenshotTool } from '../../chat/chatScreenshotTool.ts'
import type { CaptureTarget } from '../../adapters/hardware/screenCapture.ts'
import { executeToolInRenderer, jsonSchemaParameters, sendToolImage } from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import { SCREENSHOT_WINDOW_QUERY } from '@/types/agentCapabilities'
import type { AgentToolSpec, CapabilityHost } from './types.ts'

// ── desktop screenshot for an agent turn ─────────────────────────────────────
//
// Chat's `captureScreenshot`, reused: the capture is main's, but the window the
// user bound to it is renderer state, so the tool asks the window for it first.

export const SCREENSHOT_TOOL_NAME = 'captureScreenshot'

type ResultContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s

function isCaptureTarget(value: unknown): value is CaptureTarget {
  const target = value as Partial<CaptureTarget> | null
  return typeof target?.id === 'string' && typeof target.name === 'string'
}

/** The screenshot tool, when the turn shipped its spec and the model can look at the result. */
export async function buildScreenshotTools(
  host: CapabilityHost,
  specs: AgentToolSpec[],
): Promise<ToolDefinition[]> {
  if (!host.supportsVision) return []
  const pi = await loadPi()
  return specs.map(
    (spec) =>
      pi.defineTool({
        name: spec.name,
        label: spec.name,
        description: spec.description,
        parameters: jsonSchemaParameters(spec.inputSchema),
        execute: async (toolCallId, _params, signal) => {
          const bound = await executeToolInRenderer(
            host.sessionId,
            SCREENSHOT_WINDOW_QUERY,
            {},
            toolCallId,
            signal ?? undefined,
          )
          const result = await executeChatScreenshotTool({
            target: isCaptureTarget(bound) ? bound : undefined,
          })
          const content: ResultContent[] = [{ type: 'text', text: result.message }]
          const image = result.ok && result.dataUri ? DATA_URI.exec(result.dataUri) : null
          if (image && result.dataUri) {
            content.push({ type: 'image', data: image[2], mimeType: image[1] })
            sendToolImage(host.sessionId, toolCallId, result.dataUri, result.windowName ?? '')
          }
          return { content, details: undefined }
        },
      }) as ToolDefinition,
  )
}
