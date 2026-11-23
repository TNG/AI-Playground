import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { captureWebsite, type WebsiteCaptureInput } from '../agentBrowser.ts'
import { jsonSchemaParameters } from '../piCustomTools.ts'
import { resolvePreviewUrl } from '../piWorkspaceRuntime.ts'
import { loadPi } from '../piRuntime.ts'
import { screenshotToolResult } from './screenshotOutput.ts'
import type { AgentCapability, CapabilityHost } from './types.ts'

// ── web-screenshot capability ────────────────────────────────────────────────
//
// The capture-only half of Web debugging: navigate to a page, save what it
// looks like. No script execution, no console reading, no play-testing — which
// is exactly why it may be on by default while Web debugging stays opt-in.

export const WEB_SCREENSHOT_TOOL = 'webScreenshot'

const SCREENSHOT_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: {
      type: 'string',
      description:
        'Page to capture: a full http(s) URL, or a workspace-relative path like "index.html" ' +
        '(resolved against the workspace preview server).',
    },
    width: { type: 'number', description: 'Viewport width in pixels (200–4000; default 1280).' },
    height: { type: 'number', description: 'Viewport height in pixels (200–4000; default 800).' },
    text: {
      type: 'string',
      description:
        'Visible text of the single element to capture instead of the whole page — quote it ' +
        "from the page's readable text or an image's alt text; case and whitespace don't matter.",
    },
  },
  required: ['url'],
}

async function buildWebScreenshotTool(host: CapabilityHost): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  return [
    pi.defineTool({
      name: WEB_SCREENSHOT_TOOL,
      label: WEB_SCREENSHOT_TOOL,
      description:
        'Open a web page and save a PNG picture of it into the workspace for the user to ' +
        'look at — the whole page at a chosen viewport size, or a single element chosen by ' +
        'quoting its text. Read the page with the web tools first, then pass the visible ' +
        "text (or an image's alt text) of the element to show as `text` — never a CSS " +
        'selector, which you cannot know. It cannot run scripts, read the console or ' +
        'inspect the page, and you cannot see the picture yourself — to read a page use ' +
        'the web tools instead.',
      parameters: jsonSchemaParameters(SCREENSHOT_INPUT_SCHEMA),
      execute: async (toolCallId, params) => {
        const { url, width, height, text } = params as {
          url?: string
          width?: number
          height?: number
          text?: string
        }
        const resolvedUrl = resolvePreviewUrl(url)
        if (!resolvedUrl) throw new Error('webScreenshot requires a url')
        const input: WebsiteCaptureInput = {
          url: resolvedUrl,
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
          ...(text ? { text } : {}),
        }
        const result = await captureWebsite(host.sessionId, host.workspaceDir, input)
        return screenshotToolResult(host, toolCallId, result)
      },
    }) as ToolDefinition,
  ]
}

export const webScreenshotCapability: AgentCapability = {
  id: 'web-screenshot',
  label: 'Website screenshots',
  summary:
    'Open a web page and save a picture of it into the workspace, so the agent can show the ' +
    'user what a site or one of its elements looks like.',
  buildTools: buildWebScreenshotTool,
}
