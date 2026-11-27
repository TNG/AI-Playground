import { createAnswerRouter } from '@/assets/js/store/channels/answerRouter'
import type { ChannelAdapter } from '@/assets/js/store/channels/adapter'
import type { QueuedChannelMessage } from '@/assets/js/store/channels/channelQueue'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { createTelegramAdapter } from '@/assets/js/store/channels/telegramAdapter'
import { createSlackAdapter } from '@/assets/js/store/channels/slackAdapter'
import { createLocalWebAdapter } from '@/assets/js/store/channels/localWebAdapter'
import { answerRouterCopy } from '@/lib/answerRouterWording'
import type { ChannelInboundMessage } from '@/types/channelIpc'
import type { ChannelQueuesState } from '@/types/channelHostIpc'
import type { InFlightWorkItem } from '@/types/lifecycleIpc'
import type { ChannelStateHost } from './channelState'
import type { WindowPort } from './windowPort'

export const CHANNEL_POLL_INTERVAL_MS = 2000

type Pointers = Partial<Record<ChannelKind, string>>

export type ChannelHostDeps = {
  poll: (kind: ChannelKind) => Promise<ChannelInboundMessage[]>
  state: ChannelStateHost
  windowPort: WindowPort
  readPointers: () => Promise<Pointers>
  writePointers: (pointers: Pointers) => Promise<void>
  publishQueues: (queues: ChannelQueuesState) => void
  log: (message: string, error?: unknown) => void
  pollIntervalMs?: number
}

export type ChannelHost = {
  start: () => Promise<void>
  stop: () => void
  /** One item per Channel with queued messages, for the close question. */
  queuedWork: () => Extract<InFlightWorkItem, { kind: 'channel-queue' }>[]
  queues: () => ChannelQueuesState
  setChannelSession: (kind: ChannelKind, sessionRef: string | null) => void
  /** Routes one Channel's waiting messages now; the poll loop calls it on every tick. */
  pollOnce: (kind: ChannelKind) => Promise<void>
}

/**
 * The one place a Channel's messages are read and routed: the kernel. Every window shows the
 * result; none of them polls. Sessions are still reached through the window holding Agent Mode.
 */
export function createChannelHost(deps: ChannelHostDeps): ChannelHost {
  const adapters: Partial<Record<ChannelKind, ChannelAdapter>> = {
    telegram: createTelegramAdapter(),
    slack: createSlackAdapter(),
    'local-web': createLocalWebAdapter(),
  }
  let pointers: Pointers = {}
  const queued: Record<string, QueuedChannelMessage[]> = {}
  const sending = new Set<string>()
  const busy = new Set<ChannelKind>()
  let timer: ReturnType<typeof setInterval> | null = null
  let subscribing: Promise<void> | null = null

  const queues = (): ChannelQueuesState => ({ queued: { ...queued }, sending: [...sending] })
  const activeKinds = () => deps.state.activeKinds().filter((kind) => adapters[kind])

  const router = createAnswerRouter({
    sessions: deps.windowPort.port,
    questions: deps.windowPort.questions,
    speech: deps.windowPort.speech,
    downloadQuestionChannels: activeKinds,
    copy: () => deps.windowPort.copy() ?? answerRouterCopy(),
    pointers: {
      get: (kind) => pointers[kind] ?? null,
      set: (kind, sessionRef) => setChannelSession(kind, sessionRef),
    },
    publishQueue: (sessionRef, messages) => {
      if (messages.length > 0) queued[sessionRef] = messages
      else delete queued[sessionRef]
      deps.publishQueues(queues())
    },
    publishSending: (sessionRef, isSending) => {
      if (isSending) sending.add(sessionRef)
      else sending.delete(sessionRef)
      deps.publishQueues(queues())
    },
    log: deps.log,
  })

  function setChannelSession(kind: ChannelKind, sessionRef: string | null): void {
    const next = { ...pointers }
    if (sessionRef) next[kind] = sessionRef
    else delete next[kind]
    pointers = next
    void deps
      .writePointers(next)
      .catch((error: unknown) => deps.log('channels: saving the Channel Sessions failed:', error))
  }

  async function pollOnce(kind: ChannelKind): Promise<void> {
    const adapter = adapters[kind]
    if (!adapter || busy.has(kind)) return
    busy.add(kind)
    try {
      const messages = await deps.poll(kind)
      for (const msg of messages ?? []) {
        if (!deps.state.activeKinds().includes(kind)) break
        const meta =
          msg.channel || msg.ts || msg.chat_id
            ? { channel: msg.channel, ts: msg.ts, chatId: msg.chat_id }
            : undefined
        await router.route(
          adapter,
          { ...msg, replyTo: msg.reply_to, replyTarget: msg.reply_target },
          meta,
        )
      }
    } catch (error) {
      deps.log(`channels: routing ${kind} messages failed:`, error)
    } finally {
      busy.delete(kind)
    }
  }

  // Nothing is read off a Channel before the window answers: the backend's queue is cleared on
  // read, so a message polled with no Sessions to route it to would be lost.
  function tick(): void {
    const kinds = activeKinds()
    if (kinds.length === 0) return
    if (!deps.windowPort.ready()) {
      subscribing ??= deps.windowPort
        .subscribe()
        .catch((error: unknown) => deps.log('channels: waiting for the app window:', error))
        .finally(() => {
          subscribing = null
        })
      return
    }
    for (const kind of kinds) void pollOnce(kind)
  }

  return {
    start: async () => {
      const stored = await deps.readPointers().catch((error: unknown) => {
        deps.log('channels: reading the Channel Sessions failed:', error)
        return {}
      })
      pointers = { ...stored, ...pointers }
      timer ??= setInterval(tick, deps.pollIntervalMs ?? CHANNEL_POLL_INTERVAL_MS)
    },
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    },
    queuedWork: () => {
      const counts = new Map<ChannelKind, number>()
      for (const message of Object.values(queued).flat()) {
        counts.set(message.channel, (counts.get(message.channel) ?? 0) + 1)
      }
      return [...counts].map(([channel, count]) => ({
        kind: 'channel-queue' as const,
        channel,
        state: { status: 'queued' as const, count },
      }))
    },
    queues,
    setChannelSession,
    pollOnce,
  }
}
