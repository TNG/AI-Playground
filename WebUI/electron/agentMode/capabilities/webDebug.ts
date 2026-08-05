import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { runBrowserAction } from '../../subprocesses/agentBrowser.ts'
import {
  jsonSchemaParameters,
  sendToolImage,
  textResult,
  workspaceFileToDataUri,
  type SkillSource,
} from '../piCustomTools.ts'
import { resolvePreviewUrl } from '../piWorkspaceRuntime.ts'
import { loadPi } from '../piRuntime.ts'
import { appLoggerInstance } from '../../logging/logger.ts'
import type { AgentCapability, CapabilityHost } from './types.ts'

const logger = appLoggerInstance
const LOG_SOURCE = 'webDebugCapability'

// ── web-debug capability ─────────────────────────────────────────────────────
//
// One `browser` tool driving Electron's own bundled Chromium, instead of the 29
// schemas a browser MCP server would add, plus the skill that teaches the
// open → read console → fix → reload loop.

const BROWSER_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['open', 'console', 'eval', 'screenshot'],
      description:
        'open: navigate to `url` (clears previous logs); console: read console ' +
        'messages and uncaught errors since the last open; eval: run `script` in the ' +
        'page and return its result; screenshot: save a PNG of the page into the ' +
        'workspace and return its path.',
    },
    url: {
      type: 'string',
      description:
        'Page to open (action=open): either a workspace-relative path like "index.html" ' +
        '(resolved against the workspace preview server) or a full http URL.',
    },
    script: { type: 'string', description: 'JavaScript to evaluate (action=eval).' },
  },
  required: ['action'],
}

const BROWSER_DEBUGGING_SKILL: SkillSource = {
  name: 'browser-debugging',
  description:
    'Preview and debug a web page you built in the workspace: open it, read console ' +
    'errors, fix the file, reload, and screenshot.',
  body: [
    'Your workspace is already served over HTTP by the app; the browser tool resolves a bare',
    'file name against that server, so you never need a port and never a file:// path. A',
    'connection error means you used a stale URL — retry with just the file name.',
    '',
    "Use the `browser` tool (it drives the app's built-in Chromium):",
    '1. browser {"action":"open","url":"index.html"} — navigate; clears old logs.',
    '2. browser {"action":"console"} — read console logs AND uncaught errors since the open.',
    '3. Edit the workspace file (relative path, e.g. "index.html") to fix the root cause.',
    '4. Repeat open + console until there are no errors.',
    '5. browser {"action":"eval","script":"document.title"} — run JS to inspect page state.',
    '6. browser {"action":"screenshot"} — save a PNG into the workspace and get its path.',
  ].join('\n'),
}

async function buildBrowserTool(host: CapabilityHost): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  return [
    pi.defineTool({
      name: 'browser',
      label: 'browser',
      description:
        "Drive a headless browser (the app's built-in Chromium) to preview and debug web " +
        'pages you created in the workspace. Open pages via the workspace HTTP preview URL ' +
        '(from your instructions), never file:// paths.',
      parameters: jsonSchemaParameters(BROWSER_INPUT_SCHEMA),
      execute: async (toolCallId, params) => {
        const action = params as Parameters<typeof runBrowserAction>[2]
        const url = resolvePreviewUrl(action.url)
        const result = await runBrowserAction(host.sessionId, host.workspaceDir, { ...action, url })
        // The model gets the path (an inlined PNG would swamp its context); the
        // user gets to see what the agent saw.
        if (result.screenshotPath) {
          try {
            sendToolImage(
              toolCallId,
              workspaceFileToDataUri(host.workspaceDir, result.screenshotPath),
              result.screenshotPath,
            )
          } catch (error) {
            logger.warn(`could not show screenshot in chat: ${error}`, LOG_SOURCE)
          }
        }
        return textResult(result.text)
      },
    }) as ToolDefinition,
  ]
}

export const webDebugCapability: AgentCapability = {
  id: 'web-debug',
  label: 'Web debugging',
  summary:
    'Open pages from the workspace in a real browser and read their console output to debug them.',
  skills: [BROWSER_DEBUGGING_SKILL],
  buildTools: buildBrowserTool,
  lazyEligible: true,
}
