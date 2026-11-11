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
// Every Channel sends this tap as it is (`COMMAND_CALLBACKS` maps it to no command).
export const PROMPT_AGENT_CALLBACK = 'promptAgent:'

export type ChannelAgentDeps = {
  listStartable: () => Promise<StartableAgent[]>
  /** A saved Agent's name, startable or not; null once it is deleted. */
  agentName: (agentId: string) => string | null
  /** The Channel Session, made when the Channel has none; null when the Channel was told why not. */
  channelSession: (adapter: ChannelAdapter, meta?: InboundMeta) => Promise<string | null>
  /** Starts the Agent in the Session, or queues the start while the Session is busy. */
  start: (
    adapter: ChannelAdapter,
    sessionRef: string,
    agent: StartableAgent,
    origin: AgentAnswerOrigin,
    meta?: InboundMeta,
  ) => Promise<unknown>
  /** Posts a Start Prompt Request for the Agent in the Session. */
  askForPrompt: (
    adapter: ChannelAdapter,
    sessionRef: string,
    agent: StartableAgent,
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
    warning?: string,
  ): Promise<void> {
    const wording = copy()
    const lines = [wording.agentsPick, wording.agentsPromptHint]
    if (warning) lines.unshift(warning)
    const pick = lines.join('\n')
    const buttons: KeyboardButton[][] = agents.map((agent) => [
      { text: `▶ ${agent.name}`, callbackData: `${START_AGENT_CALLBACK}${agent.agentId}` },
      { text: '✎', callbackData: `${PROMPT_AGENT_CALLBACK}${agent.agentId}` },
    ])
    await adapter
      .keyboard(adapter.formatMarkdown(pick), buttons, meta)
      .catch((e: unknown) => deps.log('channelAgents: listing Agents failed:', e))
  }

  /** Names the Agent when it is saved, else what was typed; a tapped id is never shown. */
  function unavailable(agentId: string, typed?: string): string {
    const name = deps.agentName(agentId) ?? typed
    return name ? fillTemplate(copy().agentNotFound, { name }) : `⚠️ ${copy().agentNotStartable}`
  }

  async function startByName(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    choice: string,
    meta?: InboundMeta,
    tapped = false,
  ): Promise<void> {
    const agents = await deps.listStartable()
    if (agents.length === 0) return tell(adapter, copy().agentsNone, meta)
    if (!choice) return list(adapter, agents, meta)
    const wanted = choice.toLowerCase().replace(/\s+/g, ' ')
    const agent =
      agents.find((entry) => entry.name.trim().toLowerCase().replace(/\s+/g, ' ') === wanted) ??
      agents.find((entry) => entry.agentId === choice)
    if (!agent) return list(adapter, agents, meta, unavailable(choice, tapped ? undefined : choice))
    const sessionRef = await deps.channelSession(adapter, meta)
    if (!sessionRef) return
    await deps.start(adapter, sessionRef, agent, inboundOrigin(adapter.kind, msg), meta)
  }

  async function askForPrompt(
    adapter: ChannelAdapter,
    agentId: string,
    meta?: InboundMeta,
  ): Promise<void> {
    const agents = await deps.listStartable()
    if (agents.length === 0) return tell(adapter, copy().agentsNone, meta)
    const agent = agents.find((entry) => entry.agentId === agentId)
    if (!agent) return list(adapter, agents, meta, unavailable(agentId))
    const sessionRef = await deps.channelSession(adapter, meta)
    if (!sessionRef) return
    await deps.askForPrompt(adapter, sessionRef, agent, meta)
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
      run: ({ adapter, msg, meta }, agentId) => startByName(adapter, msg, agentId, meta, true),
    },
    {
      prefix: PROMPT_AGENT_CALLBACK,
      run: ({ adapter, meta }, agentId) => askForPrompt(adapter, agentId, meta),
    },
  ]

  return { commands, callbacks }
}
