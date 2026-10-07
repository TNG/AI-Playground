import { z } from 'zod'
import { AgentModeModelConfigSchema } from './agentIpc'

/**
 * Wire shapes for the kernel-owned Agent Maker task-definition files: one
 * `task.json` per task under `AI-Playground/agent-maker/<slug>/`, plus an
 * `index.json` at the collection root. A task is an independent, frozen-at-
 * creation specification for an agent job — model config, capabilities,
 * optional instructions, and an ordered list of steps.
 *
 * Task *runs* are normal `AgentSessionRecord`s tagged with `origin:
 * 'agentMaker'` (see `agentSessionIpc.ts`), so they ride the existing
 * agent-session persistence and open in Agent Mode verbatim.
 */

export const AgentTaskSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  /** Filesystem-safe slug derived from the name; collision-suffixed. */
  slug: z.string(),
  steps: z.array(z.string()),
  modelConfig: AgentModeModelConfigSchema,
  capabilities: z.array(z.string()),
  instructions: z.string().optional(),
  contextSize: z.number().optional(),
  maxNewTokens: z.number().optional(),
  unsandboxed: z.boolean().optional(),
  /** Per-model llama-server flags (Qwen3.8's `--spec-type draft-mtp`, etc), frozen at task creation. */
  llamaCppArgs: z.string().optional(),
  /** Raw model repo id (with `/`) for file-path resolution; `modelConfig.model` is the served format (`---`). */
  modelRepoId: z.string().optional(),
  /** v1: always 'Agent' — for entering Agent Mode and loading settings. */
  presetName: z.literal('Agent'),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type AgentTask = z.infer<typeof AgentTaskSchema>

export const AgentMakerIndexEntrySchema = z.object({
  id: z.string(),
  slug: z.string(),
  updatedAt: z.number(),
})
export type AgentMakerIndexEntry = z.infer<typeof AgentMakerIndexEntrySchema>

export const AgentMakerIndexFileSchema = z.object({
  schemaVersion: z.literal(1),
  tasks: z.array(AgentMakerIndexEntrySchema),
})
export type AgentMakerIndexFile = z.infer<typeof AgentMakerIndexFileSchema>

export type AgentMakerBootstrap = { status: 'empty' } | { status: 'ok'; tasks: AgentTask[] }

/** Result of minting a run: the session id and its fresh workspace directory. */
export type AgentRunStartResult = {
  success: true
  sessionId: string
  workspaceDir: string
}
