import { appLoggerInstance } from '../observability/logger.ts'
import { requestRenderer } from '../artifact/rendererBridge'
import { requestDownloadConsent } from '../permissions/permissionsService'
import type { CancellableError } from '../permissions/promptAdapter'
import { MODEL_DOWNLOAD_DECLINED, type AgentModeTurnConfig } from '@/types/agentIpc'
import { LOG_SOURCE } from './piAgentLog.ts'

const TURN_CANCELLED = 'Agent turn cancelled.'

// Attachments reach the prompt as `@attachments/<file>` (agentModeWorkspace.ts).
const IMAGE_ATTACHMENT = /@"?attachments\/[^"\n]*?\.(png|jpe?g|webp|gif|bmp)\b/i

function needsVision(config: AgentModeTurnConfig, prompt: string): boolean {
  return config.modelConfig.supportsVision === true && IMAGE_ATTACHMENT.test(prompt)
}

/** The models the turn's readiness would load that are not on disk; never any for cloud. */
async function missingReadinessModels(
  config: AgentModeTurnConfig,
  prompt: string,
): Promise<unknown[]> {
  if (config.modelConfig.source === 'cloud' || !config.readiness) return []
  try {
    const reply = await requestRenderer<{ models?: unknown[] }>({
      kind: 'chat-check-models',
      serviceName: config.readiness.serviceName,
      llmModelName: config.readiness.llmModelName,
      needsVision: needsVision(config, prompt),
    })
    return reply.models ?? []
  } catch (error) {
    // An unanswerable check must not cost a turn whose model may well be on disk.
    appLoggerInstance.warn(`could not check the turn's models: ${error}`, LOG_SOURCE)
    return []
  }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(TURN_CANCELLED))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(TURN_CANCELLED))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** Asks, as the turn's session, for the models its readiness lacks; `true` once they downloaded. */
export async function downloadedMissingReadinessModels(
  config: AgentModeTurnConfig,
  prompt: string,
  signal: AbortSignal,
): Promise<boolean> {
  const missing = await untilAborted(missingReadinessModels(config, prompt), signal)
  if (missing.length === 0) return false
  try {
    await untilAborted(
      requestDownloadConsent(missing, { conversationKey: config.sessionId }),
      signal,
    )
  } catch (error) {
    if (!signal.aborted && (error as CancellableError).cancelled) {
      throw new Error(MODEL_DOWNLOAD_DECLINED)
    }
    throw error
  }
  return true
}
