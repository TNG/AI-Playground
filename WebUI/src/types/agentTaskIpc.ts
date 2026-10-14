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
  sessionId: z.string(),
  stepIndex: z.number().optional(),
  stepCount: z.number(),
  message: z.string().optional(),
})
export type AgentTaskOutcome = z.infer<typeof AgentTaskOutcomeSchema>

export const AgentTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  workspaceDir: z.string(),
  settingsTemplate: AgentSessionSettingsSchema,
  steps: z.array(AgentTaskStepSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastOutcome: AgentTaskOutcomeSchema.optional(),
})
export type AgentTask = z.infer<typeof AgentTaskSchema>

export const AgentTasksFileSchema = z.object({
  schemaVersion: z.literal(1),
  tasks: z.array(AgentTaskSchema),
})
