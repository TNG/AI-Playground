import { z } from 'zod'

/**
 * Wire shapes for the kernel-owned Agent Maker task-definition files: one
 * `task.json` per task under `AI-Playground/agent-maker/<slug>/`, plus an
 * `index.json` at the collection root. A task is an independent specification
 * for an agent job — its own model settings, capabilities, optional
 * instructions, and an ordered list of steps — configured separately from the
 * Agent preset's settings.
 *
 * Task *runs* are normal `AgentSessionRecord`s tagged with `origin:
 * 'agentMaker'` (see `agentSessionIpc.ts`), so they ride the existing
 * agent-session persistence and open in Agent Mode verbatim.
 */

/**
 * What the task runs on. Stored as choices, not as a resolved endpoint: URLs,
 * ports, sampling and launch flags are looked up from the live catalog and
 * services when a turn starts (`src/lib/agentTaskModel.ts`).
 */
export const AgentTaskModelSchema = z.object({
  backend: z.enum(['llamaCPP', 'openVINO', 'cloud']),
  /** Catalog repo id for local backends, the provider's model id for cloud. */
  model: z.string().min(1),
  /** Cloud provider id (cloud only). */
  providerId: z.string().optional(),
  contextSize: z.number().int().positive().optional(),
  thinkingEnabled: z.boolean().optional(),
  planningThinkingOnly: z.boolean().optional(),
})
export type AgentTaskModel = z.infer<typeof AgentTaskModelSchema>

export const AgentTaskSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string(),
  name: z.string(),
  /** Filesystem-safe slug derived from the name; collision-suffixed. */
  slug: z.string(),
  steps: z.array(z.string()),
  model: AgentTaskModelSchema,
  capabilities: z.array(z.string()),
  instructions: z.string().optional(),
  unsandboxed: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type AgentTask = z.infer<typeof AgentTaskSchema>

/** Upgrade a v1 task (a frozen `modelConfig` snapshot) to the v2 model choices. */
export function migrateAgentTaskDoc(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const doc = raw as Record<string, unknown>
  if (doc.schemaVersion !== 1) return raw
  const config = (doc.modelConfig ?? {}) as Record<string, unknown>
  const cloud = config.source === 'cloud'
  const {
    modelConfig: _modelConfig,
    modelRepoId,
    contextSize,
    maxNewTokens: _maxNewTokens,
    llamaCppArgs: _llamaCppArgs,
    presetName: _presetName,
    ...rest
  } = doc
  return {
    ...rest,
    schemaVersion: 2,
    model: {
      backend: cloud ? 'cloud' : config.backend === 'openVINO' ? 'openVINO' : 'llamaCPP',
      model: cloud ? config.model : (modelRepoId ?? config.model),
      providerId: cloud ? config.providerId : undefined,
      contextSize: cloud ? undefined : contextSize,
    },
  }
}

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
