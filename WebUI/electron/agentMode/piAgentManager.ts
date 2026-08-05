import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type {
  AgentSession,
  AgentSessionEvent,
  AuthStorage,
  CompactionResult,
  ModelRegistry,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { appLoggerInstance } from '../logging/logger.ts'
import { loadPi } from './piRuntime.ts'
import { closeBrowserSession } from '../subprocesses/agentBrowser.ts'
import {
  buildCustomTools,
  buildSkillsPromptSection,
  rejectAllPendingToolCalls,
  setToolBridgeWindow,
  submitAgentToolResult,
  writeAgentSkills,
} from './piCustomTools.ts'
import { createAgentToolAccess, type AgentToolAccess } from './piToolOperations.ts'
import {
  buildWorkspaceInstructions,
  closeWorkspaceRuntime,
  ensureWorkspaceRuntime,
} from './piWorkspaceRuntime.ts'
import {
  COMPACTION_TOOL_NAME,
  createStreamTranslator,
  type StepUsage,
  type StreamChunk,
  type TurnSummary,
} from './piStreamTranslate.ts'

// ── Agent Mode: Pi coding agent in the Electron main process ─────────────────
//
// Holds at most ONE live Pi `AgentSession`, keyed by the renderer-minted session
// id (one per archived conversation). The session is long-lived: it survives
// across turns and is only rebuilt when the conversation, workspace, model or
// tool set changes. Pi persists the transcript to its own session file on every
// message, so restart survival is just remembering that file path per session.
//
// The renderer consumes a standard AI SDK UI message stream, so this module
// subscribes to Pi's event stream and pushes translated chunks over IPC (see
// piStreamTranslate.ts). File and shell access is sandboxed to the selected
// workspace folder by default, with a per-workspace opt-in for the real host
// shell (see piToolOperations.ts).
//
// Model routing: both sources are registered as Pi providers at runtime.
// 'local' points at the local llamacpp/openvino OpenAI-compatible endpoint;
// 'cloud' points at the app's loopback cloud proxy (cloudProxy.ts) with
// X-Cloud-* routing headers, so the real API key is injected in the main
// process and never reaches Pi.

const logger = appLoggerInstance
const LOG_SOURCE = 'piAgentManager'

const LOCAL_PROVIDER = 'aipg-local'
const CLOUD_PROVIDER = 'aipg-cloud'
const CLOUD_DEFAULT_CONTEXT_WINDOW = 128000

export type AgentModeStreamChunk = {
  turnId: string
  chunk: unknown
}

/** Outcome of a manual compaction, including Pi's real before/after sizes. */
export type AgentModeCompactionResult = {
  success: boolean
  error?: string
  /** True when the session was already small enough to leave alone. */
  noop?: boolean
  tokensBefore?: number
  tokensAfter?: number
}

export type AgentModeToolProgress = {
  turnId: string
  toolCallId: string
  toolName: string
  text: string
}

export type AgentModeTurnResult = {
  success: boolean
  error?: string
}

const ENV_TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/**
 * Verbose Pi turn logging. On in dev (`npm run dev`) so the turn lifecycle and
 * tool traffic flow into the app logger; off in packaged builds unless
 * `AGENT_DEBUG` says otherwise.
 */
function verboseLogging(): boolean {
  const envFlag = (process.env.AGENT_DEBUG ?? '').toLowerCase()
  return envFlag ? ENV_TRUTHY.has(envFlag) : !app.isPackaged
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

let mainWin: BrowserWindow | null = null

export function setAgentModeMainWindow(win: BrowserWindow): void {
  mainWin = win
  setToolBridgeWindow(win)
}

// ── Session persistence ──────────────────────────────────────────────────────
//
// Pi appends every message to a JSONL session file and can reopen one with
// `SessionManager.open()`. Surviving an app restart is therefore only a matter
// of remembering which file belongs to which conversation, which is what
// agent-sessions.json holds.

type SessionPointer = {
  sessionId: string
  workspaceDir: string
  sessionFilePath: string
  updatedAt: number
}

function sessionStorePath(): string {
  return path.join(app.getPath('userData'), 'agent-sessions.json')
}

function readSessionStore(): Record<string, SessionPointer> {
  try {
    return JSON.parse(fs.readFileSync(sessionStorePath(), 'utf8')) as Record<string, SessionPointer>
  } catch {
    return {}
  }
}

function writeSessionStore(store: Record<string, SessionPointer>): void {
  try {
    fs.writeFileSync(sessionStorePath(), JSON.stringify(store, null, 2))
  } catch (error) {
    logger.warn(`failed to write agent session store: ${error}`, LOG_SOURCE)
  }
}

function savePointer(pointer: SessionPointer): void {
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

/**
 * The stored session file for this conversation, but only when it belongs to the
 * same workspace and still exists on disk. Anything else means "start fresh".
 */
function loadSessionFilePath(sessionId: string, workspaceDir: string): string | undefined {
  const pointer = readSessionStore()[sessionId]
  if (!pointer || pointer.workspaceDir !== workspaceDir) return undefined
  if (!pointer.sessionFilePath || !fs.existsSync(pointer.sessionFilePath)) {
    logger.warn(`stored Pi session file missing for ${sessionId}; starting fresh`, LOG_SOURCE)
    return undefined
  }
  return pointer.sessionFilePath
}

// ── Pi host directories ──────────────────────────────────────────────────────

/**
 * App-owned Pi config root. Deliberately NOT the developer's `~/.pi`: Pi's
 * resource loader reads global skills and settings from its agent dir, and the
 * app must not pick up whatever a user has configured for their own CLI.
 */
function piAgentDir(): string {
  const dir = path.join(app.getPath('userData'), 'pi', 'agent')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Where Pi writes conversation session files (outside the user's workspace). */
function piSessionDir(): string {
  const dir = path.join(app.getPath('userData'), 'pi', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ── Model registration ───────────────────────────────────────────────────────

let authStorage: AuthStorage | null = null
let modelRegistry: ModelRegistry | null = null

/**
 * A registry with no models.json behind it: every model the app offers is
 * registered here at runtime, which also keeps Pi's builtin catalog out of the
 * way (a cloud model id like 'gpt-4o' would otherwise resolve to Pi's own
 * `openai` provider and fail on missing credentials).
 */
async function ensureModelRegistry(): Promise<ModelRegistry> {
  if (modelRegistry) return modelRegistry
  const pi = await loadPi()
  authStorage = pi.AuthStorage.inMemory()
  modelRegistry = pi.ModelRegistry.inMemory(authStorage)
  return modelRegistry
}

/** Register the turn's model as a provider entry and return its Pi model id. */
async function registerModel(
  config: AgentModeModelConfig,
): Promise<{ provider: string; modelId: string }> {
  const registry = await ensureModelRegistry()
  if (config.source === 'local') {
    const contextWindow = config.contextWindow ?? 8192
    registry.registerProvider(LOCAL_PROVIDER, {
      name: 'AI Playground local backend',
      baseUrl: config.baseUrl,
      api: 'openai-completions',
      apiKey: 'unused',
      models: [
        {
          id: config.model,
          name: config.model,
          reasoning: false,
          input: ['text'],
          contextWindow,
          maxTokens: Math.min(4096, contextWindow),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        },
      ],
    })
    authStorage?.setRuntimeApiKey(LOCAL_PROVIDER, 'unused')
    return { provider: LOCAL_PROVIDER, modelId: config.model }
  }

  // The X-Cloud-* headers tell the loopback proxy where to forward and which
  // stored key to inject, so `authHeader: false` suppresses Pi's own
  // Authorization header and the api key is a placeholder.
  const contextWindow = config.contextWindow ?? CLOUD_DEFAULT_CONTEXT_WINDOW
  registry.registerProvider(CLOUD_PROVIDER, {
    name: 'AI Playground cloud proxy',
    baseUrl: `${config.proxyBaseUrl}/v1`,
    api: 'openai-completions',
    apiKey: 'unused',
    authHeader: false,
    headers: {
      'X-Cloud-Upstream': config.upstreamBaseUrl,
      'X-Cloud-Provider': config.providerId,
      'X-Cloud-Auth-Style': config.authStyle,
    },
    models: [
      {
        id: config.model,
        name: config.model,
        reasoning: false,
        input: ['text'],
        contextWindow,
        maxTokens: Math.min(8192, contextWindow),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  })
  authStorage?.setRuntimeApiKey(CLOUD_PROVIDER, 'unused')
  return { provider: CLOUD_PROVIDER, modelId: config.model }
}

// ── Session lifecycle ────────────────────────────────────────────────────────

type ActiveSession = {
  configKey: string
  sessionId: string
  /** Resolved (realpath) workspace folder — the key for session persistence. */
  workspaceDir: string
  session: AgentSession
  access: AgentToolAccess
  /** Preview URL the session's instructions were built with. */
  instructedBaseUrl: string | null
  unsubscribe: () => void
}

let active: ActiveSession | null = null
let activeAbort: AbortController | null = null
/** Session id of the most recent session (for reset to clear its pointer). */
let lastSessionId: string | null = null
/** Per-turn sink: set for the duration of a turn, so events can be routed. */
let currentTurn: { turnId: string; onEvent: (event: AgentSessionEvent) => void } | null = null

function configKeyOf(config: AgentModeTurnConfig): string {
  // The tool set is fixed at session construction, so a changed tool set needs a
  // rebuild. The session id is part of the key too: switching conversations in
  // the renderer must rebuild even when everything else matches.
  return JSON.stringify([
    config.sessionId,
    config.workspaceDir,
    config.modelConfig,
    config.toolSpecs ?? [],
    config.mcpServerIds ?? [],
    config.unsandboxed ?? false,
  ])
}

function sendChunk(turnId: string, chunk: StreamChunk): void {
  mainWin?.webContents.send('agentMode:streamChunk', { turnId, chunk } as AgentModeStreamChunk)
}

async function endActiveSession(): Promise<void> {
  const current = active
  active = null
  rejectAllPendingToolCalls('Agent session ended.')
  if (!current) return
  current.unsubscribe()
  try {
    current.session.dispose()
  } catch (error) {
    logger.warn(`failed to dispose agent session: ${error}`, LOG_SOURCE)
  }
  await current.access.dispose()
}

async function createSession(config: AgentModeTurnConfig): Promise<ActiveSession> {
  if (!fs.existsSync(config.workspaceDir) || !fs.statSync(config.workspaceDir).isDirectory()) {
    throw new Error(`Workspace folder does not exist: ${config.workspaceDir}`)
  }
  // Resolve symlinks (e.g. macOS /tmp -> /private/tmp): the sandbox's ReadWriteFs
  // rejects paths whose realpath escapes its root.
  const workspaceDir = fs.realpathSync(path.resolve(config.workspaceDir))
  const sessionId = config.sessionId
  const unsandboxed = config.unsandboxed === true
  lastSessionId = sessionId

  const pi = await loadPi()
  const { provider, modelId } = await registerModel(config.modelConfig)
  const registry = await ensureModelRegistry()
  const model = registry.find(provider, modelId)
  if (!model) {
    throw new Error(`Model '${modelId}' could not be registered with Pi.`)
  }

  // Skills are progressive disclosure: only name + description sit in the system
  // prompt until the model reads one, so the web-debug and media workflows cost
  // almost nothing per step. The media skill only applies when the thin `media`
  // delegation tool is actually bridged.
  const toolSpecs = config.toolSpecs ?? []
  const skillsDir = path.join(piAgentDir(), 'skills')
  const skills = writeAgentSkills(
    skillsDir,
    toolSpecs.some((spec) => spec.name === 'media'),
  )

  const access = await createAgentToolAccess({ workspaceDir, unsandboxed, skillsDir, skills })

  // Serve the workspace over localhost so the agent can preview/debug pages over
  // HTTP instead of file://. The runtime is keyed by session so the port stays
  // stable for the whole conversation.
  const runtime = await ensureWorkspaceRuntime(sessionId, workspaceDir)
  const customTools = await buildCustomTools({
    sessionId,
    workspaceDir,
    toolSpecs,
    mcpServerIds: config.mcpServerIds ?? [],
  })

  const instructions = buildWorkspaceInstructions({
    cwd: access.cwd,
    workspaceDir,
    baseUrl: runtime.baseUrl,
    unsandboxed,
  })

  const sessionFilePath = loadSessionFilePath(sessionId, workspaceDir)
  const sessionManager = sessionFilePath
    ? pi.SessionManager.open(sessionFilePath, piSessionDir(), access.cwd)
    : pi.SessionManager.create(access.cwd, piSessionDir())
  if (sessionFilePath) {
    logger.info(`resumed Pi session ${sessionId} (${workspaceDir})`, LOG_SOURCE)
  }

  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir: piAgentDir(),
    // No third-party extensions, themes or prompt templates in the host app, and
    // no skill loading either: Pi would advertise the skills at their host path,
    // which the sandboxed read tool cannot open. They are announced below with a
    // location that matches the active mode instead.
    noExtensions: true,
    noThemes: true,
    noPromptTemplates: true,
    noSkills: true,
    // The workspace orientation the model would otherwise have to guess. Built
    // fresh on every session build, so it always carries the live preview URL.
    appendSystemPrompt: [instructions, buildSkillsPromptSection(skills, access.skillsRoot)].filter(
      (section) => section !== '',
    ),
  })
  await resourceLoader.reload()

  const { session } = await pi.createAgentSession({
    cwd: access.cwd,
    agentDir: piAgentDir(),
    model,
    authStorage: authStorage ?? pi.AuthStorage.inMemory(),
    modelRegistry: registry,
    sessionManager,
    settingsManager: pi.SettingsManager.inMemory(),
    // Pi's own file/shell tools are replaced by the mode-specific ones built in
    // piToolOperations.ts, so its builtins are switched off entirely.
    noTools: 'builtin',
    customTools: [...access.definitions, ...customTools],
    resourceLoader,
  })

  const unsubscribe = session.subscribe((event) => currentTurn?.onEvent(event))
  savePointer({
    sessionId,
    workspaceDir,
    sessionFilePath: session.getSessionStats().sessionFile ?? '',
    updatedAt: Date.now(),
  })

  return {
    configKey: configKeyOf(config),
    sessionId,
    workspaceDir,
    session,
    access,
    instructedBaseUrl: runtime.baseUrl,
    unsubscribe,
  }
}

async function ensureSession(config: AgentModeTurnConfig): Promise<ActiveSession> {
  const configKey = configKeyOf(config)
  if (active && active.configKey === configKey) {
    await reassertPreviewUrl(active)
    return active
  }
  await endActiveSession()
  active = await createSession(config)
  return active
}

/**
 * The preview port is allocated per app launch, so a session built before a
 * restart of the preview server carries a dead URL in its system prompt. Tell
 * the model about the new one instead of letting it conclude it must start its
 * own server.
 */
async function reassertPreviewUrl(current: ActiveSession): Promise<void> {
  const runtime = await ensureWorkspaceRuntime(current.sessionId, current.workspaceDir)
  if (runtime.baseUrl === current.instructedBaseUrl) return
  current.instructedBaseUrl = runtime.baseUrl
  if (!runtime.baseUrl) return
  try {
    await current.session.sendCustomMessage(
      {
        customType: 'workspace-preview',
        content:
          `The workspace preview server now runs at ${runtime.baseUrl}. Use this base URL ` +
          '(or just a bare file name) from now on; earlier URLs in this conversation are dead.',
        display: false,
      },
      { deliverAs: 'nextTurn' },
    )
  } catch (error) {
    logger.warn(`failed to re-assert preview URL: ${error}`, LOG_SOURCE)
  }
}

// ── Turn execution ───────────────────────────────────────────────────────────

function logEvent(event: AgentSessionEvent): void {
  switch (event.type) {
    case 'turn_start':
      logger.info('[pi] ── turn start ──', LOG_SOURCE)
      break
    case 'tool_execution_start':
      logger.info(`[pi] → tool ${event.toolName}(${briefly(event.args)})`, LOG_SOURCE)
      break
    case 'tool_execution_end':
      if (event.isError) {
        logger.warn(`[pi] ✗ ${event.toolName} error: ${briefly(event.result)}`, LOG_SOURCE)
      } else {
        logger.info(`[pi] ← ${event.toolName} result: ${briefly(event.result)}`, LOG_SOURCE)
      }
      break
    case 'compaction_end': {
      const before = event.result?.tokensBefore
      const after = event.result?.estimatedTokensAfter
      const sizes =
        before !== undefined && after !== undefined
          ? `${before.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} tokens`
          : 'no token counts reported'
      logger.info(`[pi] ⧉ context compacted (${event.reason}): ${sizes}`, LOG_SOURCE)
      break
    }
    case 'auto_retry_start':
      logger.warn(
        `[pi] retry ${event.attempt}/${event.maxAttempts} after error: ${briefly(event.errorMessage)}`,
        LOG_SOURCE,
      )
      break
    default:
      break
  }
}

/** Usage + context occupancy at this moment, read off the live session. */
function turnSummary(session: AgentSession): TurnSummary {
  const summary: TurnSummary = {}
  try {
    const stats = session.getSessionStats()
    const tokens = stats.tokens
    if (tokens) {
      summary.usage = {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadTokens: tokens.cacheRead,
        cacheWriteTokens: tokens.cacheWrite,
        costUsd: stats.cost,
      }
    }
  } catch (error) {
    logger.warn(`failed to read session stats: ${error}`, LOG_SOURCE)
  }
  try {
    const context = session.getContextUsage()
    if (context) {
      summary.contextUsage = {
        tokens: context.tokens,
        contextWindow: context.contextWindow,
        percent: context.percent,
      }
    }
  } catch (error) {
    logger.warn(`failed to read context usage: ${error}`, LOG_SOURCE)
  }
  try {
    summary.lastStep = lastStepUsage(session)
  } catch (error) {
    logger.warn(`failed to read last step usage: ${error}`, LOG_SOURCE)
  }
  return summary
}

/**
 * Usage of the newest assistant message. Chat mode's gauge reports the last
 * model call, so Agent Mode reports the same thing next to Pi's session totals
 * instead of only the totals (which are ~100x larger over an agentic run).
 */
function lastStepUsage(session: AgentSession): StepUsage | undefined {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index] as { role?: string; usage?: Record<string, unknown> }
    if (message.role !== 'assistant') continue
    const usage = message.usage
    if (!usage) return undefined
    const number = (value: unknown) => (typeof value === 'number' ? value : 0)
    return {
      inputTokens: number(usage.input),
      outputTokens: number(usage.output),
      cacheReadTokens: number(usage.cacheRead),
    }
  }
  return undefined
}

/**
 * Points in the turn where context occupancy has moved enough to be worth
 * re-reading: the prompt landing, each assistant reply (the only source of real
 * usage numbers), every tool result the reply pulled in, and compaction.
 */
const USAGE_SAMPLE_EVENTS = new Set([
  'turn_start',
  'message_end',
  'tool_execution_end',
  'compaction_end',
])

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
  const verbose = verboseLogging()
  const translator = createStreamTranslator({
    emit: (chunk) => sendChunk(turnId, chunk),
    onToolProgress: ({ toolCallId, toolName, text }) => {
      mainWin?.webContents.send('agentMode:toolProgress', {
        turnId,
        toolCallId,
        toolName,
        text,
      } as AgentModeToolProgress)
    },
  })
  try {
    const current = await ensureSession(config)
    let lastSample = ''
    const sampleUsage = () => {
      const summary = turnSummary(current.session)
      const fingerprint = JSON.stringify(summary)
      if (fingerprint === lastSample) return
      lastSample = fingerprint
      translator.update(summary)
    }
    currentTurn = {
      turnId,
      onEvent: (event) => {
        if (verbose) logEvent(event)
        translator.handle(event)
        if (USAGE_SAMPLE_EVENTS.has(event.type)) sampleUsage()
      },
    }
    const onAbort = () => current.session.abort()
    abortController.signal.addEventListener('abort', onAbort, { once: true })
    try {
      await current.session.prompt(prompt)
    } finally {
      abortController.signal.removeEventListener('abort', onAbort)
    }
    translator.finish(turnSummary(current.session))
    savePointer({
      sessionId: current.sessionId,
      workspaceDir: current.workspaceDir,
      sessionFilePath: current.session.getSessionStats().sessionFile ?? '',
      updatedAt: Date.now(),
    })
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`agent turn failed: ${message}`, LOG_SOURCE)
    // Deliver the failure as a stream error chunk BEFORE the finally block sends
    // turnDone (which closes the renderer-side stream).
    translator.fail(message)
    return { success: false, error: message }
  } finally {
    currentTurn = null
    activeAbort = null
    mainWin?.webContents.send('agentMode:turnDone', { turnId })
  }
}

export function cancelAgentTurn(): void {
  activeAbort?.abort()
}

/**
 * Manually trigger Pi's context compaction on the live session. Only valid
 * between turns: the renderer's message stream is a per-turn stream, so there is
 * no transcript to append a `compaction` part to (auto-compaction, which happens
 * mid-turn, does render one). The token counts come back in the result instead,
 * for the caller to surface.
 */
export async function compactAgentContext(
  customInstructions?: string,
): Promise<AgentModeCompactionResult> {
  if (activeAbort) {
    return { success: false, error: 'Cannot compact while an agent turn is running.' }
  }
  if (!active) {
    return { success: false, error: 'No active agent session yet — run a turn before compacting.' }
  }
  const current = active
  let result: CompactionResult | undefined
  currentTurn = {
    turnId: `compaction-${Date.now()}`,
    onEvent: (event) => {
      if (verboseLogging()) logEvent(event)
      if (event.type === 'compaction_end') result = event.result
    },
  }
  try {
    await current.session.compact(customInstructions)
    return {
      success: true,
      tokensBefore: result?.tokensBefore,
      tokensAfter: result?.estimatedTokensAfter,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Pi refuses to compact a session that is already small; that is a no-op,
    // not a failure the user needs to act on.
    if (/too small|nothing to compact/i.test(message)) {
      logger.info(`manual compaction skipped: ${message}`, LOG_SOURCE)
      return { success: true, noop: true }
    }
    logger.warn(`manual compaction failed: ${message}`, LOG_SOURCE)
    return { success: false, error: message }
  } finally {
    currentTurn = null
  }
}

/**
 * Hard reset: discard the live session AND its persisted pointer, and tear down
 * the workspace runtime (preview server + browser) so the next turn starts a
 * brand-new Pi conversation.
 */
export async function resetAgentSession(): Promise<void> {
  cancelAgentTurn()
  const sessionId = active?.sessionId ?? lastSessionId
  await endActiveSession()
  if (sessionId) clearPointer(sessionId)
  closeWorkspaceRuntime()
}

/**
 * Delete one archived session's main-side state: the persisted pointer and Pi's
 * session file. If the session is currently live it is disposed first.
 * Renderer-side state (the transcript record) is the agentMode store's business.
 */
export async function deleteAgentSession(
  sessionId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (active?.sessionId === sessionId) {
      cancelAgentTurn()
      await endActiveSession()
      closeWorkspaceRuntime()
    }
    const pointer = readSessionStore()[sessionId]
    if (pointer) {
      if (pointer.sessionFilePath && fs.existsSync(pointer.sessionFilePath)) {
        fs.rmSync(pointer.sessionFilePath)
      }
      clearPointer(sessionId)
    }
    closeBrowserSession(sessionId)
    logger.info(`deleted agent session ${sessionId}`, LOG_SOURCE)
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`failed to delete agent session ${sessionId}: ${message}`, LOG_SOURCE)
    return { success: false, error: message }
  }
}

export { submitAgentToolResult, COMPACTION_TOOL_NAME }
export type { ToolDefinition }
