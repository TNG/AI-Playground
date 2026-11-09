import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import { MODEL_DOWNLOAD_DECLINED, promptHasImageAttachment } from '@/types/agentIpc'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { PauseReason } from '@/types/kernelEvents'
import type { InFlightWorkItem } from '@/types/lifecycleIpc'
import type { SessionSummary, SessionTurn } from '@/types/sessionIpc'
import type { RunProgress } from '@/lib/turnTypes'
import type { TrialRunView } from '@/lib/trialRunTimeline'
import type {
  AgentDraft,
  AgentSessionSchedule,
  AgentTask,
  AgentTaskActiveRun,
  AgentTaskOutcome,
  AgentTaskSchedule,
  AgentTaskStep,
  TrialRunRecord,
} from '@/types/agentTaskIpc'
import { MCP_CAPABILITY_PREFIX } from '@/types/agentCapabilities'
import {
  useAgentMode,
  type SendToSessionResult,
  type SessionTurnInfo,
  type TurnOutcome,
} from './agentMode'
import { AGENT_PRESET } from './agentModeSessions'
import { useDemoMode } from './demoMode'
import { useErrors } from './errors'
import { useI18N } from './i18n'
import { useMcp } from './mcp'
import { usePresets } from './presets'
import { useSessions } from './sessions'
import { useTextInference } from './textInference'
import { createAppError, extractMessage, isCancellation } from '@/assets/js/errors/appError'
import { requestDownload } from '@/assets/js/permissions/permissions'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { firstStepTurn, stepPrompts, stepTurn } from '@/lib/taskSteps'
import { nextSlotAfter, scheduleProblem, type ScheduleProblem } from '@/lib/taskSchedule'
import { fillTemplate } from '@/lib/fillTemplate'
import { taskRunWorkItem } from '@/lib/inFlightWorkItem'
import {
  describeSettingsProblems,
  type SessionSettingsProblem,
} from '@/lib/sessionSettingsProblems'

export type TaskDraft = { name: string; steps: AgentTaskStep[] }

/** What the Agent Library edits on an Agent; it goes to the Agent's Draft. */
export type AgentDraftEdit = Partial<
  Pick<AgentDraft, 'name' | 'description' | 'image' | 'steps' | 'settingsTemplate'>
>

/** An Agent as the Agent Library lists it: its Draft over the saved Agent. */
export type LibraryAgent = {
  id: string
  name: string
  description?: string
  image?: string
  steps: AgentTaskStep[]
  settingsTemplate: AgentSessionSettings
  /** False while the Agent exists only as a Draft. */
  saved: boolean
  hasDraft: boolean
}

const DRAFT_FIELDS = ['name', 'description', 'image', 'steps', 'settingsTemplate'] as const

/** The editable fields of a Draft or Agent, without the absent ones. */
function editableFields(source: AgentDraftEdit): AgentDraftEdit {
  return Object.fromEntries(
    DRAFT_FIELDS.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  )
}

/** Why a draft cannot be saved yet; `settings` only for an Agent Library Draft. */
export type SaveTaskBlocker = 'name' | 'no-steps' | 'empty-step' | 'settings'

export const SAVE_TASK_BLOCKER_KEYS = {
  name: 'AGENT_TASK_BLOCKED_NAME',
  'no-steps': 'AGENT_TASK_BLOCKED_NO_STEPS',
  'empty-step': 'AGENT_TASK_BLOCKED_EMPTY_STEP',
  settings: 'AGENT_LIBRARY_BLOCKED_SETTINGS',
} as const satisfies Record<SaveTaskBlocker, string>

/** An Agent Run in flight, in memory only; `skippedSlots` passed while it was paused. */
export type TaskRun = {
  taskId: string
  stepIndex: number
  stepCount: number
  sessionId: string
  sessionRef: string
  skippedSlots?: number
  waiting?: boolean
}

/** A Task Run as shown: `paused` while its Harness Session waits on the user. */
export type TaskRunState = TaskRun & { paused?: { reason?: PauseReason } }

export type TaskState = { running: TaskRunState } | { idle: AgentTaskOutcome | undefined }

/** The chat model a Settings Template runs on was not downloaded. */
export type ModelDownloadRefusal =
  { reason: 'download-declined' } | { reason: 'download-failed'; error: string }

export type SaveTaskResult =
  | { ok: true; task: AgentTask }
  | { ok: false; reason: SaveTaskBlocker | 'persist-failed' | 'no-task' }

export type RunTaskResult =
  | { ok: true }
  | { ok: false; reason: 'no-task' | 'running' | 'no-session' }
  | { ok: false; reason: 'settings-problems'; problems: SessionSettingsProblem[]; message: string }
  | ({ ok: false; message: string } & ModelDownloadRefusal)

export type ChatWithAgentResult = RunTaskResult | SendToSessionResult

/** The Session's Harness Session key for the chat with one saved Agent. */
const agentChatKey = (agentId: string) => `agent:${agentId}`

export type SetScheduleResult =
  | { ok: true; task: AgentTask }
  | { ok: false; reason: 'no-task' | 'persist-failed' | 'no-session' }
  | { ok: false; reason: 'invalid'; problem: ScheduleProblem }

/** An Agent's Schedule in one Session; empty when it has none there. */
export type TaskScheduleState = { schedule?: AgentTaskSchedule; nextRunAt?: number }

export type AddScheduleResult = SetScheduleResult | { ok: false; reason: 'already-scheduled' }

/** One of an Agent's Schedules, as the Agent Library lists it. */
export type AgentScheduleEntry = {
  sessionRef: string
  schedule: AgentTaskSchedule
  nextRunAt?: number
}

type RunEnd = Pick<AgentTaskOutcome, 'kind' | 'stepIndex' | 'message'>

/** An Agent's Trial Run: the one in flight, or the last one, kept until the next starts. */
export type TrialRun = TrialRunRecord

export type StartTrialRunResult =
  | { ok: true }
  | { ok: false; reason: 'no-agent' | 'running' | 'no-steps' | 'empty-step' }
  | { ok: false; reason: 'settings-problems'; problems: SessionSettingsProblem[]; message: string }
  | { ok: false; reason: 'not-started'; message: string }
  | ({ ok: false; message: string } & ModelDownloadRefusal)

type OutcomeFields = Omit<AgentTaskOutcome, 'at'>

function scheduleIn(task: AgentTask, sessionRef: string): AgentSessionSchedule | undefined {
  return task.schedules?.find((schedule) => schedule.sessionRef === sessionRef)
}

/** The Task with its Schedule in `sessionRef` replaced in place, added, or removed when absent. */
function withSchedule(
  task: AgentTask,
  sessionRef: string,
  schedule: AgentSessionSchedule | undefined,
): AgentTask {
  const current = task.schedules ?? []
  const replaced = current.some((entry) => entry.sessionRef === sessionRef)
    ? current.map((entry) => (entry.sessionRef === sessionRef ? schedule : entry))
    : [...current, schedule]
  return withEntries(
    task,
    'schedules',
    replaced.filter((entry): entry is AgentSessionSchedule => entry !== undefined),
  )
}

/** The Task with `key` set to `entries`, or without it when there are none. */
function withEntries<K extends 'schedules' | 'activeRuns'>(
  task: AgentTask,
  key: K,
  entries: NonNullable<AgentTask[K]>,
): AgentTask {
  const next: AgentTask = { ...task }
  delete next[key]
  return entries.length > 0 ? { ...next, [key]: entries } : next
}

/** What starting or minting a run of the Task in the Session is keyed by. */
const runSlot = (taskId: string, sessionRef: string) => `${taskId}\n${sessionRef}`

const SCHEDULE_TICK_MS = 30_000
/**
 * A due slot older than this was missed (app closed, machine asleep) and is not run. The margin
 * covers Chromium aligning a hidden window's timers to one wake-up a minute.
 */
const FRESH_SLOT_MS = SCHEDULE_TICK_MS + 60_000

export const useAgentTasks = defineStore('agentTasks', () => {
  const agentMode = useAgentMode()
  const demoMode = useDemoMode()
  const errors = useErrors()
  const i18n = useI18N()
  const mcp = useMcp()
  const presets = usePresets()
  const sessionsStore = useSessions()
  const textInference = useTextInference()

  /** The Agents library, listed in every Session. */
  const tasks = ref<AgentTask[]>([])

  /** Each Agent's unsaved edits, by Agent id; an Agent never saved exists only here. */
  const drafts = ref<Record<string, AgentDraft>>({})

  /** Runs in flight by Harness Session; at most one per Agent and Session. */
  const runs = ref<Record<string, TaskRun>>({})
  /** The Task as its run started, and the abort that keeps an ended run from sending a Step. */
  const runContexts: Record<
    string,
    { plan: AgentTask; abort: AbortController; scheduled: boolean; prompt?: string }
  > = {}

  /** Runs (by `runSlot`) whose ▶ Run is still being checked, possibly waiting on a download. */
  const starting = reactive(new Set<string>())
  /** Runs (by `runSlot`) getting their Harness Session from main. */
  const minting = reactive(new Set<string>())

  // Main reads Task Run markers from the tasks file; this covers what it cannot see yet.
  const inFlightWork = computed((): InFlightWorkItem[] => [
    ...Object.values(runs.value).flatMap((run) => {
      const task = tasks.value.find((entry) => entry.id === run.taskId)
      return task ? [taskRunWorkItem(task, run)] : []
    }),
    ...[...new Set([...starting, ...minting])].flatMap((slot) => {
      const [taskId, sessionRef] = slot.split('\n')
      const task = tasks.value.find((entry) => entry.id === taskId)
      return task && !runIn(taskId, sessionRef) ? [taskRunWorkItem(task)] : []
    }),
    ...trialRunWork.value,
  ])

  let scheduleTicker: ReturnType<typeof setInterval> | undefined
  /** Main holds Schedules while it asks whether to quit. */
  let schedulesHeld = false
  /** Tasks whose delete is in flight; a tick saving one would write it back. */
  const deleting = new Set<string>()
  /** The runs in flight, including between two Steps, by the key the timeline groups them by. */
  const runsInFlight = computed<Record<string, RunProgress>>(() =>
    Object.fromEntries(
      Object.entries(runs.value).map(([id, run]) => [
        id,
        { step: run.stepIndex, count: run.stepCount },
      ]),
    ),
  )

  function runIn(taskId: string, sessionRef: string): TaskRun | undefined {
    return Object.values(runs.value).find(
      (run) => run.taskId === taskId && run.sessionRef === sessionRef,
    )
  }

  /** A run of the Agent is in flight in the Session, or getting its Harness Session there. */
  function runsIn(taskId: string, sessionRef: string): boolean {
    return !!runIn(taskId, sessionRef) || minting.has(runSlot(taskId, sessionRef))
  }

  async function init(): Promise<void> {
    try {
      const result = await window.electronAPI.agentMode.readTasks()
      if (!result.success) throw new Error(result.error)
      tasks.value = result.tasks
    } catch (error) {
      reportReadFailure(error)
      return
    }
    await readDrafts()
    await settleInterruptedRuns()
    await restoreTrialRuns()
    skipMissedSlots()
    clearInterval(scheduleTicker)
    scheduleTicker = setInterval(tickSchedules, SCHEDULE_TICK_MS)
  }

  /** No catch-up at launch: slots that fell while the app was closed are skipped. */
  function skipMissedSlots(): void {
    const now = Date.now()
    for (const due of dueSchedules(now)) advanceNextRun(due.taskId, due.schedule, now)
  }

  function setSchedulesHeld(held: boolean): void {
    schedulesHeld = held
  }

  function tickSchedules(): void {
    if (demoMode.enabled || schedulesHeld) return
    const now = Date.now()
    for (const { taskId, schedule } of dueSchedules(now)) {
      if (deleting.has(taskId)) continue
      const fresh = schedule.nextRunAt !== undefined && now - schedule.nextRunAt < FRESH_SLOT_MS
      advanceNextRun(taskId, schedule, now)
      if (!fresh) continue
      // One run per Agent and Session: a slot that finds one in flight is skipped, not queued.
      const run = runIn(taskId, schedule.sessionRef)
      if (!run) void runScheduled(taskId, schedule.sessionRef)
      else if (pausedTurnOf(run)) countSkippedSlot(run.sessionId)
    }
  }

  function pausedTurnOf(run: TaskRun): SessionTurnInfo | undefined {
    const turn = agentMode.sessionTurns[run.sessionId]
    return turn?.state === 'paused' ? turn : undefined
  }

  function countSkippedSlot(sessionId: string): void {
    const run = runs.value[sessionId]
    const skippedSlots = (run.skippedSlots ?? 0) + 1
    runs.value = { ...runs.value, [sessionId]: { ...run, skippedSlots } }
  }

  function dueSchedules(now: number): { taskId: string; schedule: AgentSessionSchedule }[] {
    return tasks.value.flatMap((task) =>
      (task.schedules ?? [])
        .filter(
          (schedule) =>
            schedule.enabled && !(schedule.nextRunAt !== undefined && schedule.nextRunAt > now),
        )
        .map((schedule) => ({ taskId: task.id, schedule })),
    )
  }

  function advanceNextRun(taskId: string, schedule: AgentSessionSchedule, now: number): void {
    const task = tasks.value.find((entry) => entry.id === taskId)
    if (!task) return
    const next = { ...schedule, nextRunAt: nextSlotAfter(schedule, now) }
    void persistTask(replaceTask(withSchedule(task, schedule.sessionRef, next)))
  }

  /** Sessions whose agent turn main still holds, so a reload must not call the run closed. */
  async function liveAgentSessions(): Promise<Set<string>> {
    try {
      const snapshot = await window.electronAPI.getKernelSnapshot()
      return new Set(
        snapshot.state.agentTurns
          .filter(
            (turn) =>
              turn.state === 'queued' || turn.state === 'running' || turn.state === 'paused',
          )
          .map((turn) => turn.sessionId),
      )
    } catch {
      return new Set()
    }
  }

  /**
   * A run marker with no turn left in main was cut off (process death). A turn
   * main still holds is the same run: keep the step loop attached to it.
   */
  async function settleInterruptedRuns(): Promise<void> {
    const live = await liveAgentSessions()
    for (const task of [...tasks.value]) {
      for (const activeRun of task.activeRuns ?? []) {
        const { sessionId, stepIndex, stepCount } = activeRun
        if (live.has(sessionId)) {
          reattachRun(task, activeRun)
          continue
        }
        agentMode.endAgentRun(sessionId, {
          kind: 'failed',
          message: i18n.state.AGENT_TASKS_OUTCOME_APP_CLOSED ?? 'The app closed during the run.',
        })
        await recordOutcome(task.id, {
          kind: 'failed',
          sessionId,
          stepIndex,
          stepCount,
          reason: 'app-closed',
        })
      }
    }
  }

  function reattachRun(task: AgentTask, activeRun: AgentTaskActiveRun): void {
    runs.value = {
      ...runs.value,
      [activeRun.sessionId]: {
        taskId: task.id,
        sessionId: activeRun.sessionId,
        sessionRef: activeRun.sessionRef,
        stepIndex: activeRun.stepIndex,
        stepCount: activeRun.stepCount,
      },
    }
    runContexts[activeRun.sessionId] = {
      plan: cloneForIpc(task),
      abort: new AbortController(),
      scheduled: activeRun.scheduled === true,
    }
    agentMode.quietSessionErrors(activeRun.sessionId)
  }

  function reportReadFailure(error: unknown): void {
    errors.report(
      createAppError({
        category: 'backend',
        code: 'agent-tasks/read-failed',
        severity: 'warning',
        surface: 'toast',
        userMessage: i18n.state.AGENT_TASK_READ_FAILED ?? 'Could not read the saved agents.',
        technicalMessage: extractMessage(error),
        cause: error,
      }),
    )
  }

  function saveBlocker(draft: TaskDraft): SaveTaskBlocker | null {
    if (!draft.name.trim()) return 'name'
    if (draft.steps.length === 0) return 'no-steps'
    if (draft.steps.some((step) => !step.prompt.trim())) return 'empty-step'
    return null
  }

  /**
   * The Task's local chat model, with its vision projector when a Step hands it an image, is
   * downloaded with the user's consent when missing; a refusal says why it is not on disk.
   */
  async function chatModelRefusal(
    template: AgentSessionSettings,
    steps: readonly AgentTaskStep[],
  ): Promise<(ModelDownloadRefusal & { message: string }) | null> {
    const { inference } = textInference.inferenceForSettings(AGENT_PRESET, template)
    if (inference.backend === 'cloud') return null
    const model = inference.activeModel ?? ''
    const needsVision =
      inference.modelSupportsVision && steps.some((step) => promptHasImageAttachment(step.prompt))
    try {
      const missing = await textInference.getMissingLlmModels(
        inference.backend as 'llamaCPP' | 'openVINO',
        model,
        { needsVision },
      )
      if (missing.length > 0) await requestDownload(missing)
      return null
    } catch (error) {
      if (isCancellation(error)) {
        const declined =
          i18n.state.AGENT_TASK_RUN_DOWNLOAD_DECLINED ??
          'Not started: the agent’s chat model {model} has to be downloaded first.'
        return { reason: 'download-declined', message: fillTemplate(declined, { model }) }
      }
      const technical = extractMessage(error)
      const failed =
        i18n.state.AGENT_TASK_RUN_DOWNLOAD_FAILED ??
        'Not started: the download of {model} failed: {error}'
      const message = fillTemplate(failed, { model, error: technical })
      errors.report(
        createAppError({
          category: 'backend',
          code: 'agent-tasks/model-download-failed',
          severity: 'warning',
          surface: 'toast',
          userMessage: message,
          technicalMessage: technical,
          cause: error,
        }),
      )
      return { reason: 'download-failed', error: technical, message }
    }
  }

  /** Upsert one Task into the tasks file; a failure is toasted. */
  async function persistTask(task: AgentTask): Promise<boolean> {
    const result = await window.electronAPI.agentMode
      .saveTask(cloneForIpc(task))
      .catch((error: unknown) => ({ success: false as const, error: String(error) }))
    if (result.success) return true
    errors.report(
      createAppError({
        category: 'backend',
        code: 'agent-tasks/save-failed',
        userMessage: i18n.state.AGENT_TASK_SAVE_FAILED ?? 'Could not save the agent.',
        technicalMessage: result.error,
        surface: 'toast',
      }),
    )
    return false
  }

  /** Sessions holding an enabled Schedule. */
  const scheduledSessionIds = computed(
    () =>
      new Set(
        tasks.value.flatMap((task) =>
          (task.schedules ?? []).filter((entry) => entry.enabled).map((entry) => entry.sessionRef),
        ),
      ),
  )

  /** How many Sessions hold a Schedule of the Agent, paused ones included. */
  function scheduledSessionCount(id: string): number {
    return tasks.value.find((task) => task.id === id)?.schedules?.length ?? 0
  }

  /** How many Sessions the Agent has a run in flight in; deleting it is refused until none. */
  function runningSessionCount(id: string): number {
    return Object.values(runs.value).filter((run) => run.taskId === id).length
  }

  /** Removes its Schedules in every Session, keeping its runs; refused while it runs. */
  async function deleteTask(id: string): Promise<boolean> {
    if (runningSessionCount(id) > 0) return false
    deleting.add(id)
    const result = await window.electronAPI.agentMode
      .deleteTask(id)
      .catch((error: unknown) => ({ success: false as const, error: String(error) }))
      .finally(() => deleting.delete(id))
    if (!result.success) {
      errors.report(
        createAppError({
          category: 'backend',
          code: 'agent-tasks/delete-failed',
          userMessage: i18n.state.AGENT_TASK_DELETE_FAILED ?? 'Could not delete the agent.',
          technicalMessage: result.error,
          surface: 'toast',
        }),
      )
      return false
    }
    await discardTrialRun(id)
    tasks.value = tasks.value.filter((task) => task.id !== id)
    const { [id]: _draft, ...otherDrafts } = drafts.value
    drafts.value = otherDrafts
    await forgetPicksOf(id)
    return true
  }

  /** The saved Agent picked in the Session's prompt bar, whatever preset is active there. */
  function pickedAgentIn(sessionRef: string | null | undefined): AgentTask | undefined {
    const id = sessionRef ? sessionsStore.sessions[sessionRef]?.pickedAgentId : undefined
    return id ? tasks.value.find((task) => task.id === id) : undefined
  }

  /** The open Session's picked Agent, in effect while Agent Maker is the active preset. */
  const pickedAgent = computed((): AgentTask | undefined =>
    presets.activePresetWithVariant?.name === AGENT_PRESET
      ? pickedAgentIn(sessionsStore.openSessionId)
      : undefined,
  )

  /** What blocks an agent prompt: the picked Agent's Settings Template, else the Session's settings. */
  const agentSettingsProblems = computed((): SessionSettingsProblem[] =>
    pickedAgent.value ? taskProblems(pickedAgent.value.id) : agentMode.settingsProblems,
  )

  // Listed so the template's problems include missing MCP servers before ▶ is pressed.
  watch(pickedAgent, (agent) => {
    if (agent) void agentMode.loadMcpServersFor(agent.settingsTemplate.capabilities ?? [])
  })

  /** Pick a saved Agent in the open Session's prompt bar, or `null` for Agent Maker itself. */
  async function pickAgent(agentId: string | null): Promise<boolean> {
    if (agentId !== null && !tasks.value.some((task) => task.id === agentId)) return false
    const sessionRef = await sessionsStore.ensureOpenSession()
    if (!sessionRef) return false
    if ((sessionsStore.sessions[sessionRef]?.pickedAgentId ?? null) === agentId) return true
    return sessionsStore.pickAgent(sessionRef, agentId)
  }

  /** ▶ with an Agent picked: an Agent Run of it in the open Session, the prompt leading Step 1. */
  async function runPickedAgent(prompt: string): Promise<RunTaskResult> {
    const agent = pickedAgent.value
    if (!agent) return { ok: false, reason: 'no-task' }
    return runTask(agent.id, prompt)
  }

  /**
   * → with an Agent picked: a turn of its chat in the open Session, one Harness Session per
   * (Agent, Session) that keeps its context and runs on the Agent's saved Settings Template.
   */
  async function chatWithPickedAgent(prompt: string): Promise<ChatWithAgentResult> {
    const picked = pickedAgent.value
    if (!picked) return { ok: false, reason: 'no-task' }
    await agentMode.loadMcpServersFor(picked.settingsTemplate.capabilities ?? [])
    const problems = taskProblems(picked.id)
    if (problems.length > 0) {
      const message = describeSettingsProblems(problems, i18n.state)
      return { ok: false, reason: 'settings-problems', problems, message }
    }
    const refusal = await chatModelRefusal(picked.settingsTemplate, [{ id: 'prompt', prompt }])
    if (refusal) return { ok: false, ...refusal }
    const sessionRef = await sessionsStore.ensureOpenSession()
    if (!sessionRef) return { ok: false, reason: 'no-session' }
    // The download may have taken long enough for a delete to overtake it.
    const agent = tasks.value.find((entry) => entry.id === picked.id)
    if (!agent) return { ok: false, reason: 'no-task' }
    const result = await window.electronAPI.sessions.harnessSession(
      sessionRef,
      agentChatKey(agent.id),
    )
    if (!result.success) return { ok: false, reason: 'no-session' }
    const { harnessSessionId, workspaceDir } = result.harness
    const settings = cloneForIpc(agent.settingsTemplate)
    const agentChat = { agentId: agent.id, agentName: agent.name }
    if (!agentMode.sessions[harnessSessionId]) {
      agentMode.createSession({
        id: harnessSessionId,
        sessionRef,
        workspaceDir,
        settings,
        presetName: AGENT_PRESET,
        title: agent.name,
        agentChat,
      })
    }
    return agentMode.sendToSession(harnessSessionId, prompt, { settings, agentChat })
  }

  /** A deleted Agent's Sessions fall back to Agent Maker. */
  async function forgetPicksOf(agentId: string): Promise<void> {
    const picked = Object.values(sessionsStore.sessions).filter(
      (session) => session.pickedAgentId === agentId,
    )
    await Promise.all(picked.map((session) => sessionsStore.pickAgent(session.id, null)))
  }

  // Main drops a deleted Session's Schedules from the file; its runs stop, every Agent stays.
  watch(
    () => sessionsStore.sessions,
    (known, before) => {
      const gone = Object.keys(before ?? {}).filter((id) => !known[id])
      if (gone.length > 0) void forgetSessions(new Set(gone))
    },
  )

  async function forgetSessions(gone: ReadonlySet<string>): Promise<void> {
    tasks.value = tasks.value.map((task) => {
      const { sessionRef: madeIn, ...rest } = task
      const base = madeIn !== undefined && gone.has(madeIn) ? rest : task
      return withEntries(
        base,
        'schedules',
        (task.schedules ?? []).filter((entry) => !gone.has(entry.sessionRef)),
      )
    })
    const ended = Object.values(runs.value).filter((run) => gone.has(run.sessionRef))
    await Promise.all(ended.map((run) => stopRun(run.sessionId)))
  }

  async function readDrafts(): Promise<void> {
    try {
      const result = await window.electronAPI.agentMode.readDrafts()
      if (!result.success) throw new Error(result.error)
      drafts.value = Object.fromEntries(result.drafts.map((draft) => [draft.agentId, draft]))
    } catch (error) {
      errors.report(
        createAppError({
          category: 'backend',
          code: 'agent-library/drafts-read-failed',
          surface: 'toast',
          userMessage:
            i18n.state.AGENT_LIBRARY_DRAFTS_READ_FAILED ??
            'Could not read the unsaved agent edits.',
          technicalMessage: extractMessage(error),
          cause: error,
        }),
      )
    }
  }

  /** Saved Agents in library order, then Agents that exist only as a Draft. */
  const libraryAgents = computed((): LibraryAgent[] => {
    const listed = tasks.value.map((task): LibraryAgent => {
      const draft = drafts.value[task.id]
      return {
        id: task.id,
        ...editableFields(task),
        ...(draft ? editableFields(draft) : {}),
        ...(draft ? { description: draft.description, image: draft.image } : {}),
        saved: true,
        hasDraft: !!draft,
      } as LibraryAgent
    })
    const draftOnly = Object.values(drafts.value)
      .filter((draft) => !tasks.value.some((task) => task.id === draft.agentId))
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .map(
        (draft): LibraryAgent =>
          ({
            id: draft.agentId,
            ...editableFields(draft),
            saved: false,
            hasDraft: true,
          }) as LibraryAgent,
      )
    return [...listed, ...draftOnly]
  })

  async function writeDraft(draft: AgentDraft): Promise<boolean> {
    drafts.value = { ...drafts.value, [draft.agentId]: draft }
    const result = await window.electronAPI.agentMode
      .saveDraft(cloneForIpc(draft))
      .catch((error: unknown) => ({ success: false as const, error: String(error) }))
    if (result.success) return true
    errors.report(
      createAppError({
        category: 'backend',
        code: 'agent-library/draft-save-failed',
        surface: 'toast',
        userMessage:
          i18n.state.AGENT_LIBRARY_DRAFT_SAVE_FAILED ?? 'Could not keep the agent edits.',
        technicalMessage: result.error,
      }),
    )
    return false
  }

  /** A new Agent, which exists only as this Draft until it is first saved. */
  async function createAgentDraft(): Promise<AgentDraft> {
    const draft: AgentDraft = {
      agentId: crypto.randomUUID(),
      name: '',
      settingsTemplate: {},
      steps: [],
      updatedAt: Date.now(),
    }
    await writeDraft(draft)
    return draft
  }

  /** Apply an edit to the Agent's Draft, starting one from the saved Agent when it has none. */
  async function editDraft(id: string, edit: AgentDraftEdit): Promise<boolean> {
    const base = drafts.value[id] ?? tasks.value.find((task) => task.id === id)
    if (!base) return false
    const merged = { ...editableFields(base), ...edit }
    const draft: AgentDraft = {
      agentId: id,
      name: merged.name ?? '',
      settingsTemplate: cloneForIpc(merged.settingsTemplate ?? {}),
      steps: (merged.steps ?? []).map((step) => ({ id: step.id, prompt: step.prompt })),
      updatedAt: Date.now(),
      ...(merged.description !== undefined ? { description: merged.description } : {}),
      ...(merged.image !== undefined ? { image: merged.image } : {}),
    }
    return writeDraft(draft)
  }

  /** Change some of the Draft's Settings Template, keeping the rest. */
  async function editDraftSettings(id: string, change: AgentSessionSettings): Promise<boolean> {
    const base = drafts.value[id] ?? tasks.value.find((task) => task.id === id)
    if (!base) return false
    return editDraft(id, { settingsTemplate: { ...base.settingsTemplate, ...change } })
  }

  /** Why the Agent's Draft cannot be saved yet; null when it can, or when there is none. */
  function draftBlocker(id: string): SaveTaskBlocker | null {
    const draft = drafts.value[id]
    if (!draft) return null
    return saveBlocker(draft) ?? (draftSettingsProblems(id).length > 0 ? 'settings' : null)
  }

  /** What in the Draft's Settings Template cannot be used right now. */
  function draftSettingsProblems(id: string): SessionSettingsProblem[] {
    const draft = drafts.value[id]
    return draft ? agentMode.problemsOf(draft.settingsTemplate) : []
  }

  /**
   * Replace the Agent's editable fields with its Draft and remove the Draft. Runs in flight keep
   * the copy they started with; the next run uses the saved Agent.
   */
  async function saveAgentDraft(id: string): Promise<SaveTaskResult> {
    const draft = drafts.value[id]
    if (!draft) return { ok: false, reason: 'no-task' }
    const blocker = draftBlocker(id)
    if (blocker) return { ok: false, reason: blocker }
    const saved = tasks.value.find((task) => task.id === id)
    const now = Date.now()
    const {
      description: _description,
      image: _image,
      ...kept
    } = saved ?? {
      id,
      createdAt: now,
      updatedAt: now,
    }
    const task: AgentTask = {
      ...kept,
      name: draft.name.trim(),
      ...(draft.description?.trim() ? { description: draft.description.trim() } : {}),
      ...(draft.image ? { image: draft.image } : {}),
      settingsTemplate: cloneForIpc(draft.settingsTemplate),
      steps: draft.steps.map((step) => ({ id: step.id, prompt: step.prompt })),
      updatedAt: saved ? Math.max(now, saved.updatedAt + 1) : now,
    } as AgentTask
    if (saved) replaceTask(task)
    // Applied before the write, so a run marking or settling the Agent meanwhile writes it too.
    if (!(await persistTask(task))) {
      if (saved) restoreEditableFields(saved)
      return { ok: false, reason: 'persist-failed' }
    }
    if (!saved) tasks.value = [...tasks.value, task]
    await removeDraft(id)
    return { ok: true, task }
  }

  /** Drop the Agent's Draft; the saved Agent shows again, and an unsaved one is gone. */
  async function discardAgentDraft(id: string): Promise<boolean> {
    return removeDraft(id)
  }

  async function removeDraft(id: string): Promise<boolean> {
    if (!drafts.value[id]) return true
    const result = await window.electronAPI.agentMode
      .deleteDraft(id)
      .catch((error: unknown) => ({ success: false as const, error: String(error) }))
    if (!result.success) {
      errors.report(
        createAppError({
          category: 'backend',
          code: 'agent-library/draft-delete-failed',
          surface: 'toast',
          userMessage:
            i18n.state.AGENT_LIBRARY_DRAFT_DELETE_FAILED ?? 'Could not remove the agent edits.',
          technicalMessage: result.error,
        }),
      )
      return false
    }
    const { [id]: _removed, ...rest } = drafts.value
    drafts.value = rest
    return true
  }

  // ── Trial Runs: an Agent's Draft run from the Agent Library, owned by no Session ──

  /** Each Agent's Trial Run, by Agent id; the last one stays until the next one starts. */
  const trialRuns = ref<Record<string, TrialRun>>({})
  /** The Agent as its Trial Run started, and the abort that keeps an ended run from sending. */
  const trialContexts: Record<
    string,
    { plan: Pick<LibraryAgent, 'steps' | 'settingsTemplate'>; abort: AbortController }
  > = {}
  /** Agents whose Trial Run is still being checked, possibly waiting on a download. */
  const startingTrials = reactive(new Set<string>())

  function trialRunInFlight(agentId: string): boolean {
    return startingTrials.has(agentId) || trialRuns.value[agentId]?.state === 'running'
  }

  /** The Agents whose Trial Run is in flight, for the header indicator. */
  const trialRunsInFlight = computed((): string[] => [
    ...new Set([
      ...startingTrials,
      ...Object.values(trialRuns.value)
        .filter((run) => run.state === 'running')
        .map((run) => run.agentId),
    ]),
  ])

  const trialRunWork = computed((): InFlightWorkItem[] =>
    trialRunsInFlight.value.map((agentId) => {
      const run = trialRuns.value[agentId]
      if (run?.state !== 'running') {
        const agent = libraryAgents.value.find((entry) => entry.id === agentId)
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

  watch(inFlightWork, (work) => window.electronAPI?.reportInFlightWork?.(work), {
    immediate: true,
  })

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

  function reportTrialRunFailure(code: string, message: string): void {
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

  /** After a reload: a run whose turn main still holds goes on; one cut off between Steps failed. */
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
      if (!record?.steps || !record.settings || !live.has(run.harnessSessionId)) {
        settleTrialRun(
          run.agentId,
          'failed',
          i18n.state.AGENT_TASKS_OUTCOME_APP_CLOSED ?? 'The app closed during the run.',
        )
        continue
      }
      trialContexts[run.agentId] = {
        plan: { steps: record.steps.slice(0, run.stepCount), settingsTemplate: record.settings },
        abort: new AbortController(),
      }
      agentMode.quietSessionErrors(run.harnessSessionId)
    }
  }

  function trialRunOfHarness(harnessSessionId: string): TrialRun | undefined {
    return Object.values(trialRuns.value).find((run) => run.harnessSessionId === harnessSessionId)
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

  /** Run the Agent's Draft (or the saved Agent), stopping after `lastStep` when given. */
  async function startTrialRun(
    agentId: string,
    options: { lastStep?: number } = {},
  ): Promise<StartTrialRunResult> {
    if (trialRunInFlight(agentId)) return { ok: false, reason: 'running' }
    startingTrials.add(agentId)
    try {
      return await beginTrialRun(agentId, options.lastStep)
    } finally {
      startingTrials.delete(agentId)
    }
  }

  async function beginTrialRun(
    agentId: string,
    lastStep: number | undefined,
  ): Promise<StartTrialRunResult> {
    const listed = libraryAgents.value.find((agent) => agent.id === agentId)
    if (!listed) return { ok: false, reason: 'no-agent' }
    await agentMode.loadMcpServersFor(listed.settingsTemplate.capabilities ?? [])
    const checked = libraryAgents.value.find((agent) => agent.id === agentId)
    if (!checked) return { ok: false, reason: 'no-agent' }
    if (checked.steps.length === 0) return { ok: false, reason: 'no-steps' }
    if (checked.steps.some((step) => !step.prompt.trim()))
      return { ok: false, reason: 'empty-step' }
    const problems = agentMode.problemsOf(checked.settingsTemplate)
    if (problems.length > 0) {
      const message = describeSettingsProblems(problems, i18n.state)
      return { ok: false, reason: 'settings-problems', problems, message }
    }
    const refusal = await chatModelRefusal(checked.settingsTemplate, checked.steps)
    if (refusal) return { ok: false, ...refusal }
    // Taken after the waits, so the edits made meanwhile are the ones that run.
    const agent = libraryAgents.value.find((entry) => entry.id === agentId)
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
    const name = plan.name.trim() || (i18n.state.AGENT_LIBRARY_UNNAMED ?? 'Untitled agent')
    const stepCount = Math.min(Math.max(lastStep ?? plan.steps.length, 1), plan.steps.length)
    const startedAt = Date.now()
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
      plan: { ...plan, steps: plan.steps.slice(0, stepCount) },
      abort: new AbortController(),
    }
    putTrialRun({
      agentId,
      harnessSessionId: harness.harnessSessionId,
      name,
      stepIndex: 1,
      stepCount,
      startedAt,
      state: 'running',
    })
    void sendTrialStep(agentId, 1)
    return { ok: true }
  }

  async function sendTrialStep(agentId: string, stepIndex: number): Promise<void> {
    const run = trialRuns.value[agentId]
    const context = trialContexts[agentId]
    if (run?.state !== 'running' || !context) return
    putTrialRun({ ...run, stepIndex })
    const steps = stepPrompts(context.plan.steps)
    const turn = stepIndex === 1 ? firstStepTurn('', steps) : stepTurn(stepIndex, steps)
    const result = await agentMode.sendToSession(run.harnessSessionId, turn, {
      settings: cloneForIpc(context.plan.settingsTemplate),
      signal: context.abort.signal,
      quietErrors: true,
      taskRun: { taskName: run.name, stepIndex },
    })
    if (!result.ok && result.reason !== 'aborted') {
      settleTrialRun(agentId, 'failed', result.message)
      agentMode.releaseHeldAnswer(run.harnessSessionId)
    }
  }

  function advanceTrialRun(run: TrialRun, outcome: TurnOutcome): void {
    if (outcome.kind === 'completed') {
      if (run.stepIndex < run.stepCount) void sendTrialStep(run.agentId, run.stepIndex + 1)
      else settleTrialRun(run.agentId, 'completed')
    } else if (outcome.kind === 'error') {
      settleTrialRun(run.agentId, 'failed', outcome.message)
    } else {
      settleTrialRun(run.agentId, 'stopped')
    }
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

  async function stopTrialRun(agentId: string): Promise<void> {
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
    await stopTrialRun(agentId)
    const { [agentId]: _dropped, ...rest } = trialRuns.value
    trialRuns.value = rest
    await agentMode.deleteSession(run.harnessSessionId)
  }

  /** Throw the Agent's Trial Run away with its folder, as deleting the Agent does. */
  async function discardTrialRun(agentId: string): Promise<void> {
    await dropTrialRun(agentId)
    const result = await window.electronAPI.agentMode
      .discardTrialRun(agentId)
      .catch((error: unknown) => ({ success: false as const, error: String(error) }))
    if (!result.success) reportTrialRunFailure('agent-library/trial-discard-failed', result.error)
  }

  /** Set, pause or resume the Agent's Schedule in one Session. */
  async function setSchedule(
    id: string,
    schedule: AgentTaskSchedule,
    sessionRef: string,
  ): Promise<SetScheduleResult> {
    const problem = scheduleProblem(schedule)
    if (problem) return { ok: false, reason: 'invalid', problem }
    if (!tasks.value.some((entry) => entry.id === id)) return { ok: false, reason: 'no-task' }
    if (!sessionRef) return { ok: false, reason: 'no-session' }
    const { every, unit, startAt, enabled } = schedule
    return writeSchedule(id, sessionRef, {
      sessionRef,
      every,
      unit,
      startAt,
      enabled,
      ...(enabled ? { nextRunAt: nextSlotAfter(schedule, Date.now()) } : {}),
    })
  }

  /** Remove the Agent's Schedule in a Session. */
  async function removeSchedule(id: string, sessionRef: string): Promise<boolean> {
    return (await writeSchedule(id, sessionRef, undefined)).ok
  }

  async function writeSchedule(
    id: string,
    sessionRef: string,
    schedule: AgentSessionSchedule | undefined,
  ): Promise<SetScheduleResult> {
    const saved = tasks.value.find((entry) => entry.id === id)
    if (!saved) return { ok: false, reason: 'no-task' }
    // Applied before the write, so a run marking or settling the Task meanwhile writes it too.
    const task = replaceTask(withSchedule(saved, sessionRef, schedule))
    if (await persistTask(task)) return { ok: true, task }
    const latest = tasks.value.find((entry) => entry.id === id)
    if (latest) replaceTask(withSchedule(latest, sessionRef, scheduleIn(saved, sessionRef)))
    return { ok: false, reason: 'persist-failed' }
  }

  /** The Agent's Schedule in a Session. */
  function taskSchedule(id: string, sessionRef: string): TaskScheduleState {
    const task = tasks.value.find((entry) => entry.id === id)
    const entry = task ? scheduleIn(task, sessionRef) : undefined
    if (!entry) return {}
    const { every, unit, startAt, enabled, nextRunAt } = entry
    return {
      schedule: { every, unit, startAt, enabled },
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    }
  }

  // Agent Library Schedules: always for an explicit, existing Session, and only for a saved Agent.
  /** Schedule a saved Agent in a Session that does not schedule it yet. */
  async function addSchedule(
    id: string,
    sessionRef: string,
    schedule: AgentTaskSchedule,
  ): Promise<AddScheduleResult> {
    const task = tasks.value.find((entry) => entry.id === id)
    if (!task) return { ok: false, reason: 'no-task' }
    if (!sessionsStore.sessions[sessionRef]) return { ok: false, reason: 'no-session' }
    if (scheduleIn(task, sessionRef)) return { ok: false, reason: 'already-scheduled' }
    return setSchedule(id, schedule, sessionRef)
  }

  function agentSchedules(id: string): AgentScheduleEntry[] {
    const task = tasks.value.find((entry) => entry.id === id)
    return (task?.schedules ?? []).map(
      ({ sessionRef, every, unit, startAt, enabled, nextRunAt }) => ({
        sessionRef,
        schedule: { every, unit, startAt, enabled },
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      }),
    )
  }

  /** Existing Sessions a saved Agent can still be scheduled in, most recent first. */
  function schedulableSessions(id: string): SessionSummary[] {
    const task = tasks.value.find((entry) => entry.id === id)
    if (!task) return []
    return sessionsStore.orderedSessions.filter((session) => !scheduleIn(task, session.id))
  }

  /** Ids of the Agents with a Schedule in the Session, paused ones included. */
  function agentsScheduledIn(sessionRef: string): string[] {
    return tasks.value.filter((task) => scheduleIn(task, sessionRef)).map((task) => task.id)
  }

  /** The Agent's run in a Session, the open one by default, or its last outcome. */
  function taskState(id: string, sessionRef = sessionsStore.openSessionId): TaskState {
    const run = sessionRef ? runIn(id, sessionRef) : undefined
    if (run) {
      const turn = pausedTurnOf(run)
      if (!turn) return { running: { ...run } }
      const reason = turn.pauseReason
      return { running: { ...run, paused: reason ? { reason } : {} } }
    }
    return { idle: tasks.value.find((task) => task.id === id)?.lastOutcome }
  }

  /** What in the Task's Settings Template cannot be used right now; empty when it can run. */
  function taskProblems(id: string): SessionSettingsProblem[] {
    const task = tasks.value.find((entry) => entry.id === id)
    return task ? agentMode.problemsOf(task.settingsTemplate) : []
  }

  /** Start an Agent Run in the open Session; refused while it cannot run or already runs there. */
  async function runTask(id: string, prompt = ''): Promise<RunTaskResult> {
    const slot = runSlot(id, sessionsStore.openSessionId ?? '')
    if (starting.has(slot)) return { ok: false, reason: 'running' }
    starting.add(slot)
    try {
      return await startManualRun(id, prompt)
    } finally {
      starting.delete(slot)
    }
  }

  async function startManualRun(id: string, prompt: string): Promise<RunTaskResult> {
    const capabilities = tasks.value.find((entry) => entry.id === id)?.settingsTemplate.capabilities
    await agentMode.loadMcpServersFor(capabilities ?? [])
    // Looked up after the wait, which a delete or a second Run may have overtaken.
    const checked = tasks.value.find((entry) => entry.id === id)
    if (!checked) return { ok: false, reason: 'no-task' }
    const open = sessionsStore.openSessionId
    if (open && runsIn(id, open)) return { ok: false, reason: 'running' }
    const problems = taskProblems(id)
    if (problems.length > 0) {
      const message = describeSettingsProblems(problems, i18n.state)
      return { ok: false, reason: 'settings-problems', problems, message }
    }
    const refusal = await chatModelRefusal(checked.settingsTemplate, checked.steps)
    if (refusal) return { ok: false, ...refusal }
    const sessionRef = await sessionsStore.ensureOpenSession()
    if (!sessionRef) return { ok: false, reason: 'no-session' }
    // The download may have taken long enough for a delete or a Scheduled Run to overtake it.
    const task = tasks.value.find((entry) => entry.id === id)
    if (!task) return { ok: false, reason: 'no-task' }
    if (runsIn(id, sessionRef)) return { ok: false, reason: 'running' }
    await startRun(task, sessionRef, false, prompt)
    return { ok: true }
  }

  /** A Scheduled Run nobody watches: a refusal is kept as the outcome and toasted. */
  async function runScheduled(id: string, sessionRef: string): Promise<void> {
    const slotTask = stillScheduled(id, sessionRef)
    if (!slotTask) return
    await agentMode.loadMcpServersFor(slotTask.settingsTemplate.capabilities ?? [])
    // A delete, pause or manual Run may have overtaken the wait.
    const task = stillScheduled(id, sessionRef)
    if (!task) return
    const refusal = scheduledRefusal(task)
    if (!refusal) return startRun(task, sessionRef, true)
    await recordNotStarted(task, refusal, true)
  }

  async function recordNotStarted(task: AgentTask, message: string, scheduled: boolean) {
    await recordOutcome(
      task.id,
      { kind: 'failed', reason: 'not-started', message, stepCount: task.steps.length },
      scheduled,
    )
  }

  function stillScheduled(id: string, sessionRef: string): AgentTask | undefined {
    const task = tasks.value.find((entry) => entry.id === id)
    if (!task || scheduleIn(task, sessionRef)?.enabled !== true) return undefined
    if (runsIn(id, sessionRef) || starting.has(runSlot(id, sessionRef))) return undefined
    if (deleting.has(id)) return undefined
    return task
  }

  function scheduledRefusal(task: AgentTask): string | null {
    if (!presets.presets.some((preset) => preset.name === AGENT_PRESET)) {
      return i18n.state.AGENT_TASK_PRESET_UNAVAILABLE ?? 'The Agent Maker preset is not available.'
    }
    const needsMcp = (task.settingsTemplate.capabilities ?? []).some((id) =>
      id.startsWith(MCP_CAPABILITY_PREFIX),
    )
    if (needsMcp && !mcp.serversLoaded) {
      return fillTemplate(
        i18n.state.AGENT_TASK_MCP_UNAVAILABLE ?? 'The MCP servers could not be loaded: {error}',
        { error: mcp.configError ?? '' },
      )
    }
    const problems = taskProblems(task.id)
    if (problems.length > 0) return describeSettingsProblems(problems, i18n.state)
    return null
  }

  /** A run gets a fresh Harness Session in its Session, so it carries no earlier context. */
  async function startRun(
    task: AgentTask,
    sessionRef: string,
    scheduled: boolean,
    prompt = '',
  ): Promise<void> {
    const id = task.id
    const slot = runSlot(id, sessionRef)
    const plan = cloneForIpc(task)
    minting.add(slot)
    let harness: { harnessSessionId: string; workspaceDir: string }
    try {
      const result = await window.electronAPI.sessions.taskRunHarness(sessionRef)
      if (!result.success) throw new Error(result.error)
      harness = result.harness
    } catch (error) {
      minting.delete(slot)
      if (!deleting.has(id)) await recordNotStarted(task, extractMessage(error), scheduled)
      return
    }
    minting.delete(slot)
    // A delete, pause or manual Run may have overtaken the wait.
    const current = tasks.value.find((entry) => entry.id === id)
    if (!current || runIn(id, sessionRef) || deleting.has(id)) return
    if (scheduled && scheduleIn(current, sessionRef)?.enabled !== true) return
    const sessionId = agentMode.createSession({
      id: harness.harnessSessionId,
      sessionRef,
      workspaceDir: harness.workspaceDir,
      settings: cloneForIpc(plan.settingsTemplate),
      presetName: AGENT_PRESET,
      title: plan.name,
      taskId: plan.id,
      taskRun: {
        taskId: plan.id,
        taskName: plan.name,
        startedAt: Date.now(),
        trigger: scheduled ? 'scheduled' : 'manual',
      },
    })
    runContexts[sessionId] = { plan, abort: new AbortController(), scheduled, prompt }
    runs.value = {
      ...runs.value,
      [sessionId]: {
        taskId: id,
        sessionId,
        sessionRef,
        stepIndex: 1,
        stepCount: plan.steps.length,
      },
    }
    void sendStep(sessionId, 1)
  }

  /** A Session runs one turn at a time: a Step due while it has one in flight waits for it. */
  function sessionBusy(sessionRef: string): boolean {
    return !!sessionsStore.turns[sessionRef]
  }

  watch(
    () => sessionsStore.turns,
    () => {
      for (const run of Object.values(runs.value)) {
        if (run.waiting && !sessionBusy(run.sessionRef)) {
          void sendStep(run.sessionId, run.stepIndex)
        }
      }
    },
  )

  /** The Agent whose run is in flight in the Session, if any. */
  function agentRunIn(sessionRef: string): AgentTask | undefined {
    const run = Object.values(runs.value).find((entry) => entry.sessionRef === sessionRef)
    return run ? tasks.value.find((task) => task.id === run.taskId) : undefined
  }

  /** Each Session's prompt waiting for its Agent Run, by the Agent's name. Memory only. */
  const queuedPrompts = ref<Record<string, string>>({})
  const queuedHolds: Record<string, { release: (go: boolean) => void; prompt?: string }> = {}
  /** Held prompts whose Session was left before the run ended, for its prompt bar to take back. */
  const unsentPrompts: Record<string, string> = {}

  function releaseQueuedPrompt(sessionRef: string, go: boolean): void {
    const hold = queuedHolds[sessionRef]
    if (!hold) return
    delete queuedHolds[sessionRef]
    const { [sessionRef]: _released, ...rest } = queuedPrompts.value
    queuedPrompts.value = rest
    hold.release(go)
  }

  /** Resolves once the Session's Agent Run and last turn are over (ADR-0005); false if unsent. */
  function afterAgentRun(sessionRef: string | null, prompt?: string): Promise<boolean> {
    if (!sessionRef) return Promise.resolve(true)
    const run = agentRunIn(sessionRef)
    if (!run) return Promise.resolve(true)
    releaseQueuedPrompt(sessionRef, false)
    queuedPrompts.value = { ...queuedPrompts.value, [sessionRef]: run.name }
    return new Promise((release) => (queuedHolds[sessionRef] = { release, prompt }))
  }

  function cancelQueuedPrompt(sessionRef: string): void {
    releaseQueuedPrompt(sessionRef, false)
  }

  /** The held prompt of a Session the user left, handed out once. */
  function takeUnsentPrompt(sessionRef: string): string | undefined {
    const prompt = unsentPrompts[sessionRef]
    delete unsentPrompts[sessionRef]
    return prompt
  }

  // A held prompt is sent by the prompt bar's mode, which follows the open Session.
  watch(
    () => sessionsStore.openSessionId,
    (open) => {
      for (const sessionRef of Object.keys(queuedHolds)) {
        if (sessionRef !== open) handBackQueuedPrompt(sessionRef)
      }
    },
  )

  function handBackQueuedPrompt(sessionRef: string): void {
    const name = queuedPrompts.value[sessionRef] ?? ''
    const prompt = queuedHolds[sessionRef]?.prompt
    if (prompt) unsentPrompts[sessionRef] = prompt
    releaseQueuedPrompt(sessionRef, false)
    const template = prompt
      ? (i18n.state.AGENT_RUN_QUEUED_PROMPT_RETURNED ??
        'Not sent: you left the session before Agent Run “{name}” ended. Your prompt is back in that session’s prompt bar.')
      : (i18n.state.AGENT_RUN_QUEUED_PROMPT_DROPPED ??
        'Not sent: you left the session before Agent Run “{name}” ended.')
    const userMessage = fillTemplate(template, { name })
    errors.report(
      createAppError({
        category: 'validation',
        code: 'agent-tasks/held-prompt-not-sent',
        severity: 'info',
        surface: 'toast',
        userMessage,
        technicalMessage: userMessage,
      }),
    )
  }

  /** A Session turn that is one of an Agent Run's Steps, not the user's own. */
  function isAgentRunTurn(turn: SessionTurn | null | undefined): boolean {
    return (
      turn?.kind === 'agent' &&
      !!turn.harnessSessionId &&
      runs.value[turn.harnessSessionId] !== undefined
    )
  }

  watch([runs, () => sessionsStore.turns], () => {
    for (const sessionRef of Object.keys(queuedHolds)) {
      if (!agentRunIn(sessionRef) && !sessionBusy(sessionRef)) releaseQueuedPrompt(sessionRef, true)
    }
  })

  async function sendStep(sessionId: string, stepIndex: number): Promise<void> {
    const run = runs.value[sessionId]
    const context = runContexts[sessionId]
    if (!run || !context) return
    const { plan, abort } = context
    const waiting = sessionBusy(run.sessionRef)
    const { waiting: _wasWaiting, ...rest } = run
    runs.value = {
      ...runs.value,
      [sessionId]: { ...rest, stepIndex, ...(waiting ? { waiting } : {}) },
    }
    markRunInFlight(run.taskId, {
      sessionId,
      sessionRef: run.sessionRef,
      stepIndex,
      stepCount: run.stepCount,
      ...(context.scheduled ? { scheduled: true } : {}),
    })
    if (waiting) return
    const steps = stepPrompts(plan.steps)
    const turn =
      stepIndex === 1 ? firstStepTurn(context.prompt ?? '', steps) : stepTurn(stepIndex, steps)
    const result = await agentMode.sendToSession(sessionId, turn, {
      settings: cloneForIpc(plan.settingsTemplate),
      signal: abort.signal,
      quietErrors: true,
      taskRun: { taskName: plan.name, stepIndex },
    })
    if (!result.ok && result.reason !== 'aborted') {
      await settleRun(sessionId, { kind: 'failed', stepIndex, message: result.message })
      agentMode.releaseHeldAnswer(sessionId)
    }
  }

  function markRunInFlight(taskId: string, activeRun: AgentTaskActiveRun): void {
    const task = tasks.value.find((entry) => entry.id === taskId)
    if (!task) return
    const others = (task.activeRuns ?? []).filter((run) => run.sessionId !== activeRun.sessionId)
    void persistTask(replaceTask(withEntries(task, 'activeRuns', [...others, activeRun])))
  }

  function replaceTask(updated: AgentTask): AgentTask {
    tasks.value = tasks.value.map((entry) => (entry.id === updated.id ? updated : entry))
    return updated
  }

  /** Stop the Agent's run in a Session, the open one by default. */
  async function stopTask(id: string, sessionRef = sessionsStore.openSessionId): Promise<void> {
    const run = sessionRef ? runIn(id, sessionRef) : undefined
    if (run) await stopRun(run.sessionId)
  }

  async function stopRun(sessionId: string): Promise<void> {
    const run = runs.value[sessionId]
    if (!run) return
    // Settled first, so the stopped turn's own settle finds no run and no Step can follow.
    const settled = settleRun(sessionId, { kind: 'stopped', stepIndex: run.stepIndex })
    await agentMode.stopSession(sessionId)
    await settled
  }

  function isSessionLockedByTask(sessionId: string): boolean {
    return runs.value[sessionId] !== undefined
  }

  agentMode.setTaskLockLookup((sessionId) => {
    const run = runs.value[sessionId]
    if (!run) return undefined
    const taskName = tasks.value.find((task) => task.id === run.taskId)?.name ?? ''
    return { taskName, signal: runContexts[sessionId]?.abort.signal }
  })

  /** The open Harness Session's Steps run with its Task's Settings Template: its own are locked. */
  const openSessionSettingsReadOnly = computed(() => isSessionLockedByTask(agentMode.openSessionId))

  agentMode.onTurnSettled((sessionId, outcome) => {
    const trialRun = trialRunOfHarness(sessionId)
    if (trialRun) {
      if (trialRun.state === 'running') advanceTrialRun(trialRun, outcome)
      return
    }
    const run = runs.value[sessionId]
    if (!run) return
    const { stepIndex, stepCount } = run
    if (outcome.kind === 'completed') {
      if (stepIndex < stepCount) void sendStep(sessionId, stepIndex + 1)
      else void settleRun(sessionId, { kind: 'completed' })
    } else if (outcome.kind === 'error') {
      void settleRun(sessionId, { kind: 'failed', stepIndex, message: outcome.message })
    } else {
      void settleRun(sessionId, { kind: 'stopped', stepIndex })
    }
  })

  /** End the run and keep how it ended as the Task's only outcome. */
  async function settleRun(sessionId: string, end: RunEnd): Promise<void> {
    const run = runs.value[sessionId]
    if (!run) return
    const { [sessionId]: _ended, ...rest } = runs.value
    runs.value = rest
    const scheduled = runContexts[sessionId]?.scheduled === true
    runContexts[sessionId]?.abort.abort()
    delete runContexts[sessionId]
    const declined = end.kind === 'failed' && end.message === MODEL_DOWNLOAD_DECLINED
    if (end.kind !== 'completed') {
      agentMode.endAgentRun(sessionId, {
        kind: end.kind,
        ...(end.message !== undefined ? { message: end.message } : {}),
      })
    }
    await recordOutcome(
      run.taskId,
      {
        ...end,
        sessionId,
        stepCount: run.stepCount,
        ...(declined ? { reason: 'download-declined' as const } : {}),
      },
      scheduled,
    )
  }

  /** Keeps the outcome and drops the run marker of the Harness Session it names. */
  async function recordOutcome(
    taskId: string,
    fields: OutcomeFields,
    scheduled = false,
  ): Promise<void> {
    const task = tasks.value.find((entry) => entry.id === taskId)
    if (!task) return
    if (fields.kind === 'failed') reportRunFailure(task, fields, scheduled)
    const lastOutcome: AgentTaskOutcome = {
      kind: fields.kind,
      at: Date.now(),
      ...(fields.sessionId !== undefined ? { sessionId: fields.sessionId } : {}),
      stepCount: fields.stepCount,
      ...(fields.stepIndex !== undefined ? { stepIndex: fields.stepIndex } : {}),
      ...(fields.message !== undefined ? { message: fields.message } : {}),
      ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
    }
    const activeRuns = (task.activeRuns ?? []).filter((run) => run.sessionId !== fields.sessionId)
    await persistTask(replaceTask({ ...withEntries(task, 'activeRuns', activeRuns), lastOutcome }))
  }

  /** The outcome shows a failed run, so only a Scheduled Run, which nobody watched, is toasted. */
  function reportRunFailure(task: AgentTask, end: OutcomeFields, scheduled: boolean): void {
    const declined =
      end.reason === 'download-declined' ? i18n.state.AGENT_TASKS_OUTCOME_DOWNLOAD_DECLINED : null
    const message = declined ?? end.message ?? end.reason ?? ''
    if (scheduled) {
      const notStarted = end.reason === 'not-started'
      const report = notStarted
        ? {
            category: 'validation' as const,
            code: 'agent-tasks/scheduled-run-not-started',
            template:
              i18n.state.AGENT_TASK_SCHEDULED_RUN_NOT_STARTED ??
              'The scheduled run of “{name}” could not start: {reason}',
          }
        : {
            category: 'inference' as const,
            code: 'agent-tasks/scheduled-run-failed',
            template:
              i18n.state.AGENT_TASK_SCHEDULED_RUN_FAILED ??
              'The scheduled run of “{name}” failed: {reason}',
          }
      const userMessage = fillTemplate(report.template, { name: task.name, reason: message })
      errors.report(
        createAppError({
          category: report.category,
          code: report.code,
          severity: 'warning',
          surface: 'toast',
          userMessage,
          technicalMessage: `Task "${task.name}" at step ${end.stepIndex ?? '-'}: ${userMessage}`,
          context: { taskId: task.id, stepIndex: end.stepIndex },
        }),
      )
      return
    }
    errors.report(
      createAppError({
        category: 'inference',
        code: 'agent-tasks/run-failed',
        severity: 'warning',
        surface: 'silent',
        userMessage: message,
        technicalMessage: `Task "${task.name}" failed at step ${end.stepIndex ?? '?'}: ${message}`,
        context: { taskId: task.id, stepIndex: end.stepIndex },
      }),
    )
  }

  function restoreEditableFields(saved: AgentTask): void {
    const latest = tasks.value.find((entry) => entry.id === saved.id)
    if (!latest) return
    const { name, description, image, steps, settingsTemplate, updatedAt } = saved
    const { description: _description, image: _image, ...rest } = latest
    replaceTask({
      ...rest,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(image !== undefined ? { image } : {}),
      steps,
      settingsTemplate,
      updatedAt,
    })
  }

  /** Send a prompt from the prompt bar to Agent Maker as one turn. */
  async function submitPrompt(prompt: string): Promise<void> {
    if (isSessionLockedByTask(agentMode.openSessionId)) return
    await agentMode.generate(prompt)
  }

  return {
    tasks,
    drafts,
    libraryAgents,
    createAgentDraft,
    editDraft,
    editDraftSettings,
    draftBlocker,
    draftSettingsProblems,
    saveAgentDraft,
    discardAgentDraft,
    trialRuns,
    trialRunInFlight,
    trialRunsInFlight,
    trialRunView,
    startTrialRun,
    stopTrialRun,
    runsInFlight,
    scheduledSessionIds,
    scheduledSessionCount,
    runningSessionCount,
    init,
    setSchedulesHeld,
    saveBlocker,
    deleteTask,
    pickedAgentIn,
    pickedAgent,
    agentSettingsProblems,
    pickAgent,
    runPickedAgent,
    chatWithPickedAgent,
    setSchedule,
    removeSchedule,
    taskSchedule,
    addSchedule,
    agentSchedules,
    schedulableSessions,
    agentsScheduledIn,
    taskState,
    taskProblems,
    runTask,
    stopTask,
    isSessionLockedByTask,
    afterAgentRun,
    cancelQueuedPrompt,
    takeUnsentPrompt,
    queuedPrompts,
    isAgentRunTurn,
    openSessionSettingsReadOnly,
    submitPrompt,
  }
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useAgentTasks, import.meta.hot))
