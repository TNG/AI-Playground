import { app, BrowserWindow, net } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { jsonSchema, tool, type ToolSet } from 'ai'
import { HarnessAgent, type HarnessDebugLevel, type HarnessDiagnostic } from '@ai-sdk/harness/agent'
import type { HarnessV1SandboxProvider } from '@ai-sdk/harness'
import { createPi } from '@ai-sdk/harness-pi'
import { createJustBashSandbox } from '@ai-sdk/sandbox-just-bash'
import { Sandbox, ReadWriteFs, MountableFs } from 'just-bash'
import { appLoggerInstance } from './logging/logger.ts'
import { getMcpServerTools } from './subprocesses/mcpManager.ts'
import { runBrowserAction, closeBrowserSession } from './subprocesses/agentBrowser.ts'

// ── Agent Mode (PoC): Pi coding-agent harness in the Electron main process ──
//
// Composition-style module holding at most ONE live HarnessAgent + session.
// The Pi harness runs in-process (no bridge); filesystem/shell operations go
// through a just-bash sandbox whose virtual filesystem is a MountableFs: the
// user-selected workspace folder is mounted (read-write, real fs) at
// `/workspace` and nothing else touches the host disk — HOME and the rest of
// the namespace stay in the default in-memory fs. permissionMode is 'allow-all'
// — PoC only, scoped to the workspace mount by the sandbox fs.
//
// Model routing: both sources pre-write a models.json (custom provider, api
// 'openai-completions') into Pi's per-session agent dir. 'local' points Pi at
// the local llamacpp/openvino OpenAI-compatible endpoint; 'cloud' points it at
// the app's loopback cloud proxy (cloudProxy.ts) with X-Cloud-* routing
// headers — the proxy injects the real API key in the main process, so no
// credentials ever reach Pi.

export type AgentModeModelConfig =
  | {
      source: 'local'
      /** Served model id on the local endpoint (e.g. 'author---model.gguf'). */
      model: string
      /** Local OpenAI-compatible base URL including /v1 (e.g. http://127.0.0.1:39000/v1). */
      baseUrl: string
      contextWindow?: number
    }
  | {
      source: 'cloud'
      /** Upstream model id as served by the provider (e.g. 'gpt-4o'). */
      model: string
      /** Loopback base URL of the main-process cloud proxy (no /v1). */
      proxyBaseUrl: string
      /** Real provider base URL, forwarded as X-Cloud-Upstream. */
      upstreamBaseUrl: string
      /** Provider id the proxy uses to look up the stored API key. */
      providerId: string
      /** How the proxy attaches the key upstream (bearer | x-api-key | api-key). */
      authStyle: string
      contextWindow?: number
    }

export type AgentToolSpec = {
  /** Tool name the model sees (e.g. 'generateImage'). */
  name: string
  description: string
  /** JSON Schema for the tool input (converted from zod in the renderer). */
  inputSchema: Record<string, unknown>
  /**
   * Input keys holding workspace-relative file paths. Before dispatching the
   * execute to the renderer, the main process resolves each against the
   * workspace (containment-checked) and replaces the value with a data URI —
   * the renderer never touches the filesystem.
   */
  workspacePathInputs?: string[]
}

export type AgentModeTurnConfig = {
  /**
   * Renderer-minted stable session id (one per archived conversation). Keys
   * both the Pi session (so a future process can reattach) and the persisted
   * resume pointer in agent-sessions.json.
   */
  sessionId: string
  workspaceDir: string
  modelConfig: AgentModeModelConfig
  toolSpecs?: AgentToolSpec[]
  /**
   * IDs of configured MCP servers (from mcp.json, via mcpManager) whose tools
   * are attached to the agent for this turn — e.g. 'chrome-devtools' to let Pi
   * read the browser console / DOM of a page it built. Started on demand.
   */
  mcpServerIds?: string[]
}

export type AgentModeStreamChunk = {
  turnId: string
  chunk: unknown
}

export type AgentModeTurnResult = {
  success: boolean
  error?: string
}

const logger = appLoggerInstance
const LOG_SOURCE = 'harnessAgentManager'

/** Sandbox mount point of the workspace folder (`sandboxConfig.workDir`). */
const SANDBOX_WORKDIR = 'workspace'
/**
 * Sandbox HOME. The harness materialises skills under `$HOME/.agents/skills`
 * and Pi keeps config there, so HOME must be a writable path *outside* the
 * workspace mount: it stays in the in-memory fs, which keeps the agent's own
 * scaffolding out of the user's folder (and off host paths the app may not be
 * allowed to write, e.g. macOS-protected ~/Documents).
 */
const SANDBOX_HOME = '/home/agent'

const ENV_TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/**
 * Resolve the harness diagnostics config. Off by default in packaged builds;
 * ON in dev (`npm run dev`) so Pi's turn lifecycle + sandbox console output
 * flows into the app logger (dev terminal + renderer debug log). Override with
 * `HARNESS_DEBUG` (master on/off), `HARNESS_DEBUG_LEVEL`
 * (error|warn|info|debug|trace), and `HARNESS_DEBUG_SUBSYSTEMS` (comma list).
 */
function harnessDebugConfig(): { enabled: boolean; level: HarnessDebugLevel } {
  const envFlag = (process.env.HARNESS_DEBUG ?? '').toLowerCase()
  const enabled = envFlag ? ENV_TRUTHY.has(envFlag) : !app.isPackaged
  const level = (process.env.HARNESS_DEBUG_LEVEL as HarnessDebugLevel | undefined) ?? 'debug'
  return { enabled, level }
}

/** Forward a Pi/harness diagnostic into the app logger at the matching level. */
function logHarnessDiagnostic(event: HarnessDiagnostic): void {
  const scope = event.subsystem ? ` ${event.subsystem}` : ''
  const stream = event.stream ? ` (${event.stream})` : ''
  const detail = event.error ? ` — ${event.error.name ?? 'Error'}: ${event.error.message}` : ''
  const line = `[pi${scope}${stream}] ${event.message}${detail}`
  if (event.level === 'error') logger.error(line, LOG_SOURCE)
  else if (event.level === 'warn') logger.warn(line, LOG_SOURCE)
  else logger.info(line, LOG_SOURCE)
}

/** Compact one value to a single log-friendly line, truncated. */
function briefly(value: unknown, max = 300): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (!text) return ''
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}… (${oneLine.length} chars)` : oneLine
}

/**
 * Pi's context compaction has no first-class AI SDK stream part, so the harness
 * projects it as a synthetic `compaction` tool call/result pair (see
 * @ai-sdk/harness translate-stream-part). Its result output is the ONLY place we
 * receive Pi's real context sizes — the usage totals are session-cumulative, not
 * context occupancy — so log the before/after explicitly instead of letting the
 * long summary truncate them away in the generic tool-result line.
 */
const COMPACTION_TOOL_NAME = 'compaction'

function logCompaction(output: unknown): void {
  const data = (typeof output === 'object' && output !== null ? output : {}) as {
    trigger?: string
    summary?: string
    tokensBefore?: number
    tokensAfter?: number
  }
  const count = (value: number) => value.toLocaleString('en-US')
  // Pi reports `tokensBefore` but NOT `tokensAfter` (see @ai-sdk/harness-pi
  // pi-translate `compaction_end`), so report whichever numbers arrived instead
  // of implying a delta we don't have.
  let sizes: string
  if (data.tokensBefore !== undefined && data.tokensAfter !== undefined) {
    const freed = data.tokensBefore - data.tokensAfter
    const percent = data.tokensBefore > 0 ? Math.round((freed / data.tokensBefore) * 100) : 0
    sizes = `${count(data.tokensBefore)} → ${count(data.tokensAfter)} tokens (freed ${count(freed)}, ${percent}%)`
  } else if (data.tokensBefore !== undefined) {
    sizes = `${count(data.tokensBefore)} context tokens replaced by a summary (Pi does not report the post-compaction size)`
  } else {
    sizes = 'no token counts reported'
  }
  logger.info(`[pi] ⧉ context compacted (${data.trigger ?? 'unknown'}): ${sizes}`, LOG_SOURCE)
  if (data.summary) {
    logger.info(`[pi] ⧉ compaction summary: ${briefly(data.summary, 800)}`, LOG_SOURCE)
  }
}

/** One log line summarizing the token usage the harness reported for a turn. */
function logTurnUsage(usage: unknown): void {
  if (typeof usage !== 'object' || usage === null) return
  const data = usage as {
    inputTokens?: number
    outputTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
  }
  const count = (value?: number) => (value === undefined ? '?' : value.toLocaleString('en-US'))
  const cacheRead = data.inputTokenDetails?.cacheReadTokens
  const cacheWrite = data.inputTokenDetails?.cacheWriteTokens
  const cache =
    cacheRead === undefined && cacheWrite === undefined
      ? ''
      : ` (cache read ${count(cacheRead)}, write ${count(cacheWrite)})`
  // Cumulative over the whole Pi session, not this turn — see the usage comment
  // in startAgentTurn.
  logger.info(
    `[pi] session tokens so far: input ${count(data.inputTokens)}${cache}, ` +
      `output ${count(data.outputTokens)}`,
    LOG_SOURCE,
  )
}

/**
 * The Pi harness does not emit through the framework's `onLog`/observability
 * channel, so the only reliable "what is Pi doing" signal is the turn's UI
 * message stream. This logs a concise line per meaningful chunk — the tool
 * activity, compaction, step boundaries, finish reason and errors that are
 * otherwise invisible (assistant text/reasoning already render in the UI, so
 * their high-frequency deltas are skipped rather than spammed to the log).
 * Both native and dynamic (MCP / synthetic) tools stream as
 * `tool-input-available` + `tool-output-available`, and only the input chunk
 * carries the name, so `toolNames` maps toolCallId → name to let the matching
 * output/error line name its tool.
 */
function logStreamChunk(chunk: Record<string, unknown>, toolNames: Map<string, string>): void {
  const type = typeof chunk.type === 'string' ? chunk.type : 'unknown'
  const callId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : undefined
  switch (type) {
    case 'start':
      logger.info('[pi] turn start', LOG_SOURCE)
      break
    case 'start-step':
      logger.info('[pi] ── step start ──', LOG_SOURCE)
      break
    case 'tool-input-available':
    case 'tool-call': {
      const name = typeof chunk.toolName === 'string' ? chunk.toolName : '?'
      if (callId && typeof chunk.toolName === 'string') toolNames.set(callId, chunk.toolName)
      // The synthetic compaction call/result pair is emitted together, after the
      // fact — a "compacting…" line here would be a fake progress signal, so let
      // the result line (logCompaction) report it.
      if (name === COMPACTION_TOOL_NAME) break
      logger.info(`[pi] → tool ${name}(${briefly(chunk.input)})`, LOG_SOURCE)
      break
    }
    case 'tool-output-available':
    case 'tool-result': {
      const name = (callId && toolNames.get(callId)) || 'tool'
      if (name === COMPACTION_TOOL_NAME) {
        logCompaction(chunk.output ?? chunk.result)
        break
      }
      logger.info(`[pi] ← ${name} result: ${briefly(chunk.output ?? chunk.result)}`, LOG_SOURCE)
      break
    }
    case 'tool-output-error':
    case 'tool-error': {
      const name = (callId && toolNames.get(callId)) || 'tool'
      logger.warn(`[pi] ✗ ${name} error: ${briefly(chunk.errorText ?? chunk.error)}`, LOG_SOURCE)
      break
    }
    case 'finish-step': {
      const reason = typeof chunk.finishReason === 'string' ? ` (${chunk.finishReason})` : ''
      logger.info(`[pi] ── step done${reason} ──`, LOG_SOURCE)
      break
    }
    case 'finish':
      logger.info('[pi] turn finish', LOG_SOURCE)
      break
    case 'error':
      logger.error(`[pi] ✗ error: ${briefly(chunk.errorText ?? chunk.error)}`, LOG_SOURCE)
      break
    // Skipped high-frequency / low-signal parts: text/reasoning start|delta|end
    // (rendered in the UI), tool-input-start|delta.
    default:
      break
  }
}

let mainWin: BrowserWindow | null = null

export function setHarnessAgentMainWindow(win: BrowserWindow): void {
  mainWin = win
}

type ActiveSession = {
  configKey: string
  sessionId: string
  /** Resolved (realpath) workspace folder — the key for session persistence. */
  workspaceDir: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any
  sandbox: Sandbox
}

let active: ActiveSession | null = null
let activeAbort: AbortController | null = null
/** Session id of the most recent session (for reset to clear its pointer). */
let lastSessionId: string | null = null

// ── Pi session persistence ───────────────────────────────────────────────────
//
// Pi keeps each conversation as a JSONL "session file". While the session is
// live that file lives in a tmp dir; Pi only copies it into the workspace's
// `.pi-sessions/` (and returns its name) when the session is *detached/stopped*
// — its documented resume path is "restore the session file on a fresh sandbox"
// (`destroy()` throws the tmp file away). So to survive an AI Playground restart
// we: (a) `detach()` after every turn — which flushes the file to the workspace
// and yields a tiny resume payload; (b) persist that payload to `userData`,
// keyed by session id; and (c) on the next turn/launch hand it back to
// `createSession({ sessionId, resumeFrom })`. The renderer mints one stable
// session id per conversation (the agentMode store's session records), so the
// reattach lines up across processes and multiple sessions can share a
// workspace.

const PI_SESSIONS_DIRNAME = '.pi-sessions'

type ResumePointer = {
  sessionId: string
  /** Workspace the session ran in — locates its `.pi-sessions/` file. */
  workspaceDir: string
  /**
   * The exact lifecycle payload from `session.detach()` — re-passed verbatim as
   * `resumeFrom` (the harness validates it against its own schema). Only the
   * nested `sessionFileName` matters to us (to check the file still exists).
   */
  resumeState: { data?: { sessionFileName?: string } } & Record<string, unknown>
  updatedAt: number
}

function sessionStorePath(): string {
  return path.join(app.getPath('userData'), 'agent-sessions.json')
}

function readSessionStore(): Record<string, ResumePointer> {
  try {
    return JSON.parse(fs.readFileSync(sessionStorePath(), 'utf8')) as Record<string, ResumePointer>
  } catch {
    return {}
  }
}

function writeSessionStore(store: Record<string, ResumePointer>): void {
  try {
    fs.writeFileSync(sessionStorePath(), JSON.stringify(store, null, 2))
  } catch (error) {
    logger.warn(`failed to write agent session store: ${error}`, LOG_SOURCE)
  }
}

function savePointer(pointer: ResumePointer): void {
  const store = readSessionStore()
  store[pointer.sessionId] = pointer
  writeSessionStore(store)
}

function clearPointer(sessionId: string): void {
  const store = readSessionStore()
  if (sessionId in store) {
    delete store[sessionId]
    writeSessionStore(store)
  }
}

/** Absolute path of a pointer's Pi session file, or undefined when unknown. */
function pointerSessionFilePath(pointer: ResumePointer): string | undefined {
  const fileName = pointer.resumeState?.data?.sessionFileName
  if (!fileName) return undefined
  // basename: the file name comes from a JSON file on disk — never let it
  // traverse out of the workspace's .pi-sessions dir.
  return path.join(pointer.workspaceDir, PI_SESSIONS_DIRNAME, path.basename(fileName))
}

/**
 * The persisted resume payload for this session — but only if it belongs to
 * the given workspace and its session file is actually still on disk under
 * `<workspace>/.pi-sessions/`. Returns undefined (i.e. start fresh) otherwise.
 */
function loadResumeFrom(
  sessionId: string,
  workspaceDir: string,
): ResumePointer['resumeState'] | undefined {
  const pointer = readSessionStore()[sessionId]
  if (!pointer || pointer.workspaceDir !== workspaceDir) return undefined
  const filePath = pointerSessionFilePath(pointer)
  if (!filePath || !fs.existsSync(filePath)) {
    logger.warn(`stored Pi session file missing for ${sessionId}; starting fresh`, LOG_SOURCE)
    return undefined
  }
  return pointer.resumeState
}

// ── Workspace runtime (localhost preview server + browser), decoupled from the
// Pi session so it stays stable across the per-turn detach/resume cycle. If the
// preview URL changed each turn, resumed turns (which skip the one-time
// instructions) would never learn the new port — so we pin it per session.

type WorkspaceRuntime = {
  sessionId: string
  workspaceDir: string
  server: http.Server | null
  baseUrl: string | null
}

let workspaceRuntime: WorkspaceRuntime | null = null

async function ensureWorkspaceRuntime(
  sessionId: string,
  workspaceDir: string,
): Promise<WorkspaceRuntime> {
  if (
    workspaceRuntime &&
    workspaceRuntime.sessionId === sessionId &&
    workspaceRuntime.workspaceDir === workspaceDir
  ) {
    return workspaceRuntime
  }
  closeWorkspaceRuntime()
  let server: http.Server | null = null
  let baseUrl: string | null = null
  try {
    const started = await startWorkspaceServer(workspaceDir)
    server = started.server
    baseUrl = started.baseUrl
    logger.info(`workspace served at ${baseUrl} (root ${workspaceDir})`, LOG_SOURCE)
  } catch (error) {
    logger.warn(`failed to start workspace server: ${error}`, LOG_SOURCE)
  }
  workspaceRuntime = { sessionId, workspaceDir, server, baseUrl }
  return workspaceRuntime
}

function closeWorkspaceRuntime(): void {
  if (!workspaceRuntime) return
  closeBrowserSession(workspaceRuntime.sessionId)
  workspaceRuntime.server?.close()
  workspaceRuntime = null
}

/**
 * Pi stores per-session host state under $TMPDIR/ai-sdk-harness/pi/<sessionId>.
 * We pre-write agent/models.json there so Pi's ModelRegistry can resolve the
 * configured model (id + baseUrl + api). This mirrors the path construction
 * inside @ai-sdk/harness-pi (createPiSession) — acknowledged PoC coupling.
 */
function writePiModelsJson(sessionId: string, providers: Record<string, unknown>): void {
  const safeSessionId = sessionId.replace(/[\\/: ]/g, '-')
  const hostAgentDir = path.join(tmpdir(), 'ai-sdk-harness', 'pi', safeSessionId, 'agent')
  fs.mkdirSync(hostAgentDir, { recursive: true })
  fs.writeFileSync(path.join(hostAgentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
}

function writeLocalModelsJson(
  sessionId: string,
  config: AgentModeModelConfig & { source: 'local' },
) {
  writePiModelsJson(sessionId, {
    'aipg-local': {
      name: 'AI Playground local backend',
      baseUrl: config.baseUrl,
      api: 'openai-completions',
      apiKey: 'dummy',
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
      models: [
        {
          id: config.model,
          reasoning: false,
          input: ['text'],
          contextWindow: config.contextWindow ?? 8192,
          maxTokens: Math.min(4096, config.contextWindow ?? 4096),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    },
  })
}

/**
 * Unique Pi model *name* for the cloud entry. Pi's resolver matches a model
 * string against `id` OR `name` across builtins + custom entries, with the
 * builtin catalog first — so a common upstream id like 'gpt-4o' would resolve
 * to Pi's builtin `openai` provider (and fail on missing credentials) instead
 * of our proxy provider. Referencing the model by this prefixed name pins the
 * resolution to the aipg-cloud provider; Pi still sends the real `id` upstream.
 */
function cloudPiModelName(modelId: string): string {
  return `aipg-cloud/${modelId}`
}

const CLOUD_DEFAULT_CONTEXT_WINDOW = 128000

/**
 * Cloud provider entry dialing the app's loopback cloud proxy (cloudProxy.ts)
 * — the same path Chat's Cloud Mode uses. The X-Cloud-* headers tell the proxy
 * where to forward and which stored key to inject (in the main process), so
 * `authHeader: false` suppresses Pi's own Authorization header and the dummy
 * apiKey only satisfies the registry's schema.
 */
function writeCloudModelsJson(
  sessionId: string,
  config: AgentModeModelConfig & { source: 'cloud' },
) {
  const contextWindow = config.contextWindow ?? CLOUD_DEFAULT_CONTEXT_WINDOW
  writePiModelsJson(sessionId, {
    'aipg-cloud': {
      name: 'AI Playground cloud proxy',
      baseUrl: `${config.proxyBaseUrl}/v1`,
      api: 'openai-completions',
      apiKey: 'dummy',
      authHeader: false,
      headers: {
        'X-Cloud-Upstream': config.upstreamBaseUrl,
        'X-Cloud-Provider': config.providerId,
        'X-Cloud-Auth-Style': config.authStyle,
      },
      models: [
        {
          id: config.model,
          name: cloudPiModelName(config.model),
          reasoning: false,
          input: ['text'],
          contextWindow,
          maxTokens: Math.min(8192, contextWindow),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    },
  })
}

function configKeyOf(config: AgentModeTurnConfig): string {
  // Tool specs + MCP server ids are part of the key: HarnessAgent takes its
  // ToolSet at construction, so a changed tool set requires a fresh agent +
  // session. The session id is part of it too — switching sessions in the
  // renderer must rebuild even when everything else matches.
  return JSON.stringify([
    config.sessionId,
    config.workspaceDir,
    config.modelConfig,
    config.toolSpecs ?? [],
    config.mcpServerIds ?? [],
  ])
}

/**
 * Start (on demand) each configured MCP server and merge its tools into one
 * `ToolSet`. A server that fails to start is logged and skipped so a broken MCP
 * config never takes down the whole agent turn. Clients are owned by
 * mcpManager (shared with the app's MCP UI, stopped on app quit) — we don't
 * close them on session teardown.
 */
async function collectMcpTools(serverIds: string[]): Promise<ToolSet> {
  const merged: ToolSet = {}
  for (const serverId of serverIds) {
    try {
      const tools = await getMcpServerTools(serverId)
      Object.assign(merged, tools)
      logger.info(
        `attached ${Object.keys(tools).length} MCP tool(s) from '${serverId}'`,
        LOG_SOURCE,
      )
    } catch (error) {
      logger.warn(`failed to attach MCP server '${serverId}': ${error}`, LOG_SOURCE)
    }
  }
  return merged
}

// ── Renderer tool bridge ─────────────────────────────────────────────────────
//
// Bridged tools (AIPG media tools) execute in the RENDERER, where the real
// implementations live against the Pinia stores (imageGenerationPresets,
// comfyUiPresets, …). The main process only proxies: it sends
// 'agentMode:executeTool' with a requestId and awaits the matching
// 'agentMode:toolResult' invoke (see submitAgentToolResult).

type PendingToolCall = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  cleanupAbort?: () => void
}

const pendingToolCalls = new Map<string, PendingToolCall>()
let toolRequestCounter = 0

// Generation can legitimately take many minutes (video workflows, model
// downloads). The renderer tool has its own 5-minute idle watchdog that fails
// stalled generations, so this is only a safety net against a lost IPC reply.
const TOOL_BRIDGE_TIMEOUT_MS = 30 * 60_000

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

function rejectAllPendingToolCalls(reason: string): void {
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
        // The renderer keeps running its side (no remote cancellation in the
        // PoC); its late submitToolResult finds no pending entry and no-ops.
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

/** Build the host-executed ToolSet HarnessAgent forwards to Pi as customTools. */
function buildBridgedTools(specs: AgentToolSpec[], workspaceDir: string): ToolSet {
  const tools: ToolSet = {}
  for (const spec of specs) {
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema<Record<string, unknown>>(
        spec.inputSchema as Parameters<typeof jsonSchema>[0],
      ),
      execute: async (input, options) => {
        const dispatchInput = { ...input }
        for (const key of spec.workspacePathInputs ?? []) {
          const value = dispatchInput[key]
          if (typeof value === 'string' && value !== '') {
            dispatchInput[key] = workspaceFileToDataUri(workspaceDir, value)
          }
        }
        const result = await executeToolInRenderer(
          spec.name,
          dispatchInput,
          options.toolCallId,
          options?.abortSignal,
        )
        return await saveGeneratedMediaToWorkspace(result, workspaceDir)
      },
    })
  }
  return tools
}

// ── Workspace static server + instructions ──────────────────────────────────
//
// Pi's file tools (read/edit/write/bash) are sandboxed to the workspace and use
// workspace-relative paths — they REJECT absolute host paths ("escapes the
// workspace"). The Chrome DevTools MCP tools, by contrast, drive a real host
// Chrome and need a real URL. Bridging those two worlds by hand (guessing the
// absolute file:// path) is exactly where mid-size models flail. So we serve
// the workspace over a localhost HTTP server and TELL the model, in the session
// instructions, to preview/debug pages via that base URL — never file://. The
// server sends `Cache-Control: no-store`, so a reload after an edit always
// shows the latest version (the old file:// loop kept seeing a stale page).

const WORKSPACE_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.glb': 'model/gltf-binary',
}

/**
 * Start a read-only static file server bound to 127.0.0.1 on an ephemeral port,
 * serving files under `root` (containment-checked; directories fall back to
 * index.html). Localhost-only, GET/HEAD only, no caching — a dev preview
 * surface for the agent, not a public server.
 */
function startWorkspaceServer(root: string): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end('Method Not Allowed')
        return
      }
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
      let fullPath = path.resolve(root, '.' + urlPath)
      const relative = path.relative(root, fullPath)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      let stat: fs.Stats
      try {
        stat = fs.statSync(fullPath)
      } catch {
        res.writeHead(404)
        res.end('Not Found')
        return
      }
      if (stat.isDirectory()) {
        fullPath = path.join(fullPath, 'index.html')
        try {
          stat = fs.statSync(fullPath)
        } catch {
          res.writeHead(404)
          res.end('Not Found')
          return
        }
      }
      const type =
        WORKSPACE_CONTENT_TYPES[path.extname(fullPath).toLowerCase()] ?? 'application/octet-stream'
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      fs.createReadStream(fullPath).pipe(res)
    } catch {
      res.writeHead(500)
      res.end('Internal Server Error')
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/` })
    })
  })
}

/**
 * Session instructions (prepended once to the first user message) that give Pi
 * the two facts it otherwise has to guess: where its work dir lives on the host
 * and the localhost URL its files are served at, plus the rule to debug pages
 * over HTTP rather than file://.
 */
function buildWorkspaceInstructions(
  workspaceDir: string,
  baseUrl: string | null,
  hasBrowserTools: boolean,
): string {
  const lines = [
    'You are working inside a project workspace.',
    `- Your working directory is /${SANDBOX_WORKDIR}; it maps to ${workspaceDir} on the` +
      ' host, which is where the user sees the files.',
    '- Your file tools (read, edit, write, ls, bash) operate RELATIVE to this workspace.' +
      ' Always use workspace-relative paths like "index.html" or "src/app.js". Do NOT pass' +
      ' absolute host paths to the file tools — they are rejected as escaping the workspace.',
    '- Your bash tool is an emulated shell with no interpreters and no network: python3, node,' +
      ' npm/npx, curl and package managers are all unavailable. Never try to start a web server' +
      ' or run a build — use the tools you have instead.',
  ]
  if (baseUrl) {
    lines.push(`- A local static web server serves this workspace at: ${baseUrl}`)
    if (hasBrowserTools) {
      lines.push(
        `- To view or debug a web page you created, open it with the browser tool — pass just the` +
          ` file name ("index.html") and it resolves against that server, or the full URL` +
          ` ${baseUrl}index.html — NOT a file:// path (file:// URLs hit cross-origin/loading` +
          ` restrictions). After editing a file, reload the same page; the server sends no-cache` +
          ` headers so you always see the latest version.`,
        '- Typical web debug loop: open the page with the browser navigation tool, read the' +
          ' console messages to find the error, edit the workspace file to fix it, reload the same' +
          ' URL, and re-check the console until it is clean.',
        '- If a page fails to load with a connection error, the server is already running and you' +
          ' just used a stale URL: retry with the bare file name. Do not attempt to start a server.',
      )
    }
  }
  return lines.join('\n')
}

// ── Electron-native browser tool + skill ─────────────────────────────────────
//
// One small host-executed tool that drives Electron's OWN bundled Chromium
// (see subprocesses/agentBrowser.ts) to preview/debug pages — replacing the
// 29-schema Chrome DevTools MCP with a single schema. Paired with a
// progressively-disclosed skill (only its `description` sits in context until
// the model loads it), so the web-debug workflow costs almost nothing per step.

/** Origin of the live workspace preview server, when it is up. */
function previewBaseUrl(): string | null {
  return workspaceRuntime?.baseUrl ?? null
}

/** A bare workspace path ("index.html") becomes a preview-server URL. */
function resolvePreviewUrl(url: string | undefined): string | undefined {
  const base = previewBaseUrl()
  if (!url || !base || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url
  try {
    return new URL(url.replace(/^\/+/, ''), base).toString()
  } catch {
    return url
  }
}

/**
 * A refused loopback URL is almost always a preview URL from an earlier app run:
 * the preview port is allocated per launch, while a resumed session keeps the
 * old URL in its history forever (the harness injects our instructions only into
 * a *fresh* session's first message — see pi-session `instructionsApplied`). So
 * retry the same path against the live preview origin instead of letting the
 * model conclude it needs to start its own server.
 */
function healRefusedPreviewUrl(url: string | undefined, error: unknown): string | undefined {
  const base = previewBaseUrl()
  if (!url || !base) return undefined
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes('ERR_CONNECTION_REFUSED')) return undefined
  try {
    const refused = new URL(url)
    const live = new URL(base)
    if (refused.hostname !== '127.0.0.1' && refused.hostname !== 'localhost') return undefined
    if (refused.port === live.port) return undefined
    const target = `${refused.pathname}${refused.search}${refused.hash}`.replace(/^\/+/, '')
    return new URL(target, base).toString()
  } catch {
    return undefined
  }
}

function buildBrowserTools(sessionId: string, workspaceDir: string): ToolSet {
  return {
    browser: tool({
      description:
        "Drive a headless browser (the app's built-in Chromium) to preview and debug web " +
        'pages you created in the workspace. Open pages via the workspace HTTP preview URL ' +
        '(from your instructions), never file:// paths.',
      inputSchema: jsonSchema<{ action: string; url?: string; script?: string }>({
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
      }),
      execute: async (input) => {
        const action = input as Parameters<typeof runBrowserAction>[2]
        const url = resolvePreviewUrl(action.url)
        try {
          return await runBrowserAction(sessionId, workspaceDir, { ...action, url })
        } catch (error) {
          const healed = healRefusedPreviewUrl(url, error)
          if (!healed) throw error
          const result = await runBrowserAction(sessionId, workspaceDir, { ...action, url: healed })
          return (
            `${result}\nNote: ${url} was refused — the workspace preview server now runs at ` +
            `${previewBaseUrl()}. Use that URL (or just the file name) from now on.`
          )
        }
      },
    }),
  }
}

/**
 * Progressive-disclosure companion to the thin `media` tool (the bridged
 * delegation tool from the renderer, see agentBridge.ts): only this
 * description sits in context until the model loads the skill, keeping the
 * media workflow guidance at ~zero per-step cost. Attached only when the turn
 * config actually bridges a `media` tool.
 */
const MEDIA_GENERATION_SKILL = {
  name: 'media-generation',
  description:
    'Create or transform images, videos and 3D models with the `media` tool; results are ' +
    'saved into the workspace.',
  content: [
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

const BROWSER_DEBUGGING_SKILL = {
  name: 'browser-debugging',
  description:
    'Preview and debug a web page you built in the workspace: open it, read console ' +
    'errors, fix the file, reload, and screenshot.',
  content: [
    'Your workspace is already served over HTTP by the app; the browser tool resolves a bare',
    'file name against that server, so you never need a port and never a file:// path. The',
    'emulated shell has no python3/node/npx and no network — starting your own server is',
    'impossible, and a connection error just means you used a stale URL: retry with the file name.',
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

/**
 * Make the just-bash sandbox provider resumable. It omits `resumeSession`
 * because it cannot rehydrate a sandbox from an id, and the harness refuses to
 * resume a session without it — which would defeat our whole persistence
 * scheme. Here there is nothing to rehydrate: the provider wraps a sandbox we
 * created ourselves over the workspace folder, and everything a resumed Pi
 * session needs (the workspace files plus the `.pi-sessions/` journal it
 * replays) are real files on disk. So "resume" is just "hand out a session on
 * this same sandbox".
 */
function withSandboxResume(provider: HarnessV1SandboxProvider): HarnessV1SandboxProvider {
  return Object.assign(provider, {
    resumeSession: (options: { sessionId: string; abortSignal?: AbortSignal }) =>
      provider.createSession(options),
  })
}

/**
 * End the current Pi session handle. With `persist`, `detach()` flushes the
 * session file to `<workspace>/.pi-sessions/` and returns a resume payload we
 * store (keyed by workspace) so the next turn/launch can reattach; on any
 * detach failure we fall back to `destroy()`. Without `persist` we just
 * `destroy()` (discard resumability). The workspace runtime (preview server +
 * browser) is intentionally left running — see `closeWorkspaceRuntime`.
 */
async function endActiveSession(persist: boolean): Promise<void> {
  const current = active
  active = null
  rejectAllPendingToolCalls('Agent session ended.')
  if (!current) return
  if (persist) {
    try {
      const resumeState = await current.session.detach()
      savePointer({
        sessionId: current.sessionId,
        workspaceDir: current.workspaceDir,
        resumeState,
        updatedAt: Date.now(),
      })
      logger.info(`persisted Pi session ${current.sessionId} (${current.workspaceDir})`, LOG_SOURCE)
      return
    } catch (error) {
      logger.warn(`detach/persist failed (${error}); destroying session instead`, LOG_SOURCE)
    }
  }
  try {
    await current.session.destroy()
  } catch (error) {
    logger.warn(`failed to destroy harness session: ${error}`, LOG_SOURCE)
  }
}

async function ensureSession(config: AgentModeTurnConfig): Promise<ActiveSession> {
  const configKey = configKeyOf(config)
  if (active && active.configKey === configKey) return active
  // Flush any lingering session (e.g. a config switch) before building a new one.
  await endActiveSession(true)

  if (!fs.existsSync(config.workspaceDir) || !fs.statSync(config.workspaceDir).isDirectory()) {
    throw new Error(`Workspace folder does not exist: ${config.workspaceDir}`)
  }
  // Resolve symlinks (e.g. macOS /tmp -> /private/tmp): ReadWriteFs rejects
  // paths whose realpath escapes its root.
  const workspaceDir = fs.realpathSync(path.resolve(config.workspaceDir))

  // Sandbox namespace: the selected folder is the ONLY real-filesystem mount,
  // at SANDBOX_WORKDIR; everything else (including HOME) lives in the default
  // in-memory fs, so nothing the harness writes outside the work dir can reach
  // the user's disk.
  const vfs = new MountableFs()
  vfs.mount(`/${SANDBOX_WORKDIR}`, new ReadWriteFs({ root: workspaceDir }))
  const sandbox = await Sandbox.create({
    fs: vfs,
    // Sandbox cwd is the namespace root; the harness joins it with
    // `sandboxConfig.workDir` (which must be relative) to get the work dir.
    cwd: '/',
    env: { HOME: SANDBOX_HOME },
    // just-bash's defense-in-depth layer patches Module._load during script
    // execution; the Electron main bundle is CJS with externalized deps, so
    // lazy require() calls inside the execution context (ReadWriteFs hitting
    // real node:fs) trip it. It is documented as a secondary layer — the
    // actual isolation here is the ReadWriteFs root scoping.
    defenseInDepth: false,
  })

  // Renderer-minted stable id (one per conversation) so a future process can
  // reattach the session.
  const sessionId = config.sessionId
  lastSessionId = sessionId

  // Both sources resolve via the pre-written models.json ('aipg-local' /
  // 'aipg-cloud' provider). Cloud references the entry by its unique prefixed
  // *name* so Pi's resolver can't match a builtin catalog model with the same
  // id. No credentials are exposed to Pi either way — cloud auth happens in
  // the loopback proxy (main process), local needs none.
  let model: string
  if (config.modelConfig.source === 'local') {
    writeLocalModelsJson(sessionId, config.modelConfig)
    model = config.modelConfig.model
  } else {
    writeCloudModelsJson(sessionId, config.modelConfig)
    model = cloudPiModelName(config.modelConfig.model)
  }
  const auth = { customEnv: { AIPG_PLACEHOLDER_API_KEY: 'unused' } }

  const harness = createPi({ model, auth })

  // MCP tools execute in the main process over their live MCP connection;
  // bridged AIPG tools proxy to the renderer. Bridged tools win on name
  // collision (spread last) so a stray MCP tool can't shadow media generation.
  const mcpTools = await collectMcpTools(config.mcpServerIds ?? [])
  const bridgedTools = buildBridgedTools(config.toolSpecs ?? [], workspaceDir)

  // Serve the workspace over localhost so the agent can preview/debug pages via
  // HTTP (not file://). The runtime persists across the per-turn detach/resume
  // cycle so the preview port stays stable for the whole conversation.
  const runtime = await ensureWorkspaceRuntime(sessionId, workspaceDir)
  // The built-in Electron browser tool always provides web debugging, so the
  // preview-URL instructions apply whenever the workspace server is up.
  const instructions = buildWorkspaceInstructions(workspaceDir, runtime.baseUrl, true)
  const browserTools = buildBrowserTools(sessionId, workspaceDir)

  const agent = new HarnessAgent({
    harness,
    sandbox: withSandboxResume(createJustBashSandbox({ sandbox })),
    sandboxConfig: { workDir: SANDBOX_WORKDIR },
    permissionMode: 'allow-all',
    // Prepended once to the first user message: tells Pi the workspace's
    // absolute path, its localhost preview URL, and to debug pages over HTTP.
    instructions,
    // Progressive-disclosure skills: only their descriptions are in context
    // until the model loads them — web-debug and media-generation workflows at
    // ~zero per-step cost. The media skill only makes sense when the thin
    // `media` delegation tool is bridged for this session.
    skills: [
      BROWSER_DEBUGGING_SKILL,
      ...((config.toolSpecs ?? []).some((spec) => spec.name === 'media')
        ? [MEDIA_GENERATION_SKILL]
        : []),
    ],
    // Host-executed tools: Pi calls them like builtins, the framework runs
    // execute() here in the main process. The built-in `browser` tool drives
    // Electron's bundled Chromium; bridged AIPG media tools proxy to the
    // renderer; any MCP tools run against their MCP connection. Bridged tools
    // win on name collision (spread last).
    tools: { ...mcpTools, ...browserTools, ...bridgedTools },
    // Diagnostics: without an enabled `debug` config the framework forwards
    // nothing and `onLog` never fires. Turn it on (dev by default, env-tunable)
    // so Pi's turn lifecycle + sandbox console output reaches the app logger.
    debug: harnessDebugConfig(),
    onLog: logHarnessDiagnostic,
  })

  // Reattach the persisted conversation for this session when its session
  // file is still on disk; otherwise start fresh. A stale/corrupt resume payload
  // falls back to a fresh session rather than failing the turn.
  const resumeFrom = loadResumeFrom(sessionId, workspaceDir)
  let session
  try {
    session = resumeFrom
      ? await agent.createSession({
          sessionId,
          resumeFrom,
        } as unknown as Parameters<typeof agent.createSession>[0])
      : await agent.createSession({ sessionId })
    if (resumeFrom) logger.info(`resumed Pi session ${sessionId} (${workspaceDir})`, LOG_SOURCE)
  } catch (error) {
    if (!resumeFrom) throw error
    logger.warn(`resume failed (${error}); starting a fresh session`, LOG_SOURCE)
    clearPointer(sessionId)
    session = await agent.createSession({ sessionId })
  }
  active = { configKey, sessionId, workspaceDir, agent, session, sandbox }
  return active
}

export async function startAgentTurn(
  turnId: string,
  prompt: string,
  config: AgentModeTurnConfig,
): Promise<AgentModeTurnResult> {
  if (activeAbort) {
    return { success: false, error: 'An agent turn is already running.' }
  }
  const abortController = new AbortController()
  activeAbort = abortController
  try {
    const { agent, session } = await ensureSession(config)
    const result = await agent.stream({
      session,
      prompt,
      abortSignal: abortController.signal,
    })
    // Usage the Pi harness reports is a CUMULATIVE SESSION TOTAL, not current
    // context occupancy: it builds the AI SDK usage object from Pi's
    // `getSessionStats().tokens` (documented as "usage totals for the current
    // session state"), summed over every model request in the session. Pi's
    // real context estimate lives in a sibling `contextUsage` field the harness
    // neither forwards nor exposes on its session API. The renderer therefore
    // presents these as session totals (see AgentTokenUsage.vue), and only the
    // compaction part carries exact context figures.
    let lastStepUsage: unknown
    const uiStream = result.toUIMessageStream({
      sendReasoning: true,
      sendStart: true,
      sendFinish: true,
      // The default masks failures as 'An error occurred.' (to avoid leaking
      // server internals to a remote client). Main process and renderer run on
      // the same machine, so surface the real cause (e.g. context overflow).
      onError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
      // Attach usage to the message metadata (same pattern as Chat) so the
      // renderer can read it off the transcript. Pi emits one finish-step per
      // turn, but prefer it over `finish`'s totalUsage anyway so runtimes that
      // do emit per-step usage report their latest numbers.
      messageMetadata: (options: {
        part: { type: string; usage?: unknown; totalUsage?: unknown }
      }) => {
        if (options.part.type === 'finish-step' && options.part.usage) {
          lastStepUsage = options.part.usage
          return { usage: options.part.usage }
        }
        if (options.part.type === 'finish') {
          const usage = lastStepUsage ?? options.part.totalUsage
          return usage ? { usage } : undefined
        }
        return undefined
      },
    })
    const verbose = harnessDebugConfig().enabled
    const toolNames = new Map<string, string>()
    for await (const chunk of uiStream) {
      if (verbose) logStreamChunk(chunk as Record<string, unknown>, toolNames)
      mainWin?.webContents.send('agentMode:streamChunk', { turnId, chunk } as AgentModeStreamChunk)
    }
    if (verbose) logTurnUsage(lastStepUsage)
    // Detach + persist the conversation so it survives an app restart (and so a
    // crash before the *next* turn only loses that unstarted turn).
    await endActiveSession(true)
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`agent turn failed: ${message}`, LOG_SOURCE)
    // Deliver the failure as a UI stream error chunk BEFORE the finally block
    // sends turnDone (which closes the renderer-side stream).
    mainWin?.webContents.send('agentMode:streamChunk', {
      turnId,
      chunk: { type: 'error', errorText: message },
    } as AgentModeStreamChunk)
    // Best-effort persist so the conversation up to the failure isn't lost; a
    // partially-written session that can't resume falls back to fresh next turn.
    await endActiveSession(true)
    return { success: false, error: message }
  } finally {
    activeAbort = null
    mainWin?.webContents.send('agentMode:turnDone', { turnId })
  }
}

export function cancelAgentTurn(): void {
  activeAbort?.abort()
}

/**
 * Manually trigger Pi's built-in context compaction on the live session. Pi
 * performs the compaction itself and emits a `compaction` stream part on the
 * next turn (surfaced to the renderer as a dynamic-tool part named
 * 'compaction'). Only valid between turns with an existing session.
 */
export async function compactAgentContext(
  customInstructions?: string,
): Promise<{ success: boolean; error?: string }> {
  if (activeAbort) {
    return { success: false, error: 'Cannot compact while an agent turn is running.' }
  }
  if (!active) {
    return { success: false, error: 'No active agent session yet — run a turn before compacting.' }
  }
  try {
    await active.session.compact(customInstructions)
    // Pi reports the trigger + before/after token counts on the next turn's
    // stream, where logCompaction picks them up (`[pi] ⧉ context compacted`).
    logger.info('manual context compaction requested; details follow next turn', LOG_SOURCE)
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`manual compaction failed: ${message}`, LOG_SOURCE)
    return { success: false, error: message }
  }
}

/**
 * Hard reset: discard the live handle AND the persisted resume pointer for the
 * current session, and tear down the workspace runtime (preview server +
 * browser) so the next turn starts a brand-new Pi conversation.
 */
export async function resetAgentSession(): Promise<void> {
  cancelAgentTurn()
  const sessionId = active?.sessionId ?? lastSessionId
  await endActiveSession(false)
  if (sessionId) clearPointer(sessionId)
  closeWorkspaceRuntime()
}

/**
 * Delete one archived session's main-side state: the persisted resume pointer
 * and the Pi session file under `<workspace>/.pi-sessions/`. If the session is
 * currently live, it is destroyed (not detached) first. Renderer-side state
 * (the transcript record) is the agentMode store's responsibility.
 */
export async function deleteAgentSession(
  sessionId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (active?.sessionId === sessionId) {
      cancelAgentTurn()
      await endActiveSession(false)
      closeWorkspaceRuntime()
    }
    const pointer = readSessionStore()[sessionId]
    if (pointer) {
      const filePath = pointerSessionFilePath(pointer)
      if (filePath && fs.existsSync(filePath)) fs.rmSync(filePath)
      clearPointer(sessionId)
    }
    logger.info(`deleted agent session ${sessionId}`, LOG_SOURCE)
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`failed to delete agent session ${sessionId}: ${message}`, LOG_SOURCE)
    return { success: false, error: message }
  }
}
