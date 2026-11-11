import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import {
  MODEL_DOWNLOAD_DECLINED,
  promptHasImageAttachment,
  type AgentAnswerOrigin,
} from '@/types/agentIpc'
import type { AgentFollowUpTag, AgentSessionSettings } from '@/types/agentSessionIpc'
import type { PauseReason } from '@/types/kernelEvents'
import type { InFlightWorkItem } from '@/types/lifecycleIpc'
import type { SessionSummary } from '@/types/sessionIpc'
import type { RunProgress } from '@/lib/turnTypes'
import type { AgentRunRefusal } from './channels/answerRouter'
import type {
  AgentDraft,
  AgentSessionSchedule,
  AgentTask,
  AgentTaskActiveRun,
  AgentTaskOutcome,
  AgentTaskSchedule,
  AgentTaskStep,
} from '@/types/agentTaskIpc'
import { AGENT_TEMPLATE_CAPABILITY_IDS, MCP_CAPABILITY_PREFIX } from '@/types/agentCapabilities'
import {
  useAgentMode,
  type SendToSessionResult,
  type SessionTurnInfo,
  type TurnOutcome,
} from './agentMode'
import { HARNESS_CHAT_PRESET, isHarnessChatPreset } from '@/lib/harnessChatPreset'
import { useQueuedChannelMessages } from './queuedChannelMessages'
import { useDemoMode } from './demoMode'
import { useErrors } from './errors'
import { useI18N } from './i18n'
import { useMcp } from './mcp'
import { usePresets } from './presets'
import { useSessions } from './sessions'
import { useTextInference } from './textInference'
import { useUIStore } from './ui'
import { createAppError, extractMessage, isCancellation } from '@/assets/js/errors/appError'
import { requestDownload } from '@/assets/js/permissions/permissions'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { afterStepTurn, sendRunStep } from '@/lib/agentStepRun'
import { liveAgentSessions } from '@/lib/liveAgentSessions'
import { nextSlotAfter, scheduleProblem, type ScheduleProblem } from '@/lib/taskSchedule'
import { fillTemplate } from '@/lib/fillTemplate'
import { neverRunRefusal, type NeverRunRefusal } from '@/lib/agentNames'
import {
  agentComposerState,
  type AgentComposerState,
  type LatestAgentRun,
} from '@/lib/agentComposer'
import { latestTurnOf } from '@/lib/sessionTimeline'
import { taskRunWorkItem } from '@/lib/inFlightWorkItem'
import {
  describeSettingsProblems,
  type SessionSettingsProblem,
} from '@/lib/sessionSettingsProblems'

export type TaskDraft = { name: string; steps: AgentTaskStep[] }

/** What a prompt sent from the prompt bar waits for in its Session. */
export type HeldPrompt = { behind: 'agent-run'; name: string } | { behind: 'channel-messages' }

/** How starting an Agent Run from a Channel went; a busy Session takes it once its turn ends. */
export type ChannelStartResult =
  | { ok: true }
  | { ok: false; reason: 'no-task' | 'busy' | 'task-locked' | 'not-started'; message: string }
  | { ok: false; reason: 'settings-problems'; message: string }

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
export type SessionScheduleState = 'active' | 'paused'

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

export type FollowUpResult = RunTaskResult | SendToSessionResult | NeverRunRefusal

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

/** One Schedule in a Session, of any Agent, as the Session's Agent Schedules tab lists it. */
export type SessionScheduleEntry = Omit<AgentScheduleEntry, 'sessionRef'> & { agentId: string }

type RunEnd = Pick<AgentTaskOutcome, 'kind' | 'stepIndex' | 'message'>

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
  const queuedChannelMessages = useQueuedChannelMessages()
  const demoMode = useDemoMode()
  const errors = useErrors()
  const i18n = useI18N()
  const mcp = useMcp()
  const presets = usePresets()
  const sessionsStore = useSessions()
  const textInference = useTextInference()
  const ui = useUIStore()

  /** The Agents library, listed in every Session. */
  const tasks = ref<AgentTask[]>([])

  /** Each Agent's unsaved edits, by Agent id; an Agent never saved exists only here. */
  const drafts = ref<Record<string, AgentDraft>>({})
  /** New Agents not edited yet: their Drafts are not on disk, and go when the Library leaves them. */
  const untouchedDrafts = new Set<string>()

  /** Runs in flight by Harness Session; at most one per Agent and Session. */
  const runs = ref<Record<string, TaskRun>>({})
  /** The Task as its run started, and the abort that keeps an ended run from sending a Step. */
  const runContexts: Record<
    string,
    {
      plan: AgentTask
      abort: AbortController
      scheduled: boolean
      prompt?: string
      origin?: AgentAnswerOrigin
    }
  > = {}

  /** Runs (by `runSlot`) whose ▶ Run is still being checked, possibly waiting on a download. */
  const starting = reactive(new Set<string>())
  /** Runs (by `runSlot`) getting their Harness Session from main. */
  const minting = reactive(new Set<string>())

  const contributedWork = shallowRef<(() => InFlightWorkItem[])[]>([])
  const agentDeletedListeners = new Set<(agentId: string) => Promise<void>>()

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
    ...contributedWork.value.flatMap((work) => work()),
  ])

  watch(inFlightWork, (work) => window.electronAPI?.reportInFlightWork?.(work), {
    immediate: true,
  })

  /** In-flight Work another store owns, reported with this store's own. */
  function contributeInFlightWork(work: () => InFlightWorkItem[]): void {
    contributedWork.value = [...contributedWork.value, work]
  }

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
    earlySettles ??= []
    try {
      if (!(await restoreLibrary())) return
    } finally {
      replayEarlySettles()
    }
    skipMissedSlots()
    clearInterval(scheduleTicker)
    scheduleTicker = setInterval(tickSchedules, SCHEDULE_TICK_MS)
  }

  async function restoreLibrary(): Promise<boolean> {
    try {
      const result = await window.electronAPI.agentMode.readTasks()
      if (!result.success) throw new Error(result.error)
      tasks.value = result.tasks
    } catch (error) {
      reportReadFailure(error)
      return false
    }
    await readDrafts()
    await settleInterruptedRuns()
    return true
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

  /**
   * A run marker with no turn left in main was cut off (process death). A turn
   * main still holds is the same run: keep the step loop attached to it.
   */
  async function settleInterruptedRuns(): Promise<void> {
    const live = await liveAgentSessions()
    for (const task of [...tasks.value]) {
      for (const activeRun of task.activeRuns ?? []) {
        const { sessionId, stepIndex, stepCount } = activeRun
        if (turnStillHeard(sessionId, live)) {
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
    const { inference } = textInference.inferenceForSettings(HARNESS_CHAT_PRESET, template)
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

  /** Sessions holding a Schedule; paused only when none of their Schedules is enabled. */
  const scheduledSessions = computed(() => {
    const states = new Map<string, SessionScheduleState>()
    for (const entry of tasks.value.flatMap((task) => task.schedules ?? [])) {
      if (entry.enabled) states.set(entry.sessionRef, 'active')
      else if (!states.has(entry.sessionRef)) states.set(entry.sessionRef, 'paused')
    }
    return states
  })

  /** How many Sessions hold a Schedule of the Agent, paused ones included. */
  function scheduledSessionCount(id: string): number {
    return tasks.value.find((task) => task.id === id)?.schedules?.length ?? 0
  }

  /** How many Sessions the Agent has a run in flight in; deleting it is refused until none. */
  function runningSessionCount(id: string): number {
    return Object.values(runs.value).filter((run) => run.taskId === id).length
  }

  function onAgentDeleted(listener: (agentId: string) => Promise<void>): void {
    agentDeletedListeners.add(listener)
  }

  const channelRunRefusedListeners = new Set<
    (sessionRef: string, refusal: AgentRunRefusal) => void
  >()

  /** Hear a Channel-started run's later Step refused here, which main never sees; returns the unsubscribe. */
  function onChannelRunRefused(
    listener: (sessionRef: string, refusal: AgentRunRefusal) => void,
  ): () => void {
    channelRunRefusedListeners.add(listener)
    return () => channelRunRefusedListeners.delete(listener)
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
    await Promise.all([...agentDeletedListeners].map((listener) => listener(id)))
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

  /** The open Session's picked Agent, in effect while Assistant is the active preset. */
  const pickedAgent = computed((): AgentTask | undefined =>
    isHarnessChatPreset(presets.activePresetWithVariant?.name)
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

  /** Pick a saved Agent in the open Session's prompt bar, or `null` for Assistant itself. */
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

  /** The Harness Session of the Agent's latest Agent Run in the Session, scheduled ones included. */
  function latestRunOf(agentId: string, sessionRef: string): LatestAgentRun | undefined {
    const runs = Object.values(agentMode.sessions).flatMap((record) =>
      record.sessionRef === sessionRef && record.taskRun?.taskId === agentId
        ? [{ startedAt: record.taskRun.startedAt, harnessSessionId: record.id }]
        : [],
    )
    return runs.sort((a, b) => a.startedAt - b.startedAt).at(-1)
  }

  /** Which of ▶ and → Enter triggers with an Agent picked, from its runs and the Session timeline. */
  const pickedAgentComposer = computed((): AgentComposerState | undefined => {
    const agent = pickedAgent.value
    const open = sessionsStore.openSessionId
    if (!agent) return undefined
    const latestRun = open ? latestRunOf(agent.id, open) : undefined
    return agentComposerState({
      latestRun,
      latestTurn: latestTurnOf(
        sessionsStore.openTimeline,
        (id) => agentMode.sessions[id]?.agentChat?.agentName,
      ),
      agentEdited: !!latestRun && agent.updatedAt > latestRun.startedAt,
    })
  })

  /**
   * → with an Agent picked: a Follow-up, continuing the Harness Session of its latest Agent Run in
   * the open Session on the Agent's saved Settings Template; refused when it has not run there.
   */
  async function followUpPickedAgent(prompt: string): Promise<FollowUpResult> {
    const picked = pickedAgent.value
    if (!picked) return { ok: false, reason: 'no-task' }
    const open = sessionsStore.openSessionId
    if (!open || !latestRunOf(picked.id, open)) return neverRun(picked)
    await agentMode.loadMcpServersFor(picked.settingsTemplate.capabilities ?? [])
    const problems = taskProblems(picked.id)
    if (problems.length > 0) {
      const message = describeSettingsProblems(problems, i18n.state)
      return { ok: false, reason: 'settings-problems', problems, message }
    }
    const refusal = await chatModelRefusal(picked.settingsTemplate, [{ id: 'prompt', prompt }])
    if (refusal) return { ok: false, ...refusal }
    // The download may have taken long enough for a delete or a new run to overtake it.
    const agent = tasks.value.find((entry) => entry.id === picked.id)
    if (!agent) return { ok: false, reason: 'no-task' }
    const harnessSessionId = latestRunOf(agent.id, open)?.harnessSessionId
    if (!harnessSessionId) return neverRun(agent)
    return agentMode.sendToSession(harnessSessionId, prompt, {
      settings: cloneForIpc(agent.settingsTemplate),
      followUp: { agentId: agent.id, agentName: agent.name },
    })
  }

  const neverRun = (agent: AgentTask) => neverRunRefusal(agent.name, i18n.state)

  /** A deleted Agent's Sessions fall back to Assistant. */
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
    untouchedDrafts.delete(draft.agentId)
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
      settingsTemplate: { capabilities: [...AGENT_TEMPLATE_CAPABILITY_IDS] },
      steps: [],
      updatedAt: Date.now(),
    }
    drafts.value = { ...drafts.value, [draft.agentId]: draft }
    untouchedDrafts.add(draft.agentId)
    return draft
  }

  watch(
    () => ui.agentLibrary?.agentId,
    (_selected, left) => {
      if (left && untouchedDrafts.has(left)) forgetDraft(left)
    },
  )

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

  function forgetDraft(id: string): void {
    untouchedDrafts.delete(id)
    const { [id]: _removed, ...rest } = drafts.value
    drafts.value = rest
  }

  async function removeDraft(id: string): Promise<boolean> {
    if (!drafts.value[id]) return true
    if (untouchedDrafts.has(id)) {
      forgetDraft(id)
      return true
    }
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
    forgetDraft(id)
    return true
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

  /** Every Agent's Schedule in the Session, in library order. */
  function sessionSchedules(sessionRef: string): SessionScheduleEntry[] {
    return tasks.value.flatMap((task) => {
      const entry = scheduleIn(task, sessionRef)
      if (!entry) return []
      const { every, unit, startAt, enabled, nextRunAt } = entry
      return [
        {
          agentId: task.id,
          schedule: { every, unit, startAt, enabled },
          ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        },
      ]
    })
  }

  /** Saved Agents an existing Session can still schedule, in library order. */
  function schedulableAgents(sessionRef: string): AgentTask[] {
    if (!sessionsStore.sessions[sessionRef]) return []
    return tasks.value.filter((task) => !scheduleIn(task, sessionRef))
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
    if (!refusal) {
      await startRun(task, sessionRef, true)
      return
    }
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
    if (!presets.presets.some((preset) => isHarnessChatPreset(preset.name))) {
      return i18n.state.AGENT_TASK_PRESET_UNAVAILABLE ?? 'The Assistant preset is not available.'
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

  /** The Agents `/agents` lists on a Channel. */
  const startableAgents = computed(() =>
    tasks.value
      .filter((task) => task.startableFromChannel)
      .map((task) => ({ agentId: task.id, name: task.name })),
  )

  /** Lets a Channel list and start the Agent, or no longer; written at once like a Schedule. */
  async function setStartableFromChannel(id: string, startable: boolean): Promise<boolean> {
    const saved = tasks.value.find((entry) => entry.id === id)
    if (!saved) return false
    const { startableFromChannel: _was, ...rest } = saved
    const task = replaceTask(startable ? { ...rest, startableFromChannel: true } : rest)
    if (await persistTask(task)) return true
    const latest = tasks.value.find((entry) => entry.id === id)
    if (latest) replaceTask({ ...latest, startableFromChannel: saved.startableFromChannel })
    return false
  }

  /**
   * An Agent Run a Channel asked for, in that Channel's Session on the Agent's Settings Template.
   * Like a Scheduled Run nobody watches, a missing model is asked for by its first Step.
   */
  async function startFromChannel(
    id: string,
    sessionRef: string,
    origin: AgentAnswerOrigin,
  ): Promise<ChannelStartResult> {
    const notStartable = () => ({
      ok: false as const,
      reason: 'no-task' as const,
      message:
        i18n.state.AGENT_TASK_NOT_STARTABLE_FROM_CHANNEL ??
        'This agent can no longer be started from a Channel.',
    })
    const slot = runSlot(id, sessionRef)
    if (!tasks.value.find((entry) => entry.id === id)?.startableFromChannel) return notStartable()
    const running = agentRunIn(sessionRef)
    if (running || starting.has(slot) || minting.has(slot)) {
      return { ok: false, reason: 'task-locked', message: running?.name ?? '' }
    }
    if (sessionBusy(sessionRef)) return { ok: false, reason: 'busy', message: '' }
    starting.add(slot)
    try {
      const capabilities = tasks.value.find((entry) => entry.id === id)?.settingsTemplate
      await agentMode.loadMcpServersFor(capabilities?.capabilities ?? [])
      // A delete, an edit or another run may have overtaken the wait.
      const task = tasks.value.find((entry) => entry.id === id)
      if (!task?.startableFromChannel || deleting.has(id)) return notStartable()
      if (agentRunIn(sessionRef)) return { ok: false, reason: 'task-locked', message: '' }
      const refusal = scheduledRefusal(task)
      if (refusal) return { ok: false, reason: 'settings-problems', message: refusal }
      const failed = await startRun(task, sessionRef, false, '', origin)
      return failed === null ? { ok: true } : { ok: false, reason: 'not-started', message: failed }
    } finally {
      starting.delete(slot)
    }
  }

  /**
   * A message to an Agent Run's Harness Session is a Follow-up on its Agent's saved Settings
   * Template; undefined when the Harness Session is no saved Agent's run.
   */
  function followUpOf(
    harnessSessionId: string,
  ): { settings: AgentSessionSettings; followUp: AgentFollowUpTag } | undefined {
    const taskId = agentMode.sessions[harnessSessionId]?.taskRun?.taskId
    const agent = taskId ? tasks.value.find((entry) => entry.id === taskId) : undefined
    if (!agent) return undefined
    return {
      settings: cloneForIpc(agent.settingsTemplate),
      followUp: { agentId: agent.id, agentName: agent.name },
    }
  }

  /**
   * A run gets a fresh Harness Session in its Session, so it carries no earlier context. Returns
   * why it did not start, or null; a run overtaken by a delete or another run counts as started.
   */
  async function startRun(
    task: AgentTask,
    sessionRef: string,
    scheduled: boolean,
    prompt = '',
    origin?: AgentAnswerOrigin,
  ): Promise<string | null> {
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
      const message = extractMessage(error)
      if (!deleting.has(id)) await recordNotStarted(task, message, scheduled)
      return message
    }
    minting.delete(slot)
    // A delete, pause or manual Run may have overtaken the wait.
    const current = tasks.value.find((entry) => entry.id === id)
    if (!current || runIn(id, sessionRef) || deleting.has(id)) return null
    if (scheduled && scheduleIn(current, sessionRef)?.enabled !== true) return null
    const sessionId = agentMode.createSession({
      id: harness.harnessSessionId,
      sessionRef,
      workspaceDir: harness.workspaceDir,
      settings: cloneForIpc(plan.settingsTemplate),
      presetName: HARNESS_CHAT_PRESET,
      title: plan.name,
      taskId: plan.id,
      taskRun: {
        taskId: plan.id,
        taskName: plan.name,
        startedAt: Date.now(),
        trigger: origin ? 'channel' : scheduled ? 'scheduled' : 'manual',
        ...(origin ? { channel: origin.channel } : {}),
        ...(prompt.trim() ? { input: prompt.trim() } : {}),
      },
    })
    runContexts[sessionId] = {
      plan,
      abort: new AbortController(),
      scheduled,
      prompt,
      ...(origin ? { origin } : {}),
    }
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
    if (!origin) {
      void sendStep(sessionId, 1)
      return null
    }
    // The Channel hears a refused first Step as the start's own refusal.
    return sendStep(sessionId, 1)
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
          void sendLaterStep(run.sessionId, run.stepIndex)
        }
      }
    },
  )

  /** The Agent whose run is in flight in the Session, if any. */
  function agentRunIn(sessionRef: string): AgentTask | undefined {
    const run = Object.values(runs.value).find((entry) => entry.sessionRef === sessionRef)
    return run ? tasks.value.find((task) => task.id === run.taskId) : undefined
  }

  /** The Agent Run in flight in the Session (between Steps too): its Agent's name and Step. */
  function agentRunStepIn(
    sessionRef: string,
  ): { name: string; step: number; steps: number } | undefined {
    const run = Object.values(runs.value).find((entry) => entry.sessionRef === sessionRef)
    if (!run) return undefined
    const name = tasks.value.find((task) => task.id === run.taskId)?.name ?? ''
    return { name, step: run.stepIndex, steps: run.stepCount }
  }

  /** Each Session's prompt waiting for its Agent Run or queued Channel messages. Memory only. */
  const queuedPrompts = ref<Record<string, HeldPrompt>>({})
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

  /**
   * Resolves once the Session's Agent Run (ADR-0005), the Channel messages queued in it and its
   * last turn are over; false if unsent.
   */
  function afterAgentRun(sessionRef: string | null, prompt?: string): Promise<boolean> {
    if (!sessionRef) return Promise.resolve(true)
    const run = agentRunIn(sessionRef)
    if (!run && !queuedChannelMessages.holdsPrompts(sessionRef)) return Promise.resolve(true)
    releaseQueuedPrompt(sessionRef, false)
    const held: HeldPrompt = run
      ? { behind: 'agent-run', name: run.name }
      : { behind: 'channel-messages' }
    queuedPrompts.value = { ...queuedPrompts.value, [sessionRef]: held }
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
    const held = queuedPrompts.value[sessionRef]
    const prompt = queuedHolds[sessionRef]?.prompt
    if (prompt) unsentPrompts[sessionRef] = prompt
    releaseQueuedPrompt(sessionRef, false)
    const template =
      held?.behind === 'channel-messages'
        ? prompt
          ? (i18n.state.CHANNEL_QUEUED_PROMPT_RETURNED ??
            'Not sent: you left the session before the Channel messages queued in it had run. Your prompt is back in that session’s prompt bar.')
          : (i18n.state.CHANNEL_QUEUED_PROMPT_DROPPED ??
            'Not sent: you left the session before the Channel messages queued in it had run.')
        : prompt
          ? (i18n.state.AGENT_RUN_QUEUED_PROMPT_RETURNED ??
            'Not sent: you left the session before Agent Run “{name}” ended. Your prompt is back in that session’s prompt bar.')
          : (i18n.state.AGENT_RUN_QUEUED_PROMPT_DROPPED ??
            'Not sent: you left the session before Agent Run “{name}” ended.')
    const name = held?.behind === 'agent-run' ? held.name : ''
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

  /** A turn this window runs in the Session, which main's ledger may not show yet. */
  function liveTurnIn(sessionRef: string): boolean {
    return Object.values(agentMode.sessions).some(
      (record) => record.sessionRef === sessionRef && !!agentMode.sessionTurns[record.id],
    )
  }

  watch(
    [
      runs,
      () => sessionsStore.turns,
      () => agentMode.sessionTurns,
      () => queuedChannelMessages.queued,
      () => queuedChannelMessages.sending,
    ],
    () => {
      for (const sessionRef of Object.keys(queuedHolds)) {
        const free =
          !agentRunIn(sessionRef) &&
          !sessionBusy(sessionRef) &&
          !queuedChannelMessages.holdsPrompts(sessionRef) &&
          !liveTurnIn(sessionRef)
        if (free) releaseQueuedPrompt(sessionRef, true)
      }
    },
  )

  /** Sends the Step unless it has to wait; returns why the window refused it, or null. */
  async function sendStep(sessionId: string, stepIndex: number): Promise<string | null> {
    const run = runs.value[sessionId]
    const context = runContexts[sessionId]
    if (!run || !context) return null
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
    if (waiting) return null
    let refusal: string | null = null
    await sendRunStep(
      agentMode,
      {
        sessionId,
        stepIndex,
        taskName: plan.name,
        steps: plan.steps,
        settingsTemplate: plan.settingsTemplate,
        signal: abort.signal,
        ...(context.scheduled ? { scheduled: true } : {}),
        ...(context.prompt !== undefined ? { prompt: context.prompt } : {}),
        ...(context.origin ? { origin: context.origin } : {}),
      },
      (message) => {
        refusal = message
        return settleRun(sessionId, { kind: 'failed', stepIndex, message })
      },
    )
    return refusal
  }

  /** A Step after the run's start; a Channel-started run's refusal goes to its Channel. */
  async function sendLaterStep(sessionId: string, stepIndex: number): Promise<void> {
    const run = runs.value[sessionId]
    const context = runContexts[sessionId]
    const reason = await sendStep(sessionId, stepIndex)
    if (reason === null || !run || !context?.origin) return
    const refusal = { origin: context.origin, name: context.plan.name, step: stepIndex, reason }
    for (const listener of [...channelRunRefusedListeners]) listener(run.sessionRef, refusal)
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

  /** Stop the Agent Run in flight in the Session, whichever Agent it is. */
  async function stopRunIn(sessionRef: string): Promise<void> {
    const run = Object.values(runs.value).find((entry) => entry.sessionRef === sessionRef)
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

  /** Turns that ended while `init` restored the runs, which may have been theirs. */
  let earlySettles: [string, TurnOutcome][] | null = null

  function replayEarlySettles(): void {
    const settled = earlySettles ?? []
    earlySettles = null
    for (const [sessionId, outcome] of settled) onTurnSettled(sessionId, outcome)
  }

  /** Main or this window still holds the run's turn, or it ended while the runs were restored. */
  function turnStillHeard(sessionId: string, live: Set<string>): boolean {
    return (
      live.has(sessionId) ||
      !!agentMode.sessionTurns[sessionId] ||
      !!earlySettles?.some(([settled]) => settled === sessionId)
    )
  }

  agentMode.onTurnSettled((sessionId, outcome) => {
    if (earlySettles) earlySettles.push([sessionId, outcome])
    else onTurnSettled(sessionId, outcome)
  })

  function onTurnSettled(sessionId: string, outcome: TurnOutcome): void {
    const run = runs.value[sessionId]
    if (!run) return
    const { stepIndex } = run
    const next = afterStepTurn(outcome, stepIndex, run.stepCount)
    if (next.kind === 'step') void sendLaterStep(sessionId, next.stepIndex)
    else if (next.kind === 'completed') void settleRun(sessionId, { kind: 'completed' })
    else if (next.kind === 'failed')
      void settleRun(sessionId, { kind: 'failed', stepIndex, message: next.message })
    else void settleRun(sessionId, { kind: 'stopped', stepIndex })
  }

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

  /** Send a prompt from the prompt bar to Assistant as one turn. */
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
    chatModelRefusal,
    contributeInFlightWork,
    onAgentDeleted,
    onChannelRunRefused,
    runsInFlight,
    scheduledSessions,
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
    followUpPickedAgent,
    pickedAgentComposer,
    setSchedule,
    removeSchedule,
    taskSchedule,
    addSchedule,
    agentSchedules,
    schedulableSessions,
    sessionSchedules,
    schedulableAgents,
    agentsScheduledIn,
    taskState,
    taskProblems,
    runTask,
    startableAgents,
    setStartableFromChannel,
    startFromChannel,
    followUpOf,
    stopTask,
    stopRunIn,
    agentRunIn,
    agentRunStepIn,
    isSessionLockedByTask,
    afterAgentRun,
    cancelQueuedPrompt,
    takeUnsentPrompt,
    queuedPrompts,
    openSessionSettingsReadOnly,
    submitPrompt,
  }
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useAgentTasks, import.meta.hot))
