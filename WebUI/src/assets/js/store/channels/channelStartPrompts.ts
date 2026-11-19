import { answerGesture, GESTURE_WORDING } from '@/lib/answerButton'
import type { AnswerRouterCopy } from '@/lib/answerRouterWording'
import { fillTemplate } from '@/lib/fillTemplate'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import type { ChannelAdapter } from './adapter'
import type {
  InboundChannelMessage,
  SessionPort,
  SessionTarget,
  StartableAgent,
} from './answerRouter'
import { answerMeta, inboundOrigin, replyReachable } from './channelInbound'
import { replyRefOf, type StartPromptRequests } from './startPromptRequests'
import type { InboundMeta } from './types'

export type ChannelStartPromptDeps = {
  port: SessionPort
  requests: StartPromptRequests
  /** A new Session the Channel now points at; null when the Channel was told why not. */
  newSession: (adapter: ChannelAdapter, meta?: InboundMeta) => Promise<string | null>
  copy: () => AnswerRouterCopy
  tell: (adapter: ChannelAdapter, text: string, meta?: InboundMeta) => Promise<void>
  /** The reply's text with its images attached to the target, or null when no run starts. */
  attach: (
    adapter: ChannelAdapter,
    target: SessionTarget,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ) => Promise<string | null>
  /**
   * Starts the Agent with its Start Prompt through the router's send path, or queues it;
   * `settled` hears whether the start ran, once it ran, was refused or its queue was dropped.
   */
  start: (
    adapter: ChannelAdapter,
    sessionRef: string,
    agent: StartableAgent,
    origin: AgentAnswerOrigin,
    prompt: string,
    meta: InboundMeta | undefined,
    settled: (started: boolean) => void,
  ) => Promise<unknown>
  log: (message: string, error: unknown) => void
}

/** Start Prompt Requests: ✎ asks for one, and the first reply to it starts the Agent with it. */
export function createChannelStartPrompts(deps: ChannelStartPromptDeps) {
  const { port, requests, copy, tell } = deps

  async function ask(
    adapter: ChannelAdapter,
    sessionRef: string | null,
    agent: StartableAgent,
    meta?: InboundMeta,
  ): Promise<void> {
    const wording = copy()
    const gesture = GESTURE_WORDING[answerGesture(adapter.kind) ?? 'reply']
    const text = sessionRef
      ? fillTemplate(wording[gesture.request], {
          name: agent.name,
          title: port.label({ sessionRef }),
        })
      : fillTemplate(wording[gesture.newSessionRequest], { name: agent.name })
    try {
      const sent = await adapter.askForReply(
        adapter.formatMarkdown(text),
        {
          placeholder: fillTemplate(wording.startPromptPlaceholder, { name: agent.name }),
          answerLabel: wording.answerButton,
          answerTitle: agent.name,
        },
        meta,
      )
      const ref = sent.success ? replyRefOf(sent.ref) : null
      if (!ref || !sent.ref) throw new Error(sent.error ?? 'the channel returned no message ref')
      await requests.open(adapter.kind, ref, { agent, sessionRef, message: sent.ref })
    } catch (e) {
      deps.log('channelStartPrompts: asking for a Start Prompt failed:', e)
    }
  }

  /** True when `msg` replies to a Start Prompt Request, which then handled it. */
  async function reply(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<boolean> {
    if (!msg.replyTo) return false
    const found = await requests.lookup(adapter.kind, msg.replyTo).catch((e: unknown) => {
      deps.log('channelStartPrompts: request lookup failed:', e)
      return null
    })
    if (!found) return false
    const replyMeta = answerMeta(msg, meta)
    if (found.state === 'used') {
      await tell(adapter, copy().startPromptAlready, replyMeta)
      return true
    }
    if (found.state === 'queued') {
      await tell(adapter, copy().startPromptQueued, replyMeta)
      return true
    }
    if (found.state === 'expired') {
      await tell(adapter, copy().startPromptExpired, replyMeta)
      return true
    }
    const { request } = found
    const ref = msg.replyTo
    const sessionRef = request.sessionRef ?? (await sessionFor(adapter, ref, msg, replyMeta))
    if (!sessionRef) return true
    const target = { sessionRef }
    if (!(await replyReachable({ copy, tell }, port, adapter, target, replyMeta))) return true
    const prompt = await deps.attach(adapter, target, msg, replyMeta)
    if (prompt === null) return true
    const origin = inboundOrigin(adapter.kind, msg)
    requests.hold(adapter.kind, ref)
    await deps.start(
      adapter,
      target.sessionRef,
      request.agent,
      origin,
      prompt,
      replyMeta,
      (started) => {
        if (!started) return requests.reopen(adapter.kind, ref)
        requests.markUsed(adapter.kind, ref)
        void adapter
          .editKeyboardMessage(
            request.message,
            adapter.formatMarkdown(copy().startPromptUsed),
            meta,
          )
          .catch((e: unknown) =>
            deps.log('channelStartPrompts: marking the request used failed:', e),
          )
      },
    )
    return true
  }

  /** The new Session a reply that runs or attaches something makes, bound to its request. */
  async function sessionFor(
    adapter: ChannelAdapter,
    ref: string,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<string | null> {
    if (!msg.text?.trim() && !msg.images?.length && !msg.documents?.length) return null
    const sessionRef = await deps.newSession(adapter, meta)
    if (sessionRef) requests.bind(adapter.kind, ref, sessionRef)
    return sessionRef
  }

  return { ask, reply }
}
