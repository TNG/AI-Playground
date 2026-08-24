import z from 'zod'

const SamplingParamsSchema = z.record(z.string(), z.unknown())

const LocalModelConfigSchema = z.object({
  source: z.literal('local'),
  model: z.string().min(1),
  baseUrl: z.string().min(1),
  backend: z.enum(['llamaCPP', 'openVINO']).optional(),
  device: z.string().optional(),
  deviceName: z.string().optional(),
  contextWindow: z.number().optional(),
  supportsVision: z.boolean().optional(),
  samplingParams: SamplingParamsSchema.optional(),
})

const CloudModelConfigSchema = z.object({
  source: z.literal('cloud'),
  model: z.string().min(1),
  proxyBaseUrl: z.string().min(1),
  upstreamBaseUrl: z.string().min(1),
  providerId: z.string().min(1),
  authStyle: z.string().min(1),
  contextWindow: z.number().optional(),
  supportsVision: z.boolean().optional(),
})

export const AgentModeModelConfigSchema = z.discriminatedUnion('source', [
  LocalModelConfigSchema,
  CloudModelConfigSchema,
])

export const AgentToolSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  workspacePathInputs: z.array(z.string()).optional(),
})

export const AgentModeTurnConfigSchema = z.object({
  sessionId: z.string().min(1),
  workspaceDir: z.string().min(1),
  modelConfig: AgentModeModelConfigSchema,
  toolSpecs: z.array(AgentToolSpecSchema).optional(),
  instructions: z.string().optional(),
  /** The agent preset this turn was held with, for labelling its trace. */
  presetName: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  mcpServerIds: z.array(z.string()).optional(),
  unsandboxed: z.boolean().optional(),
  planningThinkingOnly: z.boolean().optional(),
})

export type AgentModeModelConfig = z.infer<typeof AgentModeModelConfigSchema>
export type AgentToolSpec = z.infer<typeof AgentToolSpecSchema>
export type AgentModeTurnConfig = z.infer<typeof AgentModeTurnConfigSchema>

export type AgentCapabilityInfo = {
  id: string
  label: string
  summary: string
  requires: string[]
  commands: { command: string; description: string }[]
  unavailableReason?: string
}

export type GameLibraryEntry = {
  id: string
  name: string
  description: string
  entry: string
  icon?: string
  published: boolean
  createdAt: number
  updatedAt: number
  dir: string
  entryPath: string
  iconPath?: string
  iconUrl?: string
}
