import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionUIContext,
  ModelRuntime,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { appLoggerInstance } from '../logging/logger.ts'
import { loadPi } from './piRuntime.ts'
import { closeAllBrowserSessions, closeBrowserSession } from '../subprocesses/agentBrowser.ts'
import {
  buildSkillsPromptSection,
  rejectAllPendingToolCalls,
  setToolBridgeWindow,
  submitAgentToolResult,
  writeAgentSkills,
} from './piCustomTools.ts'
import {
  DEFAULT_CAPABILITY_IDS,
  listCapabilities,
  mcpCapabilityId,
  resolveCapabilities,
  type CapabilityHost,
  type CapabilityInfo,
} from './capabilities/index.ts'
import { createAgentToolAccess, type AgentToolAccess } from './piToolOperations.ts'
import {
  buildWorkspaceInstructions,
  closeWorkspaceRuntime,
  ensureWorkspaceRuntime,
} from './piWorkspaceRuntime.ts'
import { endThinking, planExists, PLAN_FILE, thinkingIsOn, writesPlan } from './planningPhase.ts'
import { createSamplingExtension } from './piSampling.ts'
import { observeAgentModelCalls } from './piCallTiming.ts'
import { laminarConfig, laminarPiExtensionPath } from '../laminar.ts'
import {
  clearAgentTraceContext,
  setAgentTraceContext,
  type InferenceTraceContext,
} from '../laminarAttributes.ts'
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

let modelRuntime: ModelRuntime | null = null

/**
 * The model runtime every session shares. No `models.json` behind it (`modelsPath:
 * null`): every model the app offers is registered at runtime, and models are
 * always looked up by our own provider id, so Pi's builtin catalog can never
 * capture a request (a cloud model id like 'gpt-4o' would otherwise resolve to
 * Pi's own `openai` provider and fail on missing credentials). Credentials stay
 * in memory — `setRuntimeApiKey` is an in-memory overlay and the auth file we
 * point at is only ever read, since agent mode never logs a provider in.
 */
async function ensureModelRuntime(): Promise<ModelRuntime> {
  if (modelRuntime) return modelRuntime
  const pi = await loadPi()
  modelRuntime = await pi.ModelRuntime.create({
    authPath: path.join(piAgentDir(), 'auth.json'),
    modelsPath: null,
  })
  return modelRuntime
}

/**
 * Completion budget for one agent step, which is not the same thing as a chat
 * answer: a step is usually a tool call, and the arguments of a `write` carry a
 * whole file. Pi refuses a tool call whose arguments were cut off ("the response
 * hit the output token limit"), so a 4096-token ceiling made a game of any size
 * unbuildable — every attempt died on the same truncated write.
 *
 * Half the context window is the hard bound (the rest has to hold the
 * conversation, and Pi compacts once the input passes `contextWindow` minus its
 * 16k reserve), so a small window still gets a proportionate share: the local
 * target is only reached from the 64k window up, and the agent presets ask for
 * 128k.
 */
const OUTPUT_TOKEN_TARGET = { local: 32768, cloud: 16384 } as const

function outputTokenBudget(contextWindow: number, source: 'local' | 'cloud'): number {
  return Math.min(OUTPUT_TOKEN_TARGET[source], Math.floor(contextWindow / 2))
}

/**
 * What the model accepts as input. A vision model has to be declared as one or
 * Pi withholds every image its tools produce — an attached sprite read from the
 * workspace, a screenshot of the page the agent just built — and substitutes a
 * note saying the model cannot see images.
 */
function modelInput(config: AgentModeModelConfig): ('text' | 'image')[] {
  return config.supportsVision ? ['text', 'image'] : ['text']
}

/** Register the turn's model as a provider entry and return its Pi model id. */
async function registerModel(
  config: AgentModeModelConfig,
): Promise<{ provider: string; modelId: string }> {
  const runtime = await ensureModelRuntime()
  if (config.source === 'local') {
    const contextWindow = config.contextWindow ?? 8192
    runtime.registerProvider(LOCAL_PROVIDER, {
      name: 'AI Playground local backend',
      baseUrl: config.baseUrl,
      api: 'openai-completions',
      apiKey: 'unused',
      models: [
        {
          id: config.model,
          name: config.model,
          reasoning: false,
          input: modelInput(config),
          contextWindow,
          maxTokens: outputTokenBudget(contextWindow, 'local'),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        },
      ],
    })
    await runtime.setRuntimeApiKey(LOCAL_PROVIDER, 'unused')
    observeModelCallsWhenTracing(config.baseUrl)
    return { provider: LOCAL_PROVIDER, modelId: config.model }
  }

  // The X-Cloud-* headers tell the loopback proxy where to forward and which
  // stored key to inject, so `authHeader: false` suppresses Pi's own
  // Authorization header and the api key is a placeholder.
  const contextWindow = config.contextWindow ?? CLOUD_DEFAULT_CONTEXT_WINDOW
  runtime.registerProvider(CLOUD_PROVIDER, {
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
        input: modelInput(config),
        contextWindow,
        maxTokens: outputTokenBudget(contextWindow, 'cloud'),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  })
  await runtime.setRuntimeApiKey(CLOUD_PROVIDER, 'unused')
  observeModelCallsWhenTracing(`${config.proxyBaseUrl}/v1`)
  return { provider: CLOUD_PROVIDER, modelId: config.model }
}

/**
 * Time this model's calls, so a trace can carry prefill and generation speed.
 * Only when a developer opted into tracing — it means observing the response
 * stream on its way past, which nothing else in the app asks for.
 */
function observeModelCallsWhenTracing(baseUrl: string): void {
  if (laminarConfig()) observeAgentModelCalls(baseUrl)
}

/**
 * What the trace should say about this session's turns. A getter, not a value:
 * the planning phase can switch thinking off between two steps of one run
 * (planningPhase.ts mutates the sampling bag), and the span that follows should
 * report what was actually sent.
 */
function traceContext(
  config: AgentModeModelConfig,
  getSampling: () => Record<string, unknown> | undefined,
): () => InferenceTraceContext {
  const contextWindow =
    config.contextWindow ?? (config.source === 'cloud' ? CLOUD_DEFAULT_CONTEXT_WINDOW : 8192)
  return () => {
    const sampling = getSampling() ?? {}
    const kwargs = (sampling.chat_template_kwargs ?? {}) as Record<string, unknown>
    return {
      backend: config.source === 'cloud' ? 'cloud' : config.backend,
      ...(config.source === 'local' && config.device ? { device: config.device } : {}),
      ...(config.source === 'cloud' ? { cloudProvider: config.providerId } : {}),
      ...(typeof kwargs.enable_thinking === 'boolean' ? { thinking: kwargs.enable_thinking } : {}),
      ...(typeof kwargs.reasoning_effort === 'string'
        ? { reasoningEffort: kwargs.reasoning_effort }
        : {}),
      sampling: {
        ...(typeof sampling.temperature === 'number' ? { temperature: sampling.temperature } : {}),
        ...(typeof sampling.top_p === 'number' ? { topP: sampling.top_p } : {}),
        maxTokens: outputTokenBudget(contextWindow, config.source),
      },
    }
  }
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
  /**
   * The sampling bag the live model holds. Pi re-reads it per request, so
   * `planningPhase.ts` can end thinking mid-turn by mutating it.
   */
  samplingParams?: Record<string, unknown>
  /** Whether this session plans in `design.md` and stops thinking once it exists. */
  plansOnDisk: boolean
}

let active: ActiveSession | null = null
let activeAbort: AbortController | null = null
/** Session id of the most recent session (for reset to clear its pointer). */
let lastSessionId: string | null = null
/** Per-turn sink: set for the duration of a turn, so events can be routed. */
let currentTurn: {
  turnId: string
  onEvent: (event: AgentSessionEvent) => void
  /** Host-side text (an extension's slash command output) for the transcript. */
  notice?: (text: string) => void
} | null = null

function configKeyOf(config: AgentModeTurnConfig): string {
  // The tool set is fixed at session construction, so a changed tool set needs a
  // rebuild — including the enabled capabilities, which decide what tools,
  // skills and extensions the session gets. The session id is part of the key
  // too: switching conversations in the renderer must rebuild even when
  // everything else matches.
  return JSON.stringify([
    config.sessionId,
    config.workspaceDir,
    config.modelConfig,
    config.toolSpecs ?? [],
    // Part of the system prompt, which is fixed once the session exists: editing
    // the preset's instructions (or switching preset) has to rebuild.
    config.instructions ?? '',
    enabledCapabilityIds(config),
    config.unsandboxed ?? false,
    config.planningThinkingOnly ?? false,
  ])
}

/**
 * The capabilities this turn asks for. Older persisted sessions (and any caller
 * that has not been updated) carry no list, so they fall back to the defaults
 * plus whatever MCP servers they had attached.
 */
function enabledCapabilityIds(config: AgentModeTurnConfig): string[] {
  const ids = config.capabilities ?? [
    ...DEFAULT_CAPABILITY_IDS,
    ...(config.mcpServerIds ?? []).map((serverId) => mcpCapabilityId(serverId)),
  ]
  return [...new Set(ids)].sort()
}

function sendChunk(turnId: string, chunk: StreamChunk): void {
  mainWin?.webContents.send('agentMode:streamChunk', { turnId, chunk } as AgentModeStreamChunk)
}

async function endActiveSession(): Promise<void> {
  const current = active
  active = null
  clearAgentTraceContext()
  rejectAllPendingToolCalls('Agent session ended.')
  if (!current) return
  current.unsubscribe()
  await shutdownSessionExtensions(current.session)
  try {
    current.session.dispose()
  } catch (error) {
    logger.warn(`failed to dispose agent session: ${error}`, LOG_SOURCE)
  }
  await current.access.dispose()
}

/**
 * Give extensions their `session_shutdown` before the session goes away. Pi's own
 * front-ends do this from `AgentSessionRuntime.dispose()`, which we do not use
 * (we own the session directly), and `AgentSession.dispose()` alone does not
 * emit it — without this, persistent memory would never flush what it learned
 * and its SQLite handle would be left behind.
 */
async function shutdownSessionExtensions(session: AgentSession): Promise<void> {
  try {
    if (!session.extensionRunner.hasHandlers('session_shutdown')) return
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
  } catch (error) {
    logger.warn(`extension shutdown failed: ${briefly(error)}`, LOG_SOURCE)
  }
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
  const models = await ensureModelRuntime()
  const registered = models.getModel(provider, modelId)
  if (!registered) {
    throw new Error(`Model '${modelId}' could not be registered with Pi.`)
  }
  // The sampling for every request of this session. Pi's agent path reads no
  // sampling from the model, so it is merged into each request body by the
  // extension in piSampling.ts, which reads this bag live. It is copied because
  // the planning phase mutates it (planningPhase.ts) and the turn config it came
  // from is what session reuse is keyed on.
  const samplingParams =
    config.modelConfig.source === 'local'
      ? copySamplingParams(config.modelConfig.samplingParams, config.modelConfig.backend)
      : undefined
  setAgentTraceContext(traceContext(config.modelConfig, () => samplingParams))
  // The model still carries it as well, since that is where pi-ai's own request
  // builders would look if the agent path ever grew support for it.
  const model = samplingParams ? { ...registered, samplingParams } : registered

  // Everything optional the agent can do is a capability the user enabled for
  // this session (capabilities/index.ts): its tools, skills and Pi extensions.
  const capabilityHost: CapabilityHost = {
    sessionId,
    workspaceDir,
    toolSpecs: config.toolSpecs ?? [],
    agentDir: piAgentDir(),
    contextWindow: config.modelConfig.contextWindow,
  }
  const capabilities = await resolveCapabilities(capabilityHost, enabledCapabilityIds(config))
  logger.info(
    `capabilities: ${capabilities.resolved.map(({ capability }) => capability.id).join(', ') || 'none'}` +
      (capabilities.dormantIds.length > 0
        ? ` (dormant: ${capabilities.dormantIds.join(', ')})`
        : ''),
    LOG_SOURCE,
  )

  // Skills are progressive disclosure: only name + description sit in the system
  // prompt until the model reads one, so a capability's workflow instructions
  // cost almost nothing per step.
  const skillsDir = path.join(piAgentDir(), 'skills')
  const skills = writeAgentSkills(skillsDir, capabilities.skillSources)

  const access = await createAgentToolAccess({ workspaceDir, unsandboxed, skillsDir, skills })

  // Serve the workspace over localhost so the agent can preview/debug pages over
  // HTTP instead of file://. The runtime is keyed by session so the port stays
  // stable for the whole conversation.
  const runtime = await ensureWorkspaceRuntime(sessionId, workspaceDir)

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

  const announcedSkills = skills.filter((skill) =>
    capabilities.announcedSkillNames.includes(skill.name),
  )
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir: piAgentDir(),
    // `noExtensions` only suppresses auto-discovery of the user's own extensions;
    // the capability factories and bundled package paths below still load. No
    // themes or prompt templates in the host app, and no skill loading either:
    // Pi would advertise the skills at their host path, which the sandboxed read
    // tool cannot open. They are announced below with a location that matches
    // the active mode instead.
    noExtensions: true,
    noThemes: true,
    noPromptTemplates: true,
    noSkills: true,
    // `noSkills` only stops path discovery: an extension can still contribute
    // skill directories through `resources_discover` (persistent memory
    // contributes the ones it wrote itself), and Pi would then announce them at
    // their host path. Those skills reach the model through the capability's
    // `buildSkills` instead, so Pi's own skill list stays empty in every mode.
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    extensionFactories: [
      ...capabilities.extensionFactories,
      // Pi's agent path ignores `Model.samplingParams`, so the turn's sampling
      // is merged into each request here instead (piSampling.ts).
      createSamplingExtension(() => samplingParams),
    ],
    // Laminar's own Pi extension traces the run (one trace per agent run, LLM
    // and tool spans). Nothing when no developer opted into tracing, and never
    // a capability: it is not something the user picks per session.
    additionalExtensionPaths: [
      ...capabilities.extensionPaths,
      ...[laminarPiExtensionPath()].filter((entry): entry is string => entry !== undefined),
    ],
    // The workspace orientation the model would otherwise have to guess. Built
    // fresh on every session build, so it always carries the live preview URL.
    appendSystemPrompt: [
      instructions,
      // The preset's own instructions come last so they read as the task the app
      // was opened for, after the environment it is working in.
      buildSkillsPromptSection(announcedSkills, access.skillsRoot),
      capabilities.dormantPromptSection,
      (config.instructions ?? '').trim(),
    ].filter((section) => section !== ''),
  })
  await resourceLoader.reload()

  const { session } = await pi.createAgentSession({
    cwd: access.cwd,
    agentDir: piAgentDir(),
    model,
    modelRuntime: models,
    sessionManager,
    settingsManager: pi.SettingsManager.inMemory(),
    // Pi's own file/shell tools are replaced by the mode-specific ones built in
    // piToolOperations.ts, so its builtins are switched off entirely. Capability
    // tools arrive through their extensions, not here.
    noTools: 'builtin',
    customTools: access.definitions,
    resourceLoader,
  })

  // createAgentSession loads extensions but does not start them: `session_start`
  // and `resources_discover` only fire from bindExtensions, and third-party
  // extensions (persistent memory) do all their work there.
  await bindSessionExtensions(session)
  hideDormantTools(session, capabilities.dormantToolNames)

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
    samplingParams,
    plansOnDisk:
      config.planningThinkingOnly === true && enabledCapabilityIds(config).includes('game-studio'),
  }
}

/**
 * A private copy of the turn's sampling, deep enough that switching thinking off
 * cannot reach back into the caller's config object.
 *
 * A traced llama.cpp turn also asks the server to report its own timings, the
 * way chat always does: it is the only source of prefill-vs-generation speed
 * and prompt-cache reuse. Nothing in the agent consumes them otherwise, so the
 * field is not sent when no developer is tracing.
 */
function copySamplingParams(
  params: Record<string, unknown> | undefined,
  backend: 'llamaCPP' | 'openVINO' | undefined,
): Record<string, unknown> | undefined {
  const timings = backend === 'llamaCPP' && laminarConfig() ? { timings_per_token: true } : {}
  if (!params) return Object.keys(timings).length > 0 ? timings : undefined
  const kwargs = params.chat_template_kwargs
  return {
    ...params,
    ...timings,
    ...(kwargs && typeof kwargs === 'object'
      ? { chat_template_kwargs: { ...(kwargs as Record<string, unknown>) } }
      : {}),
  }
}

/**
 * What the agent could do in a session built right now, for the settings UI.
 * Comes from the same catalog the session build uses, so the checkboxes cannot
 * drift from what the agent actually gets — including which capabilities are
 * unavailable and why.
 */
export function listAgentCapabilities(options: {
  workspaceDir?: string
  toolSpecs?: AgentToolSpec[]
  mcpServerIds?: string[]
}): CapabilityInfo[] {
  return listCapabilities(
    {
      sessionId: 'capability-listing',
      workspaceDir: options.workspaceDir ?? '',
      toolSpecs: options.toolSpecs ?? [],
      agentDir: piAgentDir(),
    },
    options.mcpServerIds ?? [],
  )
}

/**
 * Start the session's extensions. Pi's own front-ends do this after building a
 * session; the bindings are what an extension's `ctx` can reach, so the ones
 * that make no sense without a terminal UI (forking, session switching, tree
 * navigation) are refused with a clear message instead of pretending to work.
 */
async function bindSessionExtensions(session: AgentSession): Promise<void> {
  const unsupported = (action: string) => async () => {
    throw new Error(`'${action}' is not available in AI Playground's agent mode.`)
  }
  await session.bindExtensions({
    // Not an interactive terminal: no UI prompts, and output is a message
    // stream the renderer consumes.
    mode: 'rpc',
    uiContext: extensionUiContext(),
    commandContextActions: {
      waitForIdle: () => session.agent.waitForIdle(),
      reload: () => session.reload(),
      newSession: unsupported('new session'),
      fork: unsupported('fork'),
      navigateTree: unsupported('navigate tree'),
      switchSession: unsupported('switch session'),
    },
    abortHandler: () => session.abort(),
    shutdownHandler: async () => {
      logger.info('extension requested shutdown; ending the agent session', LOG_SOURCE)
      await endActiveSession()
    },
    onError: (error) => logger.warn(`extension error: ${briefly(error)}`, LOG_SOURCE),
  })
}

/**
 * What an extension's `ctx.ui` can do here. Pi's default in `rpc` mode is a
 * silent no-op, which would swallow the output of every slash command (memory's
 * `/memory-insights` writes its whole report through `notify`), so notifications
 * are routed into the running turn's transcript instead. Everything interactive
 * stays unavailable — there is no terminal to prompt in, and an extension asking
 * for input must fall back rather than hang.
 */
function extensionUiContext(): ExtensionUIContext {
  const surface = (message: string, type?: 'info' | 'warning' | 'error') => {
    if (type === 'error') logger.warn(`extension notice: ${briefly(message)}`, LOG_SOURCE)
    else logger.info(`extension notice: ${briefly(message)}`, LOG_SOURCE)
    currentTurn?.notice?.(message)
  }
  const context = {
    notify: surface,
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    custom: async () => undefined,
    onTerminalInput: () => () => {},
    setStatus: (_key: string, text: string | undefined) => {
      if (text) surface(text)
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => '',
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Agent mode has no theme support.' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  }
  // The TUI-only members (`theme`, component factories) have no meaning outside
  // a terminal; the cast keeps the stub to what an extension can usefully call.
  return context as unknown as ExtensionUIContext
}

/**
 * Hide the tools of capabilities that start dormant. Everything Pi registered is
 * active by default, which is the fast path (see
 * docs/agent-capability-benchmark.md), so this narrows rather than pins the set —
 * tools a third-party extension registered for itself stay untouched.
 */
function hideDormantTools(session: AgentSession, dormantToolNames: string[]): void {
  if (dormantToolNames.length === 0) return
  const dormant = new Set(dormantToolNames)
  session.setActiveToolsByName(session.getActiveToolNames().filter((name) => !dormant.has(name)))
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

/**
 * Thinking pays for itself while the agent decides what to build and stops
 * paying once that decision is written down, so it ends when `design.md` does.
 * Returns the event sink that watches for the plan being written; a plan already
 * on disk ends it before the turn's first request.
 */
function watchPlanningPhase(current: ActiveSession): (event: AgentSessionEvent) => void {
  const stop = (reason: string) => {
    if (!endThinking(current.samplingParams)) return
    logger.info(
      `planning done (${reason}): thinking off for the rest of the session`,
      LOG_SOURCE,
      true,
    )
  }
  if (!current.plansOnDisk || !thinkingIsOn(current.samplingParams)) return () => {}
  if (planExists(current.workspaceDir)) stop(`${PLAN_FILE} already written`)

  // `tool_execution_end` carries no arguments, so the call that targets the plan
  // is remembered when it starts and acted on only if it succeeded.
  const writingPlan = new Set<string>()
  return (event) => {
    if (event.type === 'tool_execution_start' && writesPlan(event.toolName, event.args)) {
      writingPlan.add(event.toolCallId)
      return
    }
    if (event.type !== 'tool_execution_end' || !writingPlan.delete(event.toolCallId)) return
    if (!event.isError) stop(`${PLAN_FILE} written`)
  }
}

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
 * A turn ends when the model stops asking for tools, so a reply that carries
 * neither an answer nor a tool call ends it mid-task: the model meant to call a
 * tool but emitted the call markup inside its thinking channel, the provider
 * reported a plain `stop` with no tool call, and Pi's loop had nothing left to
 * run. Nothing failed, so without this check the UI simply goes idle halfway
 * through the job — which reads as the agent being interrupted.
 */
function endedWithoutReplyOrToolCall(session: AgentSession): boolean {
  const last = session.messages.at(-1) as { role?: string; content?: unknown } | undefined
  if (last?.role !== 'assistant') return false
  const content = last.content
  if (typeof content === 'string') return content.trim() === ''
  if (!Array.isArray(content)) return false
  return !content.some((entry) => {
    const part = entry as { type?: string; text?: string }
    if (part.type === 'toolCall') return true
    return part.type === 'text' && (part.text ?? '').trim() !== ''
  })
}

/**
 * The provider's complaint when the model call itself failed. Pi records a
 * failed call as an assistant message with `stopReason: 'error'` and resolves
 * the prompt normally instead of throwing, so an unusable model — a model id the
 * provider has retired, a revoked key, a rejected payload — arrives here looking
 * exactly like a turn that ended without a reply, and the nudge above would
 * answer a 422 with "the model ended its turn without an answer".
 */
function modelCallError(session: AgentSession): string | undefined {
  const last = session.messages.at(-1) as
    | { role?: string; stopReason?: string; errorMessage?: string }
    | undefined
  if (last?.role !== 'assistant' || last.stopReason !== 'error') return undefined
  return readableProviderError(last.errorMessage) ?? 'The model call failed without a reason.'
}

/**
 * The part of a provider error worth reading. OpenAI-compatible endpoints answer
 * with `{"error": {"message": …}}`, usually wrapped in status text and routing
 * metadata that buries the one sentence naming the actual problem.
 */
function readableProviderError(raw: string | undefined): string | undefined {
  const text = raw?.trim()
  if (!text) return undefined
  const jsonStart = text.indexOf('{')
  if (jsonStart !== -1) {
    try {
      const payload = JSON.parse(text.slice(jsonStart)) as {
        error?: { message?: string }
        message?: string
      }
      const message = payload.error?.message ?? payload.message
      if (message) {
        const prefix = text
          .slice(0, jsonStart)
          .replace(/[\s:]+$/, '')
          .trim()
        return prefix ? `${prefix}: ${message}` : message
      }
    } catch {
      // Not JSON, or truncated mid-payload: fall through to the raw text.
    }
  }
  return text.length > PROVIDER_ERROR_MAX ? `${text.slice(0, PROVIDER_ERROR_MAX)}…` : text
}

const PROVIDER_ERROR_MAX = 1000

/** Spent once per turn to buy back a task that a malformed tool call cut short. */
const CONTINUE_AFTER_SILENT_TURN =
  'Your previous message ended without a reply and without a tool call, so nothing ran — the ' +
  'tool call you meant to make did not come through. Pick the task back up: either make that ' +
  'call again, with all of its required arguments, or write your answer.'

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
    const planning = watchPlanningPhase(current)
    currentTurn = {
      turnId,
      onEvent: (event) => {
        if (verbose) logEvent(event)
        planning(event)
        translator.handle(event)
        if (USAGE_SAMPLE_EVENTS.has(event.type)) sampleUsage()
      },
      notice: (text) => translator.notice(text),
    }
    const onAbort = () => current.session.abort()
    abortController.signal.addEventListener('abort', onAbort, { once: true })
    try {
      // A failed model call is reported, not nudged: asking a model the provider
      // just refused to serve only produces the same refusal again.
      const failIfModelErrored = () => {
        if (abortController.signal.aborted) return
        const failure = modelCallError(current.session)
        if (failure) throw new Error(failure)
      }
      await current.session.prompt(prompt)
      failIfModelErrored()
      const stalled = () =>
        !abortController.signal.aborted && endedWithoutReplyOrToolCall(current.session)
      if (stalled()) {
        logger.warn('turn ended with neither a reply nor a tool call; nudging once', LOG_SOURCE)
        await current.session.prompt(CONTINUE_AFTER_SILENT_TURN)
        failIfModelErrored()
        if (stalled()) {
          translator.notice(
            'The model ended its turn without an answer and without running a tool, and did not ' +
              'pick the task back up when asked to continue. Send a message to carry on.',
          )
        }
      }
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
 * Shut the agent down for app exit: the live session gets its extension
 * `session_shutdown` (persistent memory flushes there) and the preview
 * server/browser are closed. Unlike `resetAgentSession` the persisted pointer
 * survives, so the conversation resumes on the next launch.
 */
export async function shutdownAgentMode(): Promise<void> {
  cancelAgentTurn()
  await endActiveSession()
  closeWorkspaceRuntime()
  // Windows left open by any earlier session too: a hidden survivor keeps the
  // whole app alive (see closeAllBrowserSessions).
  closeAllBrowserSessions()
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
