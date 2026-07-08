import { BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createPi } from '@ai-sdk/harness-pi'
import { createJustBashSandbox } from '@ai-sdk/sandbox-just-bash'
import { Sandbox, ReadWriteFs } from 'just-bash'
import { appLoggerInstance } from './logging/logger.ts'

// ── Agent Mode (PoC): Pi coding-agent harness in the Electron main process ──
//
// Composition-style module holding at most ONE live HarnessAgent + session.
// The Pi harness runs in-process (no bridge); filesystem/shell operations go
// through a just-bash sandbox whose virtual filesystem is a ReadWriteFs rooted
// at the parent of the user-selected workspace folder. The harness session
// work dir is the workspace folder itself (sandboxConfig.workDir must be a
// relative path under the sandbox root, so we root at the parent and use the
// folder's basename). permissionMode is 'allow-all' — PoC only, scoped to
// that folder by the sandbox fs.
//
// Model routing: 'local' points Pi at the local llamacpp/openvino
// OpenAI-compatible endpoint by pre-writing a models.json (custom provider,
// api 'openai-completions') into Pi's per-session agent dir; 'cloud' passes
// provider API keys via createPi's auth.customEnv (falling back to host env).

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
      /** Pi model id (e.g. 'anthropic/claude-sonnet-4.6' or 'gpt-5.1-codex'). Optional: Pi/gateway default. */
      model?: string
      /** Env-style API keys, e.g. { ANTHROPIC_API_KEY: '...' } or { AI_GATEWAY_API_KEY: '...' }. */
      customEnv?: Record<string, string>
    }

export type AgentModeTurnConfig = {
  workspaceDir: string
  modelConfig: AgentModeModelConfig
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

let mainWin: BrowserWindow | null = null

export function setHarnessAgentMainWindow(win: BrowserWindow): void {
  mainWin = win
}

type ActiveSession = {
  configKey: string
  sessionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any
  sandbox: Sandbox
}

let active: ActiveSession | null = null
let activeAbort: AbortController | null = null
let sessionCounter = 0

// Cloud API keys that Pi's customEnv understands (see PiAuthOptions). Used to
// pick up ambient host credentials when the renderer does not supply any.
const CLOUD_ENV_KEYS = [
  'AI_GATEWAY_API_KEY',
  'AI_GATEWAY_BASE_URL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
]

function cloudEnvFromHost(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of CLOUD_ENV_KEYS) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

/**
 * Pi stores per-session host state under $TMPDIR/ai-sdk-harness/pi/<sessionId>.
 * We pre-write agent/models.json there so Pi's ModelRegistry can resolve the
 * local model (id + baseUrl + api). This mirrors the path construction inside
 * @ai-sdk/harness-pi (createPiSession) — acknowledged PoC coupling.
 */
function writeLocalModelsJson(
  sessionId: string,
  config: AgentModeModelConfig & { source: 'local' },
) {
  const safeSessionId = sessionId.replace(/[\\/: ]/g, '-')
  const hostAgentDir = path.join(tmpdir(), 'ai-sdk-harness', 'pi', safeSessionId, 'agent')
  fs.mkdirSync(hostAgentDir, { recursive: true })
  const modelsJson = {
    providers: {
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
    },
  }
  fs.writeFileSync(path.join(hostAgentDir, 'models.json'), JSON.stringify(modelsJson, null, 2))
}

function configKeyOf(config: AgentModeTurnConfig): string {
  return JSON.stringify([config.workspaceDir, config.modelConfig])
}

async function destroyActiveSession(): Promise<void> {
  const current = active
  active = null
  if (!current) return
  try {
    await current.session.destroy()
  } catch (error) {
    logger.warn(`failed to destroy harness session: ${error}`, LOG_SOURCE)
  }
}

async function ensureSession(config: AgentModeTurnConfig): Promise<ActiveSession> {
  const configKey = configKeyOf(config)
  if (active && active.configKey === configKey) return active
  await destroyActiveSession()

  if (
    !fs.existsSync(config.workspaceDir) ||
    !fs.statSync(config.workspaceDir).isDirectory()
  ) {
    throw new Error(`Workspace folder does not exist: ${config.workspaceDir}`)
  }
  // Resolve symlinks (e.g. macOS /tmp -> /private/tmp): ReadWriteFs rejects
  // paths whose realpath escapes its root.
  const workspaceDir = fs.realpathSync(path.resolve(config.workspaceDir))

  // Root the sandbox fs at the parent so the harness session work dir (a
  // relative path under the sandbox root) can be the selected folder itself.
  const rootDir = path.dirname(workspaceDir)
  const workDirName = path.basename(workspaceDir)
  const sandbox = await Sandbox.create({
    fs: new ReadWriteFs({ root: rootDir }),
    cwd: '/',
    // just-bash's defense-in-depth layer patches Module._load during script
    // execution; the Electron main bundle is CJS with externalized deps, so
    // lazy require() calls inside the execution context (ReadWriteFs hitting
    // real node:fs) trip it. It is documented as a secondary layer — the
    // actual isolation here is the ReadWriteFs root scoping.
    defenseInDepth: false,
  })

  const sessionId = `aipg-agent-${Date.now()}-${++sessionCounter}`

  const model =
    config.modelConfig.source === 'local' ? config.modelConfig.model : config.modelConfig.model
  const auth =
    config.modelConfig.source === 'cloud'
      ? {
          customEnv: {
            ...cloudEnvFromHost(),
            ...config.modelConfig.customEnv,
          },
        }
      : // Local models resolve via the pre-written models.json (provider
        // 'aipg-local'); no ambient/cloud credentials are exposed to Pi.
        { customEnv: { AIPG_PLACEHOLDER_API_KEY: 'unused' } }

  if (config.modelConfig.source === 'local') {
    writeLocalModelsJson(sessionId, config.modelConfig)
  }

  const harness = createPi({
    ...(model ? { model } : {}),
    auth,
  })

  const agent = new HarnessAgent({
    harness,
    sandbox: createJustBashSandbox({ sandbox }),
    sandboxConfig: { workDir: workDirName },
    permissionMode: 'allow-all',
    onLog: (event: { message?: string }) => {
      logger.info(`[pi] ${JSON.stringify(event.message ?? event)}`, LOG_SOURCE)
    },
  })

  const session = await agent.createSession({ sessionId })
  active = { configKey, sessionId, agent, session, sandbox }
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
    const uiStream = result.toUIMessageStream({
      sendReasoning: true,
      sendStart: true,
      sendFinish: true,
      // The default masks failures as 'An error occurred.' (to avoid leaking
      // server internals to a remote client). Main process and renderer run on
      // the same machine, so surface the real cause (e.g. context overflow).
      onError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    })
    for await (const chunk of uiStream) {
      mainWin?.webContents.send('agentMode:streamChunk', { turnId, chunk } as AgentModeStreamChunk)
    }
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
    // A fresh session is safer than resuming one whose turn blew up mid-way.
    await destroyActiveSession()
    return { success: false, error: message }
  } finally {
    activeAbort = null
    mainWin?.webContents.send('agentMode:turnDone', { turnId })
  }
}

export function cancelAgentTurn(): void {
  activeAbort?.abort()
}

export async function resetAgentSession(): Promise<void> {
  cancelAgentTurn()
  await destroyActiveSession()
}
