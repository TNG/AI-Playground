import type { AnswerRouterCopy } from '@/lib/answerRouterWording'
import { fillTemplate } from '@/lib/fillTemplate'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import type { ChannelAdapter } from './adapter'
import type { InboundChannelMessage, StartableAgent } from './answerRouter'
import type { ChannelCallback, ChannelCommand } from './channelCommands'
import { inboundOrigin } from './channelInbound'
import type { InboundMeta, KeyboardButton } from './types'

// Telegram and Slack turn a tap on this prefix into `/agents <value>`; LAN chat sends the callback.
export const START_AGENT_CALLBACK = 'runAgent:'

export type ChannelAgentDeps = {
  listStartable: () => Promise<StartableAgent[]>
  /** The Channel Session, made when the Channel has none; null when the Channel was told why not. */
  channelSession: (adapter: ChannelAdapter, meta?: InboundMeta) => Promise<string | null>
  /** Starts the Agent in the Session, or queues the start while the Session is busy. */
  start: (
    adapter: ChannelAdapter,
    sessionRef: string,
    agent: StartableAgent,
    origin: AgentAnswerOrigin,
    meta?: InboundMeta,
  ) => Promise<void>
  copy: () => AnswerRouterCopy
  tell: (adapter: ChannelAdapter, text: string, meta?: InboundMeta) => Promise<void>
  log: (message: string, error: unknown) => void
}

/** `/agents`: the Agents marked "Can be started from a Channel", run in the Channel Session. */
export function createChannelAgents(deps: ChannelAgentDeps) {
  const { copy, tell } = deps

  async function list(
    adapter: ChannelAdapter,
    agents: StartableAgent[],
    meta?: InboundMeta,
    notFound?: string,
  ): Promise<void> {
    const wording = copy()
    const pick = notFound
      ? `${fillTemplate(wording.agentNotFound, { name: notFound })}\n${wording.agentsPick}`
      : wording.agentsPick
    const buttons: KeyboardButton[][] = agents.map((agent) => [
      { text: agent.name, callbackData: `${START_AGENT_CALLBACK}${agent.agentId}` },
    ])
    await adapter
      .keyboard(adapter.formatMarkdown(pick), buttons, meta)
      .catch((e: unknown) => deps.log('channelAgents: listing Agents failed:', e))
  }

  async function startByName(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    choice: string,
    meta?: InboundMeta,
  ): Promise<void> {
    const agents = await deps.listStartable()
    if (agents.length === 0) return tell(adapter, copy().agentsNone, meta)
    if (!choice) return list(adapter, agents, meta)
    const wanted = choice.toLowerCase().replace(/\s+/g, ' ')
    const agent =
      agents.find((entry) => entry.name.trim().toLowerCase().replace(/\s+/g, ' ') === wanted) ??
      agents.find((entry) => entry.agentId === choice)
    if (!agent) return list(adapter, agents, meta, choice)
    const sessionRef = await deps.channelSession(adapter, meta)
    if (!sessionRef) return
    await deps.start(adapter, sessionRef, agent, inboundOrigin(adapter.kind, msg), meta)
  }

  const commands: ChannelCommand[] = [
    {
      name: 'agents',
      usage: '/agents [name]',
      describe: (wording) => wording.helpAgents,
      run: ({ adapter, msg, meta, args }) => startByName(adapter, msg, args, meta),
    },
  ]

  const callbacks: ChannelCallback[] = [
    {
      prefix: START_AGENT_CALLBACK,
      run: ({ adapter, msg, meta }, agentId) => startByName(adapter, msg, agentId, meta),
    },
  ]

  return { commands, callbacks }
}
