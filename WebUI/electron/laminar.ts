import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { app } from 'electron'
import { z } from 'zod'
import { appLoggerInstance } from './logging/logger.ts'
import { externalResourcesDir } from './util.ts'

// ── Laminar tracing (dev-only PoC) ───────────────────────────────────────────
//
// Observability for the agentic system: one trace per Pi agent run (LLM + tool
// spans, via the official `@lmnr-ai/pi-extension`) and one per Vercel AI SDK
// chat call (registered in the renderer, see src/lib/laminarTelemetry.ts). Both
// export to a self-hosted Laminar the developer runs locally.
//
// Deliberately unconfigured by default: without `external/laminar.dev.json`
// nothing is imported, nothing is initialized, and the app runs exactly as it
// did before. `@lmnr-ai/lmnr` is a devDependency, so a packaged build has no
// copy of it to load — hence the `isPackaged` gate and the dynamic import.
//
// The renderer needs the same numbers to register its own telemetry, but must
// not have the project API key compiled into its bundle, so the config is read
// here and handed over through the `getLaminarConfig` IPC.

const logger = appLoggerInstance
const LOG_SOURCE = 'laminar'

const CONFIG_FILE = 'laminar.dev.json'

/**
 * The Laminar SDK splits the endpoint into host and ports (`baseUrl` carries no
 * port), because traces and metadata go to different ones. Defaults are the
 * docker-compose app-server's.
 */
const LaminarConfigSchema = z.object({
  projectApiKey: z.string().min(1),
  baseUrl: z
    .string()
    .min(1)
    .default('http://localhost')
    .transform((value) => value.replace(/\/+$/, '')),
  httpPort: z.number().int().positive().default(8000),
  grpcPort: z.number().int().positive().default(8001),
})

export type LaminarConfig = z.infer<typeof LaminarConfigSchema>

/** `undefined` until resolved once; `null` when tracing is off for this run. */
let resolved: LaminarConfig | null | undefined

/**
 * Laminar config for this run, or null when tracing is off (no file, packaged
 * build, or unreadable/incomplete file). Read once — the file is a developer's
 * local opt-in, not something that changes while the app runs.
 */
export function laminarConfig(): LaminarConfig | null {
  if (resolved !== undefined) return resolved
  resolved = null
  if (app.isPackaged) return resolved
  const configPath = path.join(externalResourcesDir(), CONFIG_FILE)
  let raw: string
  try {
    raw = fs.readFileSync(configPath, 'utf-8')
  } catch {
    // The normal case: no developer opted in. Not worth a log line.
    return resolved
  }
  const parsed = LaminarConfigSchema.safeParse(JSON.parse(raw) as unknown)
  if (!parsed.success) {
    logger.warn(`ignoring ${CONFIG_FILE}: ${parsed.error.message}`, LOG_SOURCE)
    return resolved
  }
  resolved = parsed.data
  return resolved
}

/**
 * Initialize the Laminar SDK for the main process, before any Pi session is
 * built.
 *
 * The Pi extension initializes the SDK itself, but only ever passes `baseUrl` —
 * so on a self-hosted instance it would export to the cloud's default ports
 * (443/8443) and every span would vanish. Its `initTracing` is a no-op once the
 * SDK is initialized, so getting in first is what makes the ports stick.
 *
 * It also resolves its own on/off switch from `LMNR_PROJECT_API_KEY`, and
 * disables itself when that is absent, so the key is put on the environment of
 * this process too.
 */
export async function initLaminarTracing(): Promise<void> {
  const config = laminarConfig()
  if (!config) return
  try {
    process.env.LMNR_PROJECT_API_KEY = config.projectApiKey
    process.env.LMNR_BASE_URL = config.baseUrl
    const { Laminar } = await import('@lmnr-ai/lmnr')
    if (!Laminar.initialized()) {
      Laminar.initialize({
        projectApiKey: config.projectApiKey,
        baseUrl: config.baseUrl,
        httpPort: config.httpPort,
        grpcPort: config.grpcPort,
        // Spans are minted from Pi's own event stream, so the SDK must not also
        // patch the LLM libraries in this process.
        instrumentModules: {},
        // The gRPC exporter would need a native addon inside Electron.
        forceHttp: true,
      })
    }
    logger.info(
      `tracing to ${config.baseUrl}:${config.httpPort} (grpc ${config.grpcPort})`,
      LOG_SOURCE,
    )
  } catch (error) {
    // Fail open: an observability problem must never keep the app from starting.
    logger.warn(`tracing disabled: ${error}`, LOG_SOURCE)
    resolved = null
  }
}

/**
 * Laminar's AI SDK integration, living in main on behalf of the renderer.
 *
 * The renderer cannot run the SDK (browser page, `nodeIntegration` off), but AI
 * SDK 7 telemetry is plain data keyed by `callId`, so the renderer forwards its
 * events here and they are replayed into the official integration — which is
 * what maps them to Laminar's span types, `gen_ai.*` attributes and token
 * counts. See src/lib/laminarTelemetry.ts for the sending half.
 */
let aiSdkTelemetry: Record<string, ((event: unknown) => void) | undefined> | null | undefined

async function chatTelemetry(): Promise<typeof aiSdkTelemetry> {
  if (aiSdkTelemetry !== undefined) return aiSdkTelemetry
  aiSdkTelemetry = null
  const config = laminarConfig()
  if (!config) return aiSdkTelemetry
  try {
    const { LaminarAiSdkTelemetry } = await import('@lmnr-ai/lmnr')
    // Already initialized by initLaminarTracing, so no options are needed: the
    // integration picks up the same tracer, endpoint and project key.
    aiSdkTelemetry = new LaminarAiSdkTelemetry() as unknown as NonNullable<typeof aiSdkTelemetry>
  } catch (error) {
    logger.warn(`chat traces disabled: ${error}`, LOG_SOURCE)
  }
  return aiSdkTelemetry
}

/**
 * Replay one forwarded AI SDK telemetry event. `payload` is the JSON the
 * renderer serialized (functions and cycles already removed).
 */
export async function handleChatTelemetryEvent(name: string, payload: string): Promise<void> {
  const telemetry = await chatTelemetry()
  const callback = telemetry?.[name]
  if (!callback) return
  try {
    const event = JSON.parse(payload) as Record<string, unknown>
    // A serialized Error is a plain object again; the integration only records
    // an exception properly for a real one.
    const failure = event.error
    if (failure && typeof failure === 'object' && 'message' in failure) {
      const rebuilt = new Error(String((failure as { message?: unknown }).message))
      rebuilt.stack = String((failure as { stack?: unknown }).stack ?? rebuilt.stack)
      event.error = rebuilt
    }
    callback(event)
  } catch (error) {
    logger.warn(`dropped chat telemetry event '${name}': ${error}`, LOG_SOURCE)
  }
}

/** Flush whatever has not been exported yet. Called from the app's teardown. */
export async function shutdownLaminarTracing(): Promise<void> {
  if (!laminarConfig()) return
  try {
    const { Laminar } = await import('@lmnr-ai/lmnr')
    if (Laminar.initialized()) await Laminar.shutdown()
  } catch (error) {
    logger.warn(`failed to flush traces: ${error}`, LOG_SOURCE)
  }
}

/**
 * Path of the Laminar Pi extension, for `additionalExtensionPaths`, or
 * undefined when tracing is off or the package is absent. Pi loads it with jiti,
 * so the TypeScript entry from its own `pi.extensions` manifest is what to hand
 * over — same arrangement as the memory capability's `pi-hermes-memory`.
 */
export function laminarPiExtensionPath(): string | undefined {
  if (!laminarConfig()) return undefined
  try {
    return createRequire(import.meta.url).resolve('@lmnr-ai/pi-extension/src/index.ts')
  } catch (error) {
    logger.warn(`agent traces disabled, @lmnr-ai/pi-extension is missing: ${error}`, LOG_SOURCE)
    return undefined
  }
}
