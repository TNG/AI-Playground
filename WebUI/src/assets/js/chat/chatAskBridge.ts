import type {
  ChatAnswerPayload,
  ChatAskPayload,
  HomeAgentApplyResult,
  Render3dThumbnailResult,
  SpeechClipPayload,
} from '@/types/chatRequests'
import { render3dThumbnail } from '@/lib/render3dThumbnail'
import { base64ToBlob } from '@/lib/transcribe'
import { readyTranscriptionForInput, synthesizeClip, transcribe } from '../speech/speechIO'
import { useHomeAgent } from '../store/homeAgent'
import { backendToService, useTextInference, type LlmBackend } from '../store/textInference'
import { useBackendServices } from '../store/backendServices'
import type { ConfigChange } from '../tools/configureHomeAgentLogic'

/**
 * Renderer half of the chat tools' question channel.
 *
 * The tool bodies run in main; what is answered here is the part that is
 * genuinely this window's — the speech engine seam (download prompt included),
 * Chromium's audio decoder, the Home Agent confirmation card, writing an
 * approved settings change into the live stores, and rendering a 3D screenshot.
 */

function respond(payload: ChatAnswerPayload): void {
  void window.electronAPI.chat.answer(payload)
}

async function applyHomeAgentChanges(
  targetBackend: LlmBackend,
  changes: ConfigChange[],
): Promise<HomeAgentApplyResult> {
  const textInference = useTextInference()
  const backendServices = useBackendServices()
  const targetService = backendToService[targetBackend]
  let backendChanged = false
  for (const change of changes) {
    switch (change.field) {
      case 'backend':
        textInference.backend = change.value as LlmBackend
        backendChanged = true
        break
      case 'model':
        textInference.selectModel(targetBackend, change.value as string)
        backendChanged = true
        break
      case 'embeddingModel':
        textInference.selectEmbeddingModel(targetBackend, change.value as string)
        break
      case 'deviceId':
        // Cloud Mode has no local service/device to select.
        if (targetService) {
          await backendServices.selectDevice(targetService, change.value as string)
          backendChanged = true
        }
        break
      case 'temperature':
        textInference.temperature = change.value as number
        break
      case 'maxTokens':
        textInference.maxTokens = change.value as number
        break
      case 'contextSize':
        textInference.contextSize = change.value as number
        backendChanged = true
        break
      case 'systemPrompt':
        textInference.systemPrompt = change.value as string
        break
      case 'aipgToolsEnabled':
        textInference.aipgToolsEnabled = change.value as boolean
        break
      case 'mcpToolsEnabled':
        textInference.mcpToolsEnabled = change.value as boolean
        break
      case 'metricsEnabled':
        textInference.metricsEnabled = change.value as boolean
        break
      case 'clearRagDocuments':
        textInference.deleteAllFiles()
        break
    }
  }
  return { backendChanged }
}

async function handleRequest(request: ChatAskPayload): Promise<void> {
  try {
    switch (request.kind) {
      case 'speech-synthesize': {
        const clip = await synthesizeClip({
          text: request.text,
          voice: request.voice,
          onPhase: (phase) => respond({ requestId: request.requestId, progress: true, phase }),
        })
        respond({ requestId: request.requestId, result: clip satisfies SpeechClipPayload })
        break
      }
      case 'speech-transcribe': {
        // Already-captured audio: a prompted model download lands before the
        // transcription, so `downloadPrompted` can be ignored (see SttReadyResult).
        await readyTranscriptionForInput()
        const result = await transcribe({
          audio: base64ToBlob(request.audioBase64, request.mediaType ?? ''),
        })
        respond({ requestId: request.requestId, result })
        break
      }
      case 'home-agent-confirm': {
        const approved = await useHomeAgent().requestSettingsConfirmation({
          conversationKey: request.conversationKey,
          toolCallId: request.toolCallId,
          summaryMarkdown: request.summaryMarkdown,
        })
        respond({ requestId: request.requestId, result: approved })
        break
      }
      case 'render-3d-thumbnail': {
        const url = URL.createObjectURL(base64ToBlob(request.modelBase64, 'model/gltf-binary'))
        try {
          const result = await render3dThumbnail(url)
          respond({
            requestId: request.requestId,
            result: result satisfies Render3dThumbnailResult,
          })
        } finally {
          URL.revokeObjectURL(url)
        }
        break
      }
      case 'home-agent-apply': {
        const result = await applyHomeAgentChanges(request.targetBackend, request.changes)
        respond({ requestId: request.requestId, result })
        break
      }
    }
  } catch (error) {
    respond({
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

let started = false

/** Starts listening for main's chat-tool questions. Call once from the entry. */
export function startChatAskBridge(): void {
  if (started) return
  started = true
  window.electronAPI.chat.onAsk((payload) => {
    void handleRequest(payload)
  })
}
