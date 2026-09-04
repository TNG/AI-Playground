import { z } from 'zod'
import { ComfyInputSchema, ComfyUiPresetSchema } from '@/lib/presetSchemas'

/**
 * The `artifact:run` request as it crosses IPC — the renderer ships a fully
 * resolved run (step 5: preset entry, params, dynamic inputs, pre-registered
 * item stubs). Main re-validates it: the payload is data from another process,
 * and a preset that fails its schema here must fail the run, not the engine.
 */
export const ArtifactRunRequestSchema = z.object({
  runId: z.string().min(1),
  mode: z.enum(['imageGen', 'imageEdit', 'video']),
  preset: ComfyUiPresetSchema,
  params: z.object({
    prompt: z.string(),
    negativePrompt: z.string(),
    seed: z.number(),
    inferenceSteps: z.number(),
    width: z.number(),
    height: z.number(),
    batchSize: z.number().int().min(1),
  }),
  inputs: z.array(ComfyInputSchema.extend({ current: z.unknown() })),
  /** Item stubs the renderer registered so slots show immediately; the runner owns settlement. */
  items: z.array(z.object({ id: z.string().min(1) }).passthrough()).optional(),
  source: z.string().optional(),
  modelsConsented: z.boolean().optional(),
  showPreview: z.boolean().optional(),
  safetyCheck: z.boolean().optional(),
  keepModelsLoaded: z.boolean().optional(),
})

export type ArtifactRunRequest = z.infer<typeof ArtifactRunRequestSchema>
