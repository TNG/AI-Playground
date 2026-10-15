import { z } from 'zod'
import { AgentSessionSettingsSchema } from './agentSessionIpc'

/**
 * Wire shapes for the kernel-owned Tasks file (`AI-Playground/agent-tasks.json`): the
 * Agent preset's reusable recipes — a folder, a Settings Template and ordered Steps.
 */

export const AgentTaskStepSchema = z.object({
  id: z.string(),
  prompt: z.string(),
})
export type AgentTaskStep = z.infer<typeof AgentTaskStepSchema>

export const AgentTaskOutcomeSchema = z.object({
  kind: z.enum(['completed', 'failed', 'stopped']),
  at: z.number(),
  /** Absent when a Scheduled Run could not start, so no Task Session exists. */
  sessionId: z.string().optional(),
  stepIndex: z.number().optional(),
  stepCount: z.number(),
  message: z.string().optional(),
  // Translated where shown, since `app-closed` is written at boot before the locale has loaded.
  reason: z.enum(['app-closed', 'not-started']).optional(),
})
export type AgentTaskOutcome = z.infer<typeof AgentTaskOutcomeSchema>

/** Persisted while a Task Run is in flight; still present at boot means the app closed mid-run. */
export const AgentTaskActiveRunSchema = z.object({
  sessionId: z.string(),
  stepIndex: z.number(),
  stepCount: z.number(),
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

export const AgentTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  workspaceDir: z.string(),
  settingsTemplate: AgentSessionSettingsSchema,
  steps: z.array(AgentTaskStepSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastOutcome: AgentTaskOutcomeSchema.optional(),
  activeRun: AgentTaskActiveRunSchema.optional(),
  schedule: AgentTaskScheduleSchema.optional(),
  /** Present only while the Schedule is enabled. */
  nextRunAt: z.number().optional(),
})
export type AgentTask = z.infer<typeof AgentTaskSchema>

export const AgentTasksFileSchema = z.object({
  schemaVersion: z.literal(1),
  tasks: z.array(AgentTaskSchema),
})
