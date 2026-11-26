import { computed, watch, type ComputedRef } from 'vue'
import { sessionPort } from '@/assets/js/store/channels/sessionPort'
import type { ChannelKind, InboundMeta, RemoteAudio } from '@/assets/js/store/channels/types'
import type { InboundChannelMessage } from '@/assets/js/store/channels/answerRouter'
import { extractMessage } from '@/assets/js/errors/appError'
import type { AnswerRouterCopy } from '@/lib/answerRouterWording'
import type { SessionPortMirror } from '@/lib/channelSessionPort'
import type {
  ChannelPortAsk,
  ChannelPortCall,
  ChannelPortResults,
  ChannelPortState,
} from '@/types/channelHostIpc'

/** The window's half of the Channels in the kernel: what only Agent Mode's stores can do. */
export type ChannelWindowServices = {
  typedQuestionKinds: () => ChannelKind[]
  answerQuestion: (kind: ChannelKind, msg: InboundChannelMessage, meta?: InboundMeta) => boolean
  prepareVoice: (
    kind: ChannelKind,
    meta?: InboundMeta,
  ) => Promise<{ ready: boolean } | { downloading: Promise<boolean> }>
  transcribeVoice: (
    kind: ChannelKind,
    audio: RemoteAudio[],
    meta?: InboundMeta,
  ) => Promise<string | null>
}

let stop: (() => void) | null = null

/**
 * Answers the kernel's Channels dispatcher. Mirroring starts only when main asks, so a window
 * whose kernel runs no Channels (a thin client, or nothing set up) sends nothing.
 */
export function startChannelWindowPort(options: {
  mirror: ComputedRef<SessionPortMirror>
  copy: () => AnswerRouterCopy
  services: ChannelWindowServices
}): void {
  const api = window.electronAPI?.channelHost
  if (stop || !api) return
  const { services } = options
  const state = computed<ChannelPortState>(() => ({
    ...options.mirror.value,
    typedQuestionKinds: services.typedQuestionKinds(),
    copy: options.copy(),
  }))
  const downloads = new Map<string, Promise<boolean>>()
  let stopMirror: (() => void) | null = null

  function subscribe(): void {
    if (stopMirror) return
    let last = ''
    stopMirror = watch(
      () => JSON.stringify(state.value),
      (json) => {
        if (json === last) return
        last = json
        api!.portState(JSON.parse(json) as ChannelPortState)
      },
    )
  }

  async function run(call: ChannelPortCall): Promise<ChannelPortResults[ChannelPortCall['op']]> {
    const port = sessionPort()
    if (
      !port &&
      call.op !== 'subscribe' &&
      !call.op.startsWith('speech') &&
      call.op !== 'questionInbound'
    ) {
      throw new Error('The Sessions are not ready yet')
    }
    switch (call.op) {
      case 'subscribe':
        subscribe()
        return null
      case 'exists':
        return port!.exists(call.sessionRef)
      case 'isReachable':
        return port!.isReachable(call.sessionRef)
      case 'listReachable':
        return port!.listReachable()
      case 'create':
        return port!.create()
      case 'transcript':
        return port!.transcript(call.sessionRef)
      case 'attach':
        return port!.attach(call.target, call.file)
      case 'send':
        return port!.send(call.target, call.message, call.origin)
      case 'listStartableAgents':
        return port!.listStartableAgents()
      case 'startAgent':
        return port!.startAgent(call.sessionRef, call.agentId, call.origin, call.prompt)
      case 'bringIntoView':
        await port!.bringIntoView(call.sessionRef, call.view)
        return null
      case 'unpickAgent':
        await port!.unpickAgent(call.sessionRef)
        return null
      case 'stop':
        return port!.stop(call.sessionRef)
      case 'speechPrepare': {
        const prepared = await services.prepareVoice(call.kind, call.meta)
        if ('ready' in prepared) return prepared
        const token = crypto.randomUUID()
        downloads.set(token, prepared.downloading)
        return { downloadToken: token }
      }
      case 'speechDownload': {
        const download = downloads.get(call.token)
        downloads.delete(call.token)
        return download ? download : false
      }
      case 'speechTranscribe':
        return services.transcribeVoice(call.kind, call.audio, call.meta)
      case 'questionInbound':
        return services.answerQuestion(call.kind, call.msg, call.meta)
    }
  }

  async function handle({ requestId, call }: ChannelPortAsk): Promise<void> {
    try {
      const result = await run(call)
      api!.portAnswer({ requestId, result, state: state.value })
    } catch (error) {
      api!.portAnswer({ requestId, error: extractMessage(error), state: state.value })
    }
  }

  const unlisten = api.onPortAsk((ask) => void handle(ask))
  stop = () => {
    unlisten?.()
    stopMirror?.()
    stopMirror = null
  }
}
