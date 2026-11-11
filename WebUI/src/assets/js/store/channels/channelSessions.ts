import type { AnswerRouterCopy } from '@/lib/answerRouterWording'
import { fillTemplate } from '@/lib/fillTemplate'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import type { ChannelAdapter, RawPart } from './adapter'
import type {
  ChannelSessionPointers,
  InboundChannelMessage,
  SessionPort,
  SessionSendResult,
} from './answerRouter'
import type { ChannelCallback, ChannelCommand } from './channelCommands'
import { inboundOrigin } from './channelInbound'
import type { InboundMeta, KeyboardButton } from './types'

// Telegram and Slack turn a tap on this prefix into `/load <value>`; LAN chat sends the callback.
export const LOAD_SESSION_CALLBACK = 'loadConv:'

const LISTED_SESSIONS = 10

export type ChannelSessionDeps = {
  port: SessionPort
  pointers: ChannelSessionPointers
  copy: () => AnswerRouterCopy
  tell: (adapter: ChannelAdapter, text: string, meta?: InboundMeta) => Promise<void>
  confirm: (
    adapter: ChannelAdapter,
    title: string,
    result: SessionSendResult,
    meta?: InboundMeta,
  ) => Promise<void>
  send: (
    target: { sessionRef: string },
    text: string,
    origin: AgentAnswerOrigin,
  ) => Promise<SessionSendResult>
  /** Stores the message's files in the Session: the prompt to send, or null when none runs. */
  attach: (
    adapter: ChannelAdapter,
    target: { sessionRef: string },
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ) => Promise<string | null>
  log: (message: string, error: unknown) => void
}

/** Each Channel's Channel Session: plain messages go there, and the commands that pick it. */
export function createChannelSessions(deps: ChannelSessionDeps) {
  const { port, pointers, copy, tell } = deps

  /** A new Reachable Session the Channel now points at, or null when the Channel was told why not. */
  async function startSession(adapter: ChannelAdapter, meta?: InboundMeta): Promise<string | null> {
    try {
      const sessionRef = await port.create()
      pointers.set(adapter.kind, sessionRef)
      return sessionRef
    } catch (e) {
      deps.log('channelSessions: creating a Session failed:', e)
      const reason = e instanceof Error ? e.message : String(e)
      await tell(adapter, fillTemplate(copy().sessionNotCreated, { reason }), meta)
      return null
    }
  }

  /** The Channel Session, if it is still reachable; a lost one is cleared and told once. */
  async function current(adapter: ChannelAdapter, meta?: InboundMeta): Promise<string | null> {
    const sessionRef = pointers.get(adapter.kind)
    if (!sessionRef) return null
    if (await port.isReachable(sessionRef)) return sessionRef
    pointers.set(adapter.kind, null)
    await tell(adapter, copy().sessionLost, meta)
    return null
  }

  async function plainMessage(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<void> {
    const hasFiles = !!(msg.images?.length || msg.documents?.length)
    if (!msg.text?.trim() && !hasFiles) return
    const sessionRef = (await current(adapter, meta)) ?? (await startSession(adapter, meta))
    if (!sessionRef) return
    const prompt = await deps.attach(adapter, { sessionRef }, msg, meta)
    if (prompt === null) return
    const result = await deps.send({ sessionRef }, prompt, inboundOrigin(adapter.kind, msg))
    await deps.confirm(adapter, port.label({ sessionRef }), result, meta)
  }

  /** Repaints a Channel with no history of its own (LAN chat) with the Session's transcript. */
  async function repaint(adapter: ChannelAdapter, sessionRef: string): Promise<void> {
    if (!adapter.replayHistory) return
    try {
      const transcript = await port.transcript(sessionRef)
      await adapter.replayHistory(
        transcript.map(({ role, parts }) => ({
          role,
          text: role === 'assistant' ? adapter.formatFinal(parts) : plainText(parts),
        })),
      )
    } catch (e) {
      deps.log('channelSessions: repainting the channel failed:', e)
    }
  }

  async function listSessions(adapter: ChannelAdapter, meta?: InboundMeta): Promise<void> {
    const listed = (await port.listReachable()).slice(0, LISTED_SESSIONS)
    const wording = copy()
    if (listed.length === 0) return tell(adapter, wording.sessionsNone, meta)
    const pointed = pointers.get(adapter.kind)
    const buttons: KeyboardButton[][] = listed.map(({ sessionRef, title }, index) => [
      {
        text: `${sessionRef === pointed ? '✅ ' : ''}${index + 1}. ${title || wording.untitled}`,
        callbackData: `${LOAD_SESSION_CALLBACK}${sessionRef}`,
      },
    ])
    await adapter
      .keyboard(adapter.formatMarkdown(wording.sessionsPick), buttons, meta)
      .catch((e: unknown) => deps.log('channelSessions: listing Sessions failed:', e))
  }

  async function load(adapter: ChannelAdapter, choice: string, meta?: InboundMeta): Promise<void> {
    const reachable = await port.listReachable()
    const index = /^\d+$/.test(choice) ? Number(choice) - 1 : -1
    const picked = reachable[index] ?? reachable.find((entry) => entry.sessionRef === choice)
    if (!picked) {
      return tell(adapter, fillTemplate(copy().sessionNotFound, { n: choice }), meta)
    }
    pointers.set(adapter.kind, picked.sessionRef)
    await repaint(adapter, picked.sessionRef)
    const title = port.label({ sessionRef: picked.sessionRef })
    await tell(adapter, fillTemplate(copy().sessionLoaded, { title }), meta)
  }

  async function startNew(adapter: ChannelAdapter, meta?: InboundMeta): Promise<void> {
    const sessionRef = await startSession(adapter, meta)
    if (!sessionRef) return
    await repaint(adapter, sessionRef)
    await tell(adapter, copy().sessionStarted, meta)
  }

  const commands: ChannelCommand[] = [
    {
      name: 'sessions',
      usage: '/sessions',
      describe: (wording) => wording.helpSessions,
      run: ({ adapter, meta }) => listSessions(adapter, meta),
    },
    {
      name: 'load',
      usage: '/load <n>',
      describe: (wording) => wording.helpLoad,
      run: ({ adapter, meta, args }) =>
        args ? load(adapter, args, meta) : listSessions(adapter, meta),
    },
    {
      name: 'new',
      usage: '/new',
      describe: (wording) => wording.helpNew,
      run: ({ adapter, meta }) => startNew(adapter, meta),
    },
  ]

  const callbacks: ChannelCallback[] = [
    {
      prefix: LOAD_SESSION_CALLBACK,
      run: ({ adapter, meta }, sessionRef) => load(adapter, sessionRef, meta),
    },
  ]

  return { plainMessage, commands, callbacks }
}

function plainText(parts: RawPart[]): string {
  return parts
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('')
    .trim()
}
