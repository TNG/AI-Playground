import { z } from 'zod'
import { AgentSessionSettingsSchema, AgentTaskStepSchema } from './agentSessionIpc'

export { AgentTaskStepSchema, type AgentTaskStep } from './agentSessionIpc'

/**
 * Wire shapes for the kernel-owned Agents file (`AI-Playground/agent-tasks.json`): the
 * Agent preset's named settings — its Session, a Settings Template and ordered Steps.
 */

export const AgentTaskOutcomeSchema = z.object({
  kind: z.enum(['completed', 'failed', 'stopped']),
  at: z.number(),
  /** Absent when a Scheduled Run could not start, so no Harness Session exists. */
  sessionId: z.string().optional(),
  stepIndex: z.number().optional(),
  stepCount: z.number(),
  message: z.string().optional(),
  // Translated where shown, since `app-closed` is written at boot before the locale has loaded.
  reason: z.enum(['app-closed', 'not-started', 'download-declined']).optional(),
})
export type AgentTaskOutcome = z.infer<typeof AgentTaskOutcomeSchema>

/**
 * Persisted while a Task Run is in flight. Still present at boot means the app
 * closed, unless that session's turn is still in the kernel snapshot.
 */
export const AgentTaskActiveRunSchema = z.object({
  sessionId: z.string(),
  /** The Session the run is in; empty on a marker from before runs knew their Session. */
  sessionRef: z.string(),
  stepIndex: z.number(),
  stepCount: z.number(),
  /** Set for a Scheduled Run, so a reattached one still toasts a failure. */
  scheduled: z.boolean().optional(),
})
export type AgentTaskActiveRun = z.infer<typeof AgentTaskActiveRunSchema>

export const AGENT_TASK_SCHEDULE_UNITS = ['minutes', 'hours', 'days', 'weeks'] as const
export type AgentTaskScheduleUnit = (typeof AGENT_TASK_SCHEDULE_UNITS)[number]

export const MIN_SCHEDULE_MINUTES = 5

/**
 * Slots are `startAt + k × every unit`; `startAt` also fixes the time of day for days and weeks.
 * The minimum interval is the store's to enforce: one hand-edited Task must not make the file unreadable.
 */
export const AgentTaskScheduleSchema = z.object({
  every: z.number().int().min(1),
  unit: z.enum(AGENT_TASK_SCHEDULE_UNITS),
  startAt: z.number(),
  enabled: z.boolean(),
})
export type AgentTaskSchedule = z.infer<typeof AgentTaskScheduleSchema>

/** One Agent's Schedule in one Session; the Next Run is present only while it is enabled. */
export const AgentSessionScheduleSchema = AgentTaskScheduleSchema.extend({
  sessionRef: z.string().min(1),
  nextRunAt: z.number().optional(),
})
export type AgentSessionSchedule = z.infer<typeof AgentSessionScheduleSchema>

export const AgentTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  /** A data URI, shown beside the Agent's name. */
  image: z.string().optional(),
  /** The Session the Agent was made in, for information only; absent when there is none. */
  sessionRef: z.string().min(1).optional(),
  /** Only on an Agent saved before Sessions. */
  workspaceDir: z.string().optional(),
  settingsTemplate: AgentSessionSettingsSchema,
  steps: z.array(AgentTaskStepSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastOutcome: AgentTaskOutcomeSchema.optional(),
  /** One per Session the Agent has a run in flight in. */
  activeRuns: z.array(AgentTaskActiveRunSchema).optional(),
  /** At most one per Session. */
  schedules: z.array(AgentSessionScheduleSchema).optional(),
  /** `/agents` on a Channel lists and starts it; false when absent. */
  startableFromChannel: z.boolean().optional(),
})
export type AgentTask = z.infer<typeof AgentTaskSchema>

/** An old single `schedule` moves into the Agent's own Session, or is dropped without one. */
function migrateLegacyAgent(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const { schedule, nextRunAt, activeRun, ...rest } = raw as Record<string, unknown>
  const sessionRef = typeof rest.sessionRef === 'string' ? rest.sessionRef : undefined
  const migrated: Record<string, unknown> = { ...rest }
  if (schedule !== undefined && sessionRef && rest.schedules === undefined) {
    const next = nextRunAt !== undefined ? { nextRunAt } : {}
    migrated.schedules = [{ ...(schedule as object), sessionRef, ...next }]
  }
  if (activeRun !== undefined && rest.activeRuns === undefined) {
    const run = activeRun as Record<string, unknown>
    migrated.activeRuns = [{ ...run, sessionRef: run.sessionRef ?? sessionRef ?? '' }]
  }
  return migrated
}

/** Version 2: the Agent Library migration has run (Agent Presets folded into their Agents). */
export const AGENT_LIBRARY_SCHEMA_VERSION = 2
/** Version 3: Agent Maker merged into Assistant (Settings Templates gained `files`). */
export const AGENT_TASKS_SCHEMA_VERSION = 3

export const AgentTasksFileSchema = z.object({
  schemaVersion: z.union([
    z.literal(1),
    z.literal(AGENT_LIBRARY_SCHEMA_VERSION),
    z.literal(AGENT_TASKS_SCHEMA_VERSION),
  ]),
  tasks: z.array(z.preprocess(migrateLegacyAgent, AgentTaskSchema)),
})

/**
 * An Agent's unsaved edits, at most one per Agent. A new Agent exists only as a Draft
 * until first saved, so `agentId` need not name a saved Agent.
 */
export const AgentDraftSchema = z.object({
  agentId: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  image: z.string().optional(),
  settingsTemplate: AgentSessionSettingsSchema,
  steps: z.array(AgentTaskStepSchema),
  updatedAt: z.number(),
})
export type AgentDraft = z.infer<typeof AgentDraftSchema>

export const AgentDraftsFileSchema = z.object({
  schemaVersion: z.literal(1),
  drafts: z.array(AgentDraftSchema),
})

/**
 * Where an Agent's Trial Run is, kept beside its scratch folder so a reloaded window can pick it
 * up. `stepIndex` is 1-based; `stepCount` is how many Steps it runs.
 */
export const TrialRunRecordSchema = z.object({
  agentId: z.string().min(1),
  harnessSessionId: z.string().min(1),
  name: z.string(),
  stepIndex: z.number(),
  stepCount: z.number(),
  startedAt: z.number(),
  state: z.enum(['running', 'completed', 'failed', 'stopped']),
  message: z.string().optional(),
  /** What the user typed in front of Step 1. */
  input: z.string().optional(),
})
export type TrialRunRecord = z.infer<typeof TrialRunRecordSchema>
