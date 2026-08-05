import path from 'node:path'
import fs from 'node:fs'
import { BrowserWindow, net } from 'electron'
import { asSchema, type ToolSet } from 'ai'
import { Type, type TSchema } from 'typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { appLoggerInstance } from '../logging/logger.ts'
import { getMcpServerTools } from '../subprocesses/mcpManager.ts'
import { runBrowserAction } from '../subprocesses/agentBrowser.ts'
import { resolvePreviewUrl } from './piWorkspaceRuntime.ts'
import { loadPi, type PiModule } from './piRuntime.ts'

// ── Agent Mode custom tools ──────────────────────────────────────────────────
//
// Everything Pi calls that is not a file/shell builtin (those live in
// piToolOperations.ts):
//
//  - bridged AIPG tools, whose implementations run in the RENDERER against the
//    Pinia stores that drive ComfyUI. Main only proxies over IPC.
//  - the `browser` tool, driving Electron's own bundled Chromium (one schema
//    instead of the 29 a browser MCP would add).
//  - MCP tools from the app's own MCP client, since Pi has no MCP of its own.
//
// Pi takes TypeBox parameter schemas, and `Type.Unsafe` passes a JSON Schema
// straight through — so the renderer keeps emitting plain JSON Schema and no
// schema conversion is needed on either side.

const logger = appLoggerInstance
const LOG_SOURCE = 'piCustomTools'

/** Pi wants tool output as message content; everything here returns text. */
function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text }], details: undefined }
}

function jsonResult(value: unknown): AgentToolResult<undefined> {
  return textResult(typeof value === 'string' ? value : JSON.stringify(value ?? null))
}

/**
 * Pi types tool parameters as TypeBox but treats them as opaque schema metadata
 * at runtime, so a JSON Schema fragment passes straight through — no structural
 * conversion, and the renderer keeps emitting plain JSON Schema.
 */
function jsonSchemaParameters(schema: Record<string, unknown>): TSchema {
  return Type.Unsafe(schema)
}

// ── Renderer tool bridge ─────────────────────────────────────────────────────

type PendingToolCall = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  cleanupAbort?: () => void
}

const pendingToolCalls = new Map<string, PendingToolCall>()
let toolRequestCounter = 0

// Generation can legitimately take many minutes (video workflows, model
// downloads). The renderer tool has its own idle watchdog that fails stalled
// generations, so this is only a safety net against a lost IPC reply.
const TOOL_BRIDGE_TIMEOUT_MS = 30 * 60_000

let mainWin: BrowserWindow | null = null

export function setToolBridgeWindow(win: BrowserWindow): void {
  mainWin = win
}

/** Renderer's answer to an 'agentMode:executeTool' dispatch (via IPC). */
export function submitAgentToolResult(requestId: string, result: unknown, error?: string): void {
  const pending = pendingToolCalls.get(requestId)
  if (!pending) return
  pendingToolCalls.delete(requestId)
  clearTimeout(pending.timeout)
  pending.cleanupAbort?.()
  if (error) pending.reject(new Error(error))
  else pending.resolve(result)
}

export function rejectAllPendingToolCalls(reason: string): void {
  const pending = [...pendingToolCalls.values()]
  pendingToolCalls.clear()
  for (const call of pending) {
    clearTimeout(call.timeout)
    call.cleanupAbort?.()
    call.reject(new Error(reason))
  }
}

function executeToolInRenderer(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  if (!mainWin) {
    return Promise.reject(new Error('No renderer window available for tool execution.'))
  }
  const requestId = `tool-req-${Date.now()}-${++toolRequestCounter}`
  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingToolCalls.delete(requestId)
      reject(new Error(`Tool '${toolName}' timed out after ${TOOL_BRIDGE_TIMEOUT_MS / 60000}min.`))
    }, TOOL_BRIDGE_TIMEOUT_MS)
    const entry: PendingToolCall = { resolve, reject, timeout }
    if (abortSignal) {
      const onAbort = () => {
        // The renderer keeps running its side (no remote cancellation); its late
        // submitToolResult finds no pending entry and no-ops.
        pendingToolCalls.delete(requestId)
        clearTimeout(timeout)
        reject(new Error('Tool execution aborted.'))
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
      entry.cleanupAbort = () => abortSignal.removeEventListener('abort', onAbort)
    }
    pendingToolCalls.set(requestId, entry)
    // `requestId` correlates the IPC reply; `toolCallId` is the model-side id
    // the renderer's UI parts carry, so renderer-side progress (e.g. the media
    // timeline) can be attached to the right tool call while this blocks.
    mainWin?.webContents.send('agentMode:executeTool', {
      requestId,
      toolCallId,
      toolName,
      input,
    })
  })
}

const DATA_URI_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Resolve a model-provided workspace-relative path against the (realpathed)
 * workspace dir, rejecting escapes, and inline the file as a data URI.
 */
function workspaceFileToDataUri(workspaceDir: string, relativePath: string): string {
  const fullPath = path.resolve(workspaceDir, relativePath)
  const relative = path.relative(workspaceDir, fullPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the workspace folder: ${relativePath}`)
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    throw new Error(`File not found in workspace: ${relativePath}`)
  }
  const mime = DATA_URI_MIME_BY_EXT[path.extname(fullPath).toLowerCase()]
  if (!mime) {
    throw new Error(`Unsupported image file type: ${relativePath}`)
  }
  return `data:${mime};base64,${fs.readFileSync(fullPath).toString('base64')}`
}

/**
 * Copy generated media (aipg-media:// URLs in the ComfyUI-shaped tool result)
 * into `<workspace>/generated/` so Pi can reference the files, and annotate
 * the result with the workspace-relative paths. Non-media results and fetch
 * failures leave the result unchanged (the media still rendered app-side).
 */
async function saveGeneratedMediaToWorkspace(
  result: unknown,
  workspaceDir: string,
): Promise<unknown> {
  if (typeof result !== 'object' || result === null) return result
  const record = result as Record<string, unknown>
  if (!Array.isArray(record.images)) return result

  const savedFiles: string[] = []
  for (const item of record.images) {
    if (typeof item !== 'object' || item === null) continue
    const media = item as Record<string, unknown>
    const url = media.imageUrl ?? media.videoUrl ?? media.model3dUrl
    if (typeof url !== 'string' || !url.startsWith('aipg-media://')) continue
    try {
      // net.fetch resolves the custom aipg-media protocol registered in
      // main.ts (including its path-traversal protection).
      const response = await net.fetch(url)
      if (!response.ok) throw new Error(`fetch failed with status ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      const generatedDir = path.join(workspaceDir, 'generated')
      fs.mkdirSync(generatedDir, { recursive: true })
      const filename =
        path.basename(decodeURIComponent(new URL(url).pathname)) || `media-${Date.now()}`
      fs.writeFileSync(path.join(generatedDir, filename), bytes)
      savedFiles.push(path.posix.join('generated', filename))
    } catch (error) {
      logger.warn(`failed to save generated media to workspace: ${error}`, LOG_SOURCE)
    }
  }
  if (savedFiles.length === 0) return result
  return {
    ...record,
    savedFiles,
    savedFilesNote:
      'The generated media files were saved into the workspace at the paths listed in savedFiles.',
  }
}

/** Pi tool definitions proxying to the renderer implementations. */
function buildBridgedTools(
  pi: PiModule,
  specs: AgentToolSpec[],
  workspaceDir: string,
): ToolDefinition[] {
  return specs.map((spec) =>
    pi.defineTool({
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: jsonSchemaParameters(spec.inputSchema),
      execute: async (toolCallId, params, signal) => {
        const dispatchInput = { ...(params as Record<string, unknown>) }
        for (const key of spec.workspacePathInputs ?? []) {
          const value = dispatchInput[key]
          if (typeof value === 'string' && value !== '') {
            dispatchInput[key] = workspaceFileToDataUri(workspaceDir, value)
          }
        }
        const result = await executeToolInRenderer(
          spec.name,
          dispatchInput,
          toolCallId,
          signal ?? undefined,
        )
        return jsonResult(await saveGeneratedMediaToWorkspace(result, workspaceDir))
      },
    }),
  ) as ToolDefinition[]
}

// ── Electron-native browser tool ─────────────────────────────────────────────

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

function buildBrowserTool(pi: PiModule, sessionId: string, workspaceDir: string): ToolDefinition {
  return pi.defineTool({
    name: 'browser',
    label: 'browser',
    description:
      "Drive a headless browser (the app's built-in Chromium) to preview and debug web " +
      'pages you created in the workspace. Open pages via the workspace HTTP preview URL ' +
      '(from your instructions), never file:// paths.',
    parameters: jsonSchemaParameters(BROWSER_INPUT_SCHEMA),
    execute: async (_toolCallId, params) => {
      const action = params as Parameters<typeof runBrowserAction>[2]
      const url = resolvePreviewUrl(action.url)
      const result = await runBrowserAction(sessionId, workspaceDir, { ...action, url })
      return textResult(result)
    },
  }) as ToolDefinition
}

// ── MCP tools ────────────────────────────────────────────────────────────────

/**
 * Start (on demand) each configured MCP server and wrap its tools as Pi tools.
 * A server that fails to start is logged and skipped so a broken MCP config
 * never takes down the whole agent turn. Clients are owned by mcpManager
 * (shared with the app's MCP UI, stopped on app quit), so nothing is closed
 * here on session teardown.
 */
async function buildMcpTools(pi: PiModule, serverIds: string[]): Promise<ToolDefinition[]> {
  const definitions: ToolDefinition[] = []
  for (const serverId of serverIds) {
    let tools: ToolSet
    try {
      tools = await getMcpServerTools(serverId)
    } catch (error) {
      logger.warn(`failed to attach MCP server '${serverId}': ${error}`, LOG_SOURCE)
      continue
    }
    for (const [name, mcpTool] of Object.entries(tools)) {
      const execute = mcpTool.execute
      if (!execute) continue
      const inputSchema = asSchema(mcpTool.inputSchema).jsonSchema as Record<string, unknown>
      // MCP tool descriptions are plain strings; the AI SDK type also allows a
      // context-dependent function, which MCP never produces.
      const description =
        typeof mcpTool.description === 'string'
          ? mcpTool.description
          : `MCP tool ${name} from ${serverId}`
      definitions.push(
        pi.defineTool({
          name,
          label: name,
          description,
          parameters: jsonSchemaParameters(inputSchema),
          execute: async (toolCallId, params, signal) => {
            const result = await execute(params, {
              toolCallId,
              messages: [],
              context: undefined,
              ...(signal ? { abortSignal: signal } : {}),
            })
            return jsonResult(result)
          },
        }) as ToolDefinition,
      )
    }
    logger.info(`attached ${Object.keys(tools).length} MCP tool(s) from '${serverId}'`, LOG_SOURCE)
  }
  return definitions
}

// ── Progressive-disclosure skills ────────────────────────────────────────────
//
// Pi loads skills from directories (a SKILL.md per skill, frontmatter + body)
// and puts only name + description in the system prompt until the model opens
// one. The app ships two, written into an app-owned skills dir at startup so
// Pi's own loader discovers them like any other skill.

type SkillSource = { name: string; description: string; body: string }

/** A skill as the model sees it: a description plus a file it can read. */
export type AgentSkill = {
  name: string
  description: string
  /** Path of the SKILL.md relative to the skills root. */
  relativePath: string
  /** Full SKILL.md text (frontmatter + body), for the sandbox's copy. */
  content: string
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

const MEDIA_GENERATION_SKILL: SkillSource = {
  name: 'media-generation',
  description:
    'Create or transform images, videos and 3D models with the `media` tool; results are ' +
    'saved into the workspace.',
  body: [
    'The `media` tool hands your request to a media specialist that picks the right generation',
    'workflow and parameters. Use it like this:',
    '',
    '1. Describe the desired result in ONE natural-language request: subject, style, aspect',
    '   ratio / size wishes, and quality level. Terse prompts are expanded automatically.',
    '2. Multi-step requests belong in a single call — e.g. "generate an image of a castle and',
    '   turn it into a 3D model" or "animate this photo into a short video". Do not split them',
    '   into separate calls; the specialist chains the steps itself.',
    '3. To transform an image that already exists in the workspace, pass its workspace-relative',
    '   path as sourceImagePath (e.g. "generated/AIPG_00001_.png").',
    '4. The result lists what was created plus "savedFiles": the workspace-relative paths of the',
    '   generated media under "generated/". Reference those paths in your reply or in files you',
    '   write (e.g. an <img src="generated/...png"> in an HTML page).',
    '',
    'Media generation takes minutes — call the tool once, then wait for its result. Do not',
    'retry while a call is running.',
  ].join('\n'),
}

/**
 * Materialise the app's skills under `skillsRoot` (for host-shell mode, where
 * the model reads the real files) and return them for the sandbox, which gets
 * an in-memory copy instead. Rewritten every session build so edits to the
 * sources above ship without stale copies lingering in userData.
 */
export function writeAgentSkills(skillsRoot: string, includeMedia: boolean): AgentSkill[] {
  const sources = includeMedia
    ? [BROWSER_DEBUGGING_SKILL, MEDIA_GENERATION_SKILL]
    : [BROWSER_DEBUGGING_SKILL]
  const skills: AgentSkill[] = []
  for (const skill of sources) {
    const frontmatter = [
      '---',
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      '---',
      '',
    ].join('\n')
    const content = `${frontmatter}${skill.body}\n`
    try {
      const dir = path.join(skillsRoot, skill.name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SKILL.md'), content)
    } catch (error) {
      logger.warn(`failed to write skill '${skill.name}': ${error}`, LOG_SOURCE)
    }
    skills.push({
      name: skill.name,
      description: skill.description,
      relativePath: `${skill.name}/SKILL.md`,
      content,
    })
  }
  return skills
}

/**
 * The `<available_skills>` block for the system prompt, matching Pi's own
 * wording. Built here rather than handed to Pi's skill loader because the
 * location the model must read differs per mode: the sandbox sees the skills at
 * a mount point inside its virtual filesystem, not at their host path.
 */
export function buildSkillsPromptSection(skills: AgentSkill[], skillsRoot: string): string {
  if (skills.length === 0) return ''
  const lines = [
    'The following skills provide specialized instructions for specific tasks.',
    "Use the read tool to load a skill's file when the task matches its description.",
    '',
    '<available_skills>',
  ]
  for (const skill of skills) {
    lines.push('  <skill>')
    lines.push(`    <name>${skill.name}</name>`)
    lines.push(`    <description>${skill.description}</description>`)
    lines.push(`    <location>${joinSkillLocation(skillsRoot, skill.relativePath)}</location>`)
    lines.push('  </skill>')
  }
  lines.push('</available_skills>')
  return lines.join('\n')
}

/** Sandbox roots are POSIX; a host root keeps the platform's separator. */
function joinSkillLocation(skillsRoot: string, relativePath: string): string {
  return skillsRoot.startsWith('/')
    ? path.posix.join(skillsRoot, relativePath)
    : path.join(skillsRoot, relativePath)
}

export type CustomToolsOptions = {
  sessionId: string
  workspaceDir: string
  toolSpecs: AgentToolSpec[]
  mcpServerIds: string[]
}

/**
 * All non-builtin tools for a session. Bridged tools come last so a stray MCP
 * tool cannot shadow media generation by name.
 */
export async function buildCustomTools(options: CustomToolsOptions): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  const mcpTools = await buildMcpTools(pi, options.mcpServerIds)
  const browserTool = buildBrowserTool(pi, options.sessionId, options.workspaceDir)
  const bridgedTools = buildBridgedTools(pi, options.toolSpecs, options.workspaceDir)
  const byName = new Map<string, ToolDefinition>()
  for (const definition of [...mcpTools, browserTool, ...bridgedTools]) {
    byName.set(definition.name, definition)
  }
  return [...byName.values()]
}

export const testables = { workspaceFileToDataUri }
