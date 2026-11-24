import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { appLoggerInstance } from '../../observability/logger.ts'
import {
  beginAgentTurnSnapshot,
  emitAgentChunk,
  emitAgentTurnDone,
  emitAgentTurnState,
} from '../../kernel/kernelBus.ts'
import {
  finishTextRequest,
  submitTextRequest,
  turnQueueHolder,
  type TurnPause,
} from '../../kernel/orchestrator.ts'
import { ensureChatBackendReady, setTurnChatBackendLoad } from '../../chat/chatReadiness.ts'
import { llmServerBaseUrl } from '../../adapters/llmServerSnapshot.ts'
import { copySamplingParams } from '../piModelRuntime.ts'
import { agentTurns, type AgentTurn } from '../piAgentState.ts'
import { sessionMediaOf } from '../piSessionLifecycle.ts'
import { piAgentDir } from '../piSessionStore.ts'
import { chatModelFromAgentConfig } from '../chatModelFromAgent.ts'
import { mediaCapability } from '../capabilities/media.ts'
import type { CapabilityHost } from '../capabilities/types.ts'
import { downloadedMissingReadinessModels } from '../agentModelConsent.ts'
import { reportAgentTurnEnd, type AgentTurnEnd } from '../agentTurnOutcome.ts'
import { trackAgentTurnInSession } from '../../session/sessionAgentTurns.ts'
import {
  claimSessionTurn,
  releaseSessionTurn,
  SESSION_BUSY_MESSAGE,
} from '../../session/sessionTurns.ts'
import { HERMES_MIN_CONTEXT } from '../../adapters/backends/hermesConfig.ts'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { IpcMutationResult } from '@/types/ipcChannels'
import { hermesIntegration, hermesService, type HermesIntegration } from './hermesIntegration.ts'
import {
  createHermesStreamTranslator,
  readSseEvents,
  type HermesRunEvent,
} from './hermesStreamTranslate.ts'

const LOG_SOURCE = 'hermes-agent'
const logger = appLoggerInstance

const HERMES_TOOLS_NOTE =
  "AI Playground's own tools are available as MCP tools of the `aipg` server: use them to " +
  'generate or edit images. Their results are saved into the working directory and shown to ' +
  'the user; mention the saved paths in your reply.'

/** AIPG's media tools for this turn, as the Pi definitions an agent session would build. */
async function aipgToolsFor(config: AgentModeTurnConfig, workspaceDir: string) {
  const host: CapabilityHost = {
    sessionId: config.sessionId,
    workspaceDir,
    toolSpecs: config.toolSpecs ?? [],
    mediaAgent: config.mediaAgent,
    chatModel: chatModelFromAgentConfig(config.modelConfig),
    agentDir: piAgentDir(),
    contextWindow: config.modelConfig.contextWindow,
    supportsVision: config.modelConfig.supportsVision === true,
    keepModelsLoaded: config.keepModelsLoaded ?? false,
    sessionMedia: sessionMediaOf(config.sessionRef, workspaceDir),
  }
  if (mediaCapability.unavailableReason?.(host)) return []
  return (await mediaCapability.buildTools?.(host)) ?? []
}

async function hermesFetch(baseUrl: string, key: string, route: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

export async function startHermesTurn(
  turnId: string,
  prompt: string,
  config: AgentModeTurnConfig,
): Promise<IpcMutationResult> {
  const { sessionId } = config
  if (agentTurns.has(sessionId)) {
    return { success: false, error: 'This session already has a turn in flight.' }
  }
  const service = hermesService()
  if (!service || !(await service.serviceIsSetUp())) {
    return {
      success: false,
      error: 'Hermes Agent is not installed. Install it from the setup wizard.',
    }
  }
  if (config.modelConfig.source !== 'local' || !config.modelConfig.backend) {
    return {
      success: false,
      error: 'Hermes Agent runs on a local llama.cpp or OpenVINO model in this preview.',
    }
  }
  const modelConfig = config.modelConfig
  const sessionRef = config.sessionRef
  if (
    sessionRef &&
    !claimSessionTurn(sessionRef, {
      turnId,
      kind: 'agent',
      presetName: config.presetName,
      harnessSessionId: sessionId,
    })
  ) {
    return { success: false, error: SESSION_BUSY_MESSAGE }
  }

  const abortController = new AbortController()
  const turn: AgentTurn = { sessionId, turnId, abort: abortController, live: null }
  agentTurns.set(sessionId, turn)
  beginAgentTurnSnapshot(sessionId, turnId)
  emitAgentTurnState(
    sessionId,
    turnId,
    'queued',
    undefined,
    config.userMessageId ? { prompt, userMessageId: config.userMessageId } : undefined,
  )
  const inSession = sessionRef
    ? trackAgentTurnInSession({
        sessionRef,
        presetName: config.presetName ?? '',
        workspaceDir: config.workspaceDir,
        prompt,
        harnessSessionId: sessionId,
        turnId,
      })
    : null

  const aipgResults = new Map<string, unknown[]>()
  let aipgTools: ToolDefinition[] = []
  const translator = createHermesStreamTranslator({
    emit: (chunk) => emitAgentChunk(sessionId, turnId, chunk),
    model: config.readiness?.llmModelName ?? modelConfig.model,
    turnId,
    get aipgToolNames() {
      return aipgTools.map((tool) => tool.name)
    },
    takeAipgResult: (toolName) => aipgResults.get(toolName)?.shift(),
    onApprovalRequest: (event) => void denyApproval(event),
  })

  let runId: string | undefined
  let gateway: { baseUrl: string; key: string } | undefined
  const denyApproval = async (event: HermesRunEvent) => {
    const command = typeof event.command === 'string' ? event.command : 'a command'
    translator.notice(
      `Hermes asked for approval to run ${command}. AI Playground cannot answer approvals yet, ` +
        'so it was denied; run it from the Hermes dashboard instead.',
    )
    if (!gateway || !runId) return
    await hermesFetch(gateway.baseUrl, gateway.key, `/v1/runs/${runId}/approval`, {
      method: 'POST',
      body: JSON.stringify({ choice: 'deny', request_id: event.request_id }),
    }).catch(() => undefined)
  }

  const ready = async () => {
    if (!config.readiness) return
    setTurnChatBackendLoad(config.readiness)
    await ensureChatBackendReady(config.readiness, {
      abortSignal: abortController.signal,
      skipGpuAdmission: true,
      conversationKey: sessionId,
    })
  }
  const pause: TurnPause = {
    onUserWait: (waiting, reason) =>
      emitAgentTurnState(sessionId, turnId, waiting ? 'paused' : 'running', reason),
    onRequeued: () => emitAgentTurnState(sessionId, turnId, 'queued'),
    onHolding: () => emitAgentTurnState(sessionId, turnId, 'running'),
    readyAgain: async () => {
      emitAgentTurnState(sessionId, turnId, 'running')
      await ready()
    },
  }

  let failedWith: string | undefined
  let reply: string | undefined
  let started = false
  let integration: HermesIntegration | undefined
  try {
    integration = await hermesIntegration()
    const { proxy, mcp } = integration
    await submitTextRequest(
      {
        runId: turnId,
        conversationKey: sessionId,
        needsGpu: Boolean(config.readiness),
        joinsTurnQueue: true,
        work: 'agent',
        pause,
      },
      abortController.signal,
    )
    emitAgentTurnState(sessionId, turnId, 'running')
    await downloadedMissingReadinessModels(config, prompt, abortController.signal)
    await ready()
    started = true

    const workspaceDir = fs.realpathSync(path.resolve(config.workspaceDir))
    const contextWindow = modelConfig.contextWindow ?? HERMES_MIN_CONTEXT
    if (contextWindow < HERMES_MIN_CONTEXT) {
      translator.notice(
        `This model runs with a ${contextWindow}-token context; Hermes expects at least ` +
          `${HERMES_MIN_CONTEXT}, so long sessions may overflow.`,
      )
    }
    proxy.setTarget({
      baseUrl: () => llmServerBaseUrl(modelConfig.backend!) ?? modelConfig.baseUrl,
      model: modelConfig.model,
      samplingParams: copySamplingParams(modelConfig.samplingParams, undefined),
      contextWindow,
      onUsage: (usage) =>
        translator.stepUsage(
          {
            inputTokens: usage.prompt_tokens ?? 0,
            outputTokens: usage.completion_tokens ?? 0,
            cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
          },
          contextWindow,
        ),
    })
    aipgTools = await aipgToolsFor(config, workspaceDir)
    mcp.setTurn({
      tools: aipgTools,
      signal: abortController.signal,
      onResult: (toolName, result) =>
        aipgResults.set(toolName, [...(aipgResults.get(toolName) ?? []), result]),
    })

    if ((await service.start()) !== 'running') throw new Error('Hermes Agent failed to start.')
    service.writeRuntimeConfig({ workspaceDir, contextLength: contextWindow })
    gateway = { baseUrl: service.baseUrl, key: service.getApiKey() }

    const instructions = [config.instructions, aipgTools.length > 0 ? HERMES_TOOLS_NOTE : '']
      .filter(Boolean)
      .join('\n\n')
    const created = await hermesFetch(gateway.baseUrl, gateway.key, '/v1/runs', {
      method: 'POST',
      headers: { 'Idempotency-Key': turnId },
      body: JSON.stringify({
        input: prompt,
        session_id: sessionId,
        ...(instructions ? { instructions } : {}),
      }),
      signal: abortController.signal,
    })
    if (!created.ok) throw new Error(`Hermes refused the run: ${await created.text()}`)
    runId = ((await created.json()) as { run_id: string }).run_id

    const stop = () => {
      if (!gateway || !runId) return
      void hermesFetch(gateway.baseUrl, gateway.key, `/v1/runs/${runId}/stop`, {
        method: 'POST',
        body: '{}',
      }).catch(() => undefined)
    }
    abortController.signal.addEventListener('abort', stop, { once: true })
    const events = await hermesFetch(gateway.baseUrl, gateway.key, `/v1/runs/${runId}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: abortController.signal,
    })
    if (!events.ok || !events.body) throw new Error(`Hermes event stream failed (${events.status})`)

    let terminal: HermesRunEvent | undefined
    for await (const event of readSseEvents(events.body)) {
      translator.handle(event)
      if (translator.isTerminal(event)) {
        terminal = event
        break
      }
    }
    abortController.signal.removeEventListener('abort', stop)
    if (abortController.signal.aborted) throw new Error('Turn cancelled.')
    if (!terminal) throw new Error('Hermes closed the event stream before the run finished.')
    if (terminal.event !== 'run.completed') {
      throw new Error(
        typeof terminal.error === 'string' && terminal.error
          ? terminal.error
          : `Hermes run ended: ${terminal.event}`,
      )
    }
    reply = typeof terminal.output === 'string' ? terminal.output : undefined
    translator.finish()
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (abortController.signal.aborted && !started) {
      logger.info(`hermes turn cancelled before it ran: ${message}`, LOG_SOURCE)
      return { success: false, error: message }
    }
    logger.error(`hermes turn failed: ${message}`, LOG_SOURCE)
    translator.fail(message)
    if (!abortController.signal.aborted) failedWith = message
    return { success: false, error: message }
  } finally {
    integration?.mcp.setTurn(null)
    if (turnQueueHolder() === turnId) setTurnChatBackendLoad(null)
    finishTextRequest(turnId)
    if (agentTurns.get(sessionId) === turn) agentTurns.delete(sessionId)
    const end: AgentTurnEnd =
      failedWith !== undefined
        ? { sessionId, turnId, outcome: 'failed', error: failedWith }
        : abortController.signal.aborted
          ? { sessionId, turnId, outcome: 'cancelled' }
          : { sessionId, turnId, outcome: 'completed', reply }
    reportAgentTurnEnd(end)
    if (inSession) await inSession.settle(end)
    if (sessionRef) releaseSessionTurn(sessionRef, turnId)
    emitAgentTurnDone(sessionId, turnId)
  }
}
