import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type { InFlightWorkItem } from '@/types/lifecycleIpc'
import type { TrialRunRecord } from '@/types/agentTaskIpc'
import type { TrialRunView } from '@/lib/trialRunTimeline'
import { useAgentMode, type TurnOutcome } from './agentMode'
import { AGENT_PRESET } from './agentModeSessions'
import { useAgentTasks, type LibraryAgent, type ModelDownloadRefusal } from './agentTasks'
import { useErrors } from './errors'
import { useI18N } from './i18n'
import { createAppError, extractMessage } from '@/assets/js/errors/appError'
import { afterStepTurn, sendRunStep } from '@/lib/agentStepRun'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { liveAgentSessions } from '@/lib/liveAgentSessions'
import {
  describeSettingsProblems,
  type SessionSettingsProblem,
} from '@/lib/sessionSettingsProblems'

/** An Agent's Trial Run: the one in flight, or the last one, kept until the next starts. */
export type TrialRun = TrialRunRecord

export type StartTrialRunResult =
  | { ok: true }
  | { ok: false; reason: 'no-agent' | 'running' | 'stopped' | 'no-steps' | 'empty-step' }
  | { ok: false; reason: 'settings-problems'; problems: SessionSettingsProblem[]; message: string }
  | { ok: false; reason: 'not-started'; message: string }
  | ({ ok: false; message: string } & ModelDownloadRefusal)

type TrialRunFailureCode =
  | 'agent-library/trial-save-failed'
  | 'agent-library/trial-read-failed'
  | 'agent-library/trial-discard-failed'

/** An Agent's Draft run from the Agent Library, owned by no Session. */
export const useAgentTrialRuns = defineStore('agentTrialRuns', () => {
  const agentMode = useAgentMode()
  const agentTasks = useAgentTasks()
  const errors = useErrors()
  const i18n = useI18N()

  /** Each Agent's Trial Run, by Agent id; the last one stays until the next one starts. */
  const trialRuns = ref<Record<string, TrialRun>>({})
  /** The Agent as its Trial Run started, and the abort that keeps an ended run from sending. */
  const trialContexts: Record<
    string,
    { plan: Pick<LibraryAgent, 'steps' | 'settingsTemplate'>; abort: AbortController }
  > = {}
  /** Agents whose Trial Run is still being checked, possibly waiting on a download; Stop aborts it. */
  const startingTrials = reactive(new Map<string, AbortController>())
  /** Turns that ended before `init` restored the runs, which may have been theirs. */
  let earlySettles: [string, TurnOutcome][] | null = []

  function trialRunInFlight(agentId: string): boolean {
    return startingTrials.has(agentId) || trialRuns.value[agentId]?.state === 'running'
  }

  /** The Agents whose Trial Run is in flight, for the header indicator. */
  const trialRunsInFlight = computed((): string[] => [
    ...new Set([
      ...startingTrials.keys(),
      ...Object.values(trialRuns.value)
        .filter((run) => run.state === 'running')
        .map((run) => run.agentId),
    ]),
  ])

  agentTasks.contributeInFlightWork(() =>
    trialRunsInFlight.value.map((agentId): InFlightWorkItem => {
      const run = trialRuns.value[agentId]
      if (run?.state !== 'running') {
        const agent = agentTasks.libraryAgents.find((entry) => entry.id === agentId)
        const name = agent?.name.trim() || undefined
        return {
          kind: 'trial-run',
          agentId,
          ...(name ? { name } : {}),
          state: { status: 'starting' },
        }
      }
      return {
        kind: 'trial-run',
        agentId,
        sessionId: run.harnessSessionId,
        name: run.name,
        state: { status: 'step', index: run.stepIndex, count: run.stepCount },
      }
    }),
  )

  agentTasks.onAgentDeleted((agentId) => discardTrialRun(agentId))

  agentMode.onTurnSettled((sessionId, outcome) => {
    if (earlySettles) earlySettles.push([sessionId, outcome])
    else onTurnSettled(sessionId, outcome)
  })

  function onTurnSettled(sessionId: string, outcome: TurnOutcome): void {
    const run = Object.values(trialRuns.value).find((entry) => entry.harnessSessionId === sessionId)
    if (run?.state !== 'running') return
    const next = afterStepTurn(outcome, run.stepIndex, run.stepCount)
    if (next.kind === 'step') void sendTrialStep(run.agentId, next.stepIndex)
    else if (next.kind === 'failed') settleTrialRun(run.agentId, 'failed', next.message)
    else settleTrialRun(run.agentId, next.kind)
  }

  /** Main keeps it beside the run's folder, so a reloaded window can pick the run up. */
  function putTrialRun(run: TrialRun): void {
    trialRuns.value = { ...trialRuns.value, [run.agentId]: run }
    void window.electronAPI.agentMode
      .saveTrialRun(cloneForIpc(run))
      .catch((error: unknown) => ({ success: false as const, error: String(error) }))
      .then((result) => {
        if (!result.success) reportTrialRunFailure('agent-library/trial-save-failed', result.error)
      })
  }

  function reportTrialRunFailure(code: TrialRunFailureCode, message: string): void {
    errors.report(
      createAppError({
        category: 'backend',
        code,
        surface: 'silent',
        userMessage: message,
        technicalMessage: message,
      }),
    )
  }

  /** After a reload; turns that settle meanwhile are held until the runs are back. */
  async function init(): Promise<void> {
    earlySettles ??= []
    try {
      await restoreTrialRuns()
    } finally {
      const settled = earlySettles
      earlySettles = null
      for (const [sessionId, outcome] of settled) onTurnSettled(sessionId, outcome)
    }
  }

  /** A run whose turn main or this window still holds goes on; one cut off between Steps failed. */
  async function restoreTrialRuns(): Promise<void> {
    let records: TrialRunRecord[]
    try {
      const result = await window.electronAPI.agentMode.readTrialRuns()
      if (!result.success) throw new Error(result.error)
      records = result.trialRuns
    } catch (error) {
      reportTrialRunFailure('agent-library/trial-read-failed', extractMessage(error))
      return
    }
    const running = records.filter((run) => run.state === 'running')
    const live = running.length > 0 ? await liveAgentSessions() : new Set<string>()
    for (const run of records) {
      if (trialRuns.value[run.agentId]) continue
      const record = agentMode.sessions[run.harnessSessionId]
      trialRuns.value = { ...trialRuns.value, [run.agentId]: run }
      if (run.state !== 'running') continue
      if (!record?.steps || !record.settings || !turnStillHeard(run.harnessSessionId, live)) {
        settleTrialRun(
          run.agentId,
          'failed',
          i18n.state.AGENT_TASKS_OUTCOME_APP_CLOSED ?? 'The app closed during the run.',
        )
        continue
      }
      trialContexts[run.agentId] = {
        plan: { steps: record.steps, settingsTemplate: record.settings },
        abort: new AbortController(),
      }
      agentMode.quietSessionErrors(run.harnessSessionId)
    }
  }

  function turnStillHeard(sessionId: string, live: Set<string>): boolean {
    return (
      live.has(sessionId) ||
      !!agentMode.sessionTurns[sessionId] ||
      !!earlySettles?.some(([settled]) => settled === sessionId)
    )
  }

  /** What the Agent Library renders of the Agent's Trial Run, through `trialRunItems`. */
  function trialRunView(agentId: string): TrialRunView | undefined {
    const run = trialRuns.value[agentId]
    if (!run) return undefined
    const record = agentMode.sessions[run.harnessSessionId]
    const live = agentMode.streamingMessagesOf(run.harnessSessionId)
    return {
      harnessSessionId: run.harnessSessionId,
      presetName: AGENT_PRESET,
      taskRun: record?.taskRun ?? {
        taskName: run.name,
        startedAt: run.startedAt,
        trigger: 'manual',
      },
      saved: record?.messages ?? [],
      ...(live ? { live } : {}),
      ...(run.state === 'running'
        ? { progress: { step: run.stepIndex, count: run.stepCount } }
        : {}),
    }
  }

  /** Run the Agent's Draft (or saved Agent), `input` leading Step 1. */
  async function startTrialRun(
    agentId: string,
    options: { input?: string } = {},
  ): Promise<StartTrialRunResult> {
    if (trialRunInFlight(agentId)) return { ok: false, reason: 'running' }
    const starting = new AbortController()
    startingTrials.set(agentId, starting)
    try {
      return await beginTrialRun(agentId, options, starting.signal)
    } finally {
      if (startingTrials.get(agentId) === starting) startingTrials.delete(agentId)
    }
  }

  const libraryAgent = (agentId: string) =>
    agentTasks.libraryAgents.find((agent) => agent.id === agentId)

  async function beginTrialRun(
    agentId: string,
    { input }: { input?: string },
    signal: AbortSignal,
  ): Promise<StartTrialRunResult> {
    const listed = libraryAgent(agentId)
    if (!listed) return { ok: false, reason: 'no-agent' }
    await agentMode.loadMcpServersFor(listed.settingsTemplate.capabilities ?? [])
    if (signal.aborted) return { ok: false, reason: 'stopped' }
    const checked = libraryAgent(agentId)
    if (!checked) return { ok: false, reason: 'no-agent' }
    if (checked.steps.length === 0) return { ok: false, reason: 'no-steps' }
    if (checked.steps.some((step) => !step.prompt.trim()))
      return { ok: false, reason: 'empty-step' }
    const problems = agentMode.problemsOf(checked.settingsTemplate)
    if (problems.length > 0) {
      const message = describeSettingsProblems(problems, i18n.state)
      return { ok: false, reason: 'settings-problems', problems, message }
    }
    const refusal = await agentTasks.chatModelRefusal(checked.settingsTemplate, checked.steps)
    if (signal.aborted) return { ok: false, reason: 'stopped' }
    if (refusal) return { ok: false, ...refusal }
    // Taken after the waits, so the edits made meanwhile are the ones that run.
    const agent = libraryAgent(agentId)
    if (!agent) return { ok: false, reason: 'no-agent' }
    const plan = cloneForIpc(agent)
    await dropTrialRun(agentId)
    let harness: { harnessSessionId: string; workspaceDir: string }
    try {
      const result = await window.electronAPI.agentMode.trialRunHarness(agentId)
      if (!result.success) throw new Error(result.error)
      harness = result.harness
    } catch (error) {
      return { ok: false, reason: 'not-started', message: extractMessage(error) }
    }
    if (signal.aborted) return { ok: false, reason: 'stopped' }
    const name = plan.name.trim() || (i18n.state.AGENT_LIBRARY_UNNAMED ?? 'Untitled agent')
    const startedAt = Date.now()
    const leading = input?.trim()
    agentMode.createSession({
      id: harness.harnessSessionId,
      workspaceDir: harness.workspaceDir,
      settings: cloneForIpc(plan.settingsTemplate),
      presetName: AGENT_PRESET,
      title: name,
      taskRun: { taskName: name, startedAt, trigger: 'manual' },
      steps: plan.steps,
    })
    trialContexts[agentId] = {
      plan,
      abort: new AbortController(),
    }
    putTrialRun({
      agentId,
      harnessSessionId: harness.harnessSessionId,
      name,
      stepIndex: 1,
      stepCount: plan.steps.length,
      startedAt,
      state: 'running',
      ...(leading ? { input: leading } : {}),
    })
    void sendTrialStep(agentId, 1)
    return { ok: true }
  }

  async function sendTrialStep(agentId: string, stepIndex: number): Promise<void> {
    const run = trialRuns.value[agentId]
    const context = trialContexts[agentId]
    if (run?.state !== 'running' || !context) return
    putTrialRun({ ...run, stepIndex })
    await sendRunStep(
      agentMode,
      {
        sessionId: run.harnessSessionId,
        stepIndex,
        taskName: run.name,
        steps: context.plan.steps,
        settingsTemplate: context.plan.settingsTemplate,
        signal: context.abort.signal,
        ...(run.input ? { prompt: run.input } : {}),
      },
      (message) => settleTrialRun(agentId, 'failed', message),
    )
  }

  function settleTrialRun(
    agentId: string,
    state: Exclude<TrialRun['state'], 'running'>,
    message?: string,
  ): void {
    const run = trialRuns.value[agentId]
    if (run?.state !== 'running') return
    trialContexts[agentId]?.abort.abort()
    delete trialContexts[agentId]
    putTrialRun({ ...run, state, ...(message !== undefined ? { message } : {}) })
    if (state !== 'completed') {
      agentMode.endAgentRun(run.harnessSessionId, {
        kind: state,
        ...(message !== undefined ? { message } : {}),
      })
    }
  }

  /** Stop the Agent's Trial Run, or keep the one still starting from starting. */
  async function stopTrialRun(agentId: string): Promise<void> {
    startingTrials.get(agentId)?.abort()
    startingTrials.delete(agentId)
    await stopRunningTrial(agentId)
  }

  async function stopRunningTrial(agentId: string): Promise<void> {
    const run = trialRuns.value[agentId]
    if (run?.state !== 'running') return
    // Settled first, so the stopped turn's own settle finds no run and no Step can follow.
    settleTrialRun(agentId, 'stopped')
    await agentMode.stopSession(run.harnessSessionId)
  }

  /** Forget the Agent's Trial Run and its Harness Session here; main removes its folder. */
  async function dropTrialRun(agentId: string): Promise<void> {
    const run = trialRuns.value[agentId]
    if (!run) return
    await stopRunningTrial(agentId)
    const { [agentId]: _dropped, ...rest } = trialRuns.value
    trialRuns.value = rest
    await agentMode.deleteSession(run.harnessSessionId)
  }

  /** Throw the Agent's Trial Run away with its folder, as deleting the Agent does. */
  async function discardTrialRun(agentId: string): Promise<void> {
    await stopTrialRun(agentId)
    await dropTrialRun(agentId)
    const result = await window.electronAPI.agentMode
      .discardTrialRun(agentId)
      .catch((error: unknown) => ({ success: false as const, error: String(error) }))
    if (!result.success) reportTrialRunFailure('agent-library/trial-discard-failed', result.error)
  }

  return {
    trialRuns,
    trialRunInFlight,
    trialRunsInFlight,
    trialRunView,
    init,
    startTrialRun,
    stopTrialRun,
  }
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useAgentTrialRuns, import.meta.hot))
