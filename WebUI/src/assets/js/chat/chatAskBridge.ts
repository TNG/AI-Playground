import type {
  ChatAnswerPayload,
  ChatAskPayload,
  Render3dThumbnailResult,
  SpeechClipPayload,
} from '@/types/chatRequests'
import { render3dThumbnail } from '@/lib/render3dThumbnail'
import { isCancellation } from '../errors/appError'
import type { AppError } from '../errors/types'
import { base64ToBlob } from '@/lib/transcribe'
import { readyTranscriptionForInput, synthesizeClip, transcribe } from '../speech/speechIO'
import { useChannels } from '../store/channels'

/**
 * Renderer half of the chat tools' question channel.
 *
 * The tool bodies run in main; what is answered here is the part that is
 * genuinely this window's — the speech engine seam (download prompt included),
 * Chromium's audio decoder, a Channel's spoken reply, and rendering a 3D screenshot.
 */

function respond(payload: ChatAnswerPayload): void {
  void window.electronAPI.chat.answer(payload)
}

async function handleRequest(
  request: ChatAskPayload,
  channels: ReturnType<typeof useChannels>,
): Promise<void> {
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
      case 'channel-voice-reply': {
        const clip = await channels.channelVoiceClip(request.channel, request.text, request.replyTo)
        respond({ requestId: request.requestId, result: clip })
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
    }
  } catch (error) {
    if (isCancellation(error)) {
      const { userMessage } = error as AppError
      respond({ requestId: request.requestId, error: userMessage, declined: true })
      return
    }
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
  const channels = useChannels()
  window.electronAPI.chat.onAsk((payload) => {
    void handleRequest(payload, channels)
  })
}
