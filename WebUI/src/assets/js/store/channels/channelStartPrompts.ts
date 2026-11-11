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
import { inboundOrigin } from './channelInbound'
import { replyRefOf, type StartPromptRequests } from './startPromptRequests'
import type { InboundMeta } from './types'

/** How a submitted Agent start went: started, waiting in the Session's queue, or refused. */
export type AgentStartOutcome = 'started' | 'queued' | 'refused'

export type ChannelStartPromptDeps = {
  port: SessionPort
  requests: StartPromptRequests
  copy: () => AnswerRouterCopy
  tell: (adapter: ChannelAdapter, text: string, meta?: InboundMeta) => Promise<void>
  /** The reply's text with its images attached to the target, or null when no run starts. */
  attach: (
    adapter: ChannelAdapter,
    target: SessionTarget,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ) => Promise<string | null>
  /** Starts the Agent with its Start Prompt through the router's send path, or queues it. */
  start: (
    adapter: ChannelAdapter,
    sessionRef: string,
    agent: StartableAgent,
    origin: AgentAnswerOrigin,
    prompt: string,
    meta?: InboundMeta,
  ) => Promise<AgentStartOutcome>
  log: (message: string, error: unknown) => void
}

/** Start Prompt Requests: ✎ asks for one, and the first reply to it starts the Agent with it. */
export function createChannelStartPrompts(deps: ChannelStartPromptDeps) {
  const { port, requests, copy, tell } = deps

  async function ask(
    adapter: ChannelAdapter,
    sessionRef: string,
    agent: StartableAgent,
    meta?: InboundMeta,
  ): Promise<void> {
    const wording = copy()
    const text = fillTemplate(wording.startPromptRequest, {
      name: agent.name,
      title: port.label({ sessionRef }),
    })
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
    const replyMeta = msg.replyTarget ? { ...meta, threadTs: msg.replyTarget } : meta
    if (found.state === 'used') {
      await tell(adapter, copy().startPromptAlready, replyMeta)
      return true
    }
    if (found.state === 'expired') {
      await tell(adapter, copy().startPromptExpired, replyMeta)
      return true
    }
    const { request } = found
    const target = { sessionRef: request.sessionRef }
    if (!(await port.exists(target.sessionRef))) {
      await tell(adapter, copy().noSession, replyMeta)
      return true
    }
    if (!(await port.isReachable(target.sessionRef))) {
      const title = port.label(target)
      await tell(adapter, fillTemplate(copy().unreachable, { title }), replyMeta)
      return true
    }
    const prompt = await deps.attach(adapter, target, msg, replyMeta)
    if (prompt === null) return true
    const origin = inboundOrigin(adapter.kind, msg)
    const outcome = await deps.start(
      adapter,
      target.sessionRef,
      request.agent,
      origin,
      prompt,
      replyMeta,
    )
    if (outcome === 'refused') return true
    requests.markUsed(adapter.kind, msg.replyTo)
    await adapter
      .editKeyboardMessage(request.message, adapter.formatMarkdown(copy().startPromptUsed), meta)
      .catch((e: unknown) => deps.log('channelStartPrompts: marking the request used failed:', e))
    return true
  }

  return { ask, reply }
}
