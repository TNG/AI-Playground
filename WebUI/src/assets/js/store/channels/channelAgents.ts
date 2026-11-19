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
// `/agentsin`'s picker and the Agent list after it; every Channel sends these taps as they are.
export const PICK_SESSION_CALLBACK = 'agentsIn:'
export const START_AGENT_HERE_CALLBACK = 'runAgentIn:'
export const PROMPT_AGENT_HERE_CALLBACK = 'promptAgentIn:'

/** Where an Agent list's ▶ and ✎ start: a new Session (`/agents`) or the Channel Session. */
type AgentList = { pick: string; start: string; prompt: string }

export type ChannelAgentDeps = {
  listStartable: () => Promise<StartableAgent[]>
  /** A saved Agent's name, startable or not; null once it is deleted. */
  agentName: (agentId: string) => string | null
  /** A new Session the Channel now points at; null when the Channel was told why not. */
  newSession: (adapter: ChannelAdapter, meta?: InboundMeta) => Promise<string | null>
  /** The Channel Session, if still reachable; a lost one is cleared and the Channel told. */
  current: (adapter: ChannelAdapter, meta?: InboundMeta) => Promise<string | null>
  /** Points the Channel at a listed Session as `/load` does; null when the Channel was told why not. */
  moveTo: (adapter: ChannelAdapter, choice: string, meta?: InboundMeta) => Promise<string | null>
  /** The `/sessions` listing as buttons, each tap sending `prefix` and the Session. */
  sessionButtons: (adapter: ChannelAdapter, prefix: string) => Promise<KeyboardButton[][]>
  /** A Session's quoted Title. */
  label: (sessionRef: string) => string
  /** Starts the Agent in the Session, or queues the start while the Session is busy. */
  start: (
    adapter: ChannelAdapter,
    sessionRef: string,
    agent: StartableAgent,
    origin: AgentAnswerOrigin,
    meta?: InboundMeta,
  ) => Promise<unknown>
  /** Posts a Start Prompt Request for the Agent in the Session, or in a new one when null. */
  askForPrompt: (
    adapter: ChannelAdapter,
    sessionRef: string | null,
    agent: StartableAgent,
    meta?: InboundMeta,
  ) => Promise<void>
  copy: () => AnswerRouterCopy
  tell: (adapter: ChannelAdapter, text: string, meta?: InboundMeta) => Promise<void>
  log: (message: string, error: unknown) => void
}

/**
 * `/agents`: the Agents marked "Can be started from a Channel", each run in a new Session.
 * `/agentsin`: a Session picked first, which the Channel moves to and the Agent runs in.
 */
export function createChannelAgents(deps: ChannelAgentDeps) {
  const { copy, tell } = deps

  function inNewSession(): AgentList {
    return { pick: copy().agentsPick, start: START_AGENT_CALLBACK, prompt: PROMPT_AGENT_CALLBACK }
  }

  function inSession(sessionRef: string): AgentList {
    const pick = fillTemplate(copy().agentsInAgentsPick, { title: deps.label(sessionRef) })
    return { pick, start: START_AGENT_HERE_CALLBACK, prompt: PROMPT_AGENT_HERE_CALLBACK }
  }

  async function list(
    adapter: ChannelAdapter,
    agents: StartableAgent[],
    where: AgentList,
    meta?: InboundMeta,
    warning?: string,
  ): Promise<void> {
    const lines = [where.pick, copy().agentsPromptHint]
    if (warning) lines.unshift(warning)
    const buttons: KeyboardButton[][] = agents.map((agent) => [
      { text: `▶ ${agent.name}`, callbackData: `${where.start}${agent.agentId}` },
      { text: '✎', callbackData: `${where.prompt}${agent.agentId}` },
    ])
    await adapter
      .keyboard(adapter.formatMarkdown(lines.join('\n')), buttons, meta)
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
    if (!choice) return list(adapter, agents, inNewSession(), meta)
    const wanted = choice.toLowerCase().replace(/\s+/g, ' ')
    const agent =
      agents.find((entry) => entry.name.trim().toLowerCase().replace(/\s+/g, ' ') === wanted) ??
      agents.find((entry) => entry.agentId === choice)
    if (!agent) {
      return list(
        adapter,
        agents,
        inNewSession(),
        meta,
        unavailable(choice, tapped ? undefined : choice),
      )
    }
    const sessionRef = await deps.newSession(adapter, meta)
    if (!sessionRef) return
    await deps.start(adapter, sessionRef, agent, inboundOrigin(adapter.kind, msg), meta)
  }

  async function askForPromptById(
    adapter: ChannelAdapter,
    agentId: string,
    meta?: InboundMeta,
  ): Promise<void> {
    const agents = await deps.listStartable()
    if (agents.length === 0) return tell(adapter, copy().agentsNone, meta)
    const agent = agents.find((entry) => entry.agentId === agentId)
    if (!agent) return list(adapter, agents, inNewSession(), meta, unavailable(agentId))
    await deps.askForPrompt(adapter, null, agent, meta)
  }

  async function pickSession(adapter: ChannelAdapter, meta?: InboundMeta): Promise<void> {
    const agents = await deps.listStartable()
    const wording = copy()
    if (agents.length === 0) return tell(adapter, wording.agentsNone, meta)
    const buttons: KeyboardButton[][] = [
      // A start tap naming no Agent is a bare `/agents`: the list that starts in a new Session.
      [{ text: wording.agentsInNewSession, callbackData: START_AGENT_CALLBACK }],
      ...(await deps.sessionButtons(adapter, PICK_SESSION_CALLBACK)),
    ]
    await adapter
      .keyboard(adapter.formatMarkdown(wording.agentsInPick), buttons, meta)
      .catch((e: unknown) => deps.log('channelAgents: listing Sessions failed:', e))
  }

  async function pickedSession(
    adapter: ChannelAdapter,
    choice: string,
    meta?: InboundMeta,
  ): Promise<void> {
    const sessionRef = await deps.moveTo(adapter, choice, meta)
    if (!sessionRef) return
    const agents = await deps.listStartable()
    if (agents.length === 0) return tell(adapter, copy().agentsNone, meta)
    await list(adapter, agents, inSession(sessionRef), meta)
  }

  /** The Agent a tap in the list after `/agentsin` names; a stale one lists what is startable. */
  async function tappedHere(
    adapter: ChannelAdapter,
    agentId: string,
    meta?: InboundMeta,
  ): Promise<StartableAgent | null> {
    const agents = await deps.listStartable()
    if (agents.length === 0) {
      await tell(adapter, copy().agentsNone, meta)
      return null
    }
    const agent = agents.find((entry) => entry.agentId === agentId)
    if (agent) return agent
    const here = await deps.current(adapter, meta)
    const where = here ? inSession(here) : inNewSession()
    await list(adapter, agents, where, meta, unavailable(agentId))
    return null
  }

  async function startHere(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    agentId: string,
    meta?: InboundMeta,
  ): Promise<void> {
    const agent = await tappedHere(adapter, agentId, meta)
    if (!agent) return
    const sessionRef = (await deps.current(adapter, meta)) ?? (await deps.newSession(adapter, meta))
    if (!sessionRef) return
    await deps.start(adapter, sessionRef, agent, inboundOrigin(adapter.kind, msg), meta)
  }

  async function askForPromptHere(
    adapter: ChannelAdapter,
    agentId: string,
    meta?: InboundMeta,
  ): Promise<void> {
    const agent = await tappedHere(adapter, agentId, meta)
    if (!agent) return
    await deps.askForPrompt(adapter, await deps.current(adapter, meta), agent, meta)
  }

  const commands: ChannelCommand[] = [
    {
      name: 'agents',
      usage: '/agents [name]',
      describe: (wording) => wording.helpAgents,
      run: ({ adapter, msg, meta, args }) => startByName(adapter, msg, args, meta),
    },
    {
      name: 'agentsin',
      usage: '/agentsin',
      describe: (wording) => wording.helpAgentsIn,
      run: ({ adapter, meta }) => pickSession(adapter, meta),
    },
  ]

  const callbacks: ChannelCallback[] = [
    {
      prefix: START_AGENT_CALLBACK,
      run: ({ adapter, msg, meta }, agentId) => startByName(adapter, msg, agentId, meta, true),
    },
    {
      prefix: PROMPT_AGENT_CALLBACK,
      run: ({ adapter, meta }, agentId) => askForPromptById(adapter, agentId, meta),
    },
    {
      prefix: PICK_SESSION_CALLBACK,
      run: ({ adapter, meta }, sessionRef) => pickedSession(adapter, sessionRef, meta),
    },
    {
      prefix: START_AGENT_HERE_CALLBACK,
      run: ({ adapter, msg, meta }, agentId) => startHere(adapter, msg, agentId, meta),
    },
    {
      prefix: PROMPT_AGENT_HERE_CALLBACK,
      run: ({ adapter, meta }, agentId) => askForPromptHere(adapter, agentId, meta),
    },
  ]

  return { commands, callbacks }
}
