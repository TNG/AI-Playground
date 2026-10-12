import type { AgentModeModelConfig, AgentModeTurnConfig } from '@/types/agentIpc'
import type { AgentTaskModel } from '@/types/agentMakerIpc'
import { npuPromptLen, type InferenceDefaults } from '@/types/shared'
import { openAiApiBase } from '@/lib/inferenceApiBase'
import { ovmsMtpRequestFields } from '@/lib/ovmsMtp'
import {
  chatTemplateKwargs,
  recommendedReasoningEffort,
  resolveSampling,
  toRequestBody,
} from '@/lib/samplingDefaults'

/**
 * Turns an Agent Maker task's model choices into what an agent turn needs, from
 * the live catalog and services — independent of the Agent preset's settings.
 * Store-free so it is unit-testable; the agentMaker store supplies the snapshot.
 */

export const DEFAULT_TASK_CONTEXT_SIZE = 32768
const DEFAULT_TEMPERATURE = 0.7

export type TaskCatalogModel = {
  name: string
  type: string
  supportsVision?: boolean
  supportsReasoning?: boolean
  supportsThinkingToggle?: boolean
  maxContextSize?: number
  inferenceDefaults?: InferenceDefaults
  llamaCppArgs?: string
}

export type TaskServiceInfo = {
  serviceName: string
  baseUrl?: string
  devices: { id: string; name: string; selected?: boolean }[]
  ovmsMtpArmed?: boolean
}

export type TaskCloudProvider = {
  id: string
  name: string
  baseUrl: string
  authStyle?: string
  modelCapabilities?: Record<
    string,
    { supportsVision?: boolean; reasoningAdvertised?: boolean; contextLength?: number }
  >
}

export type TaskEmbeddingModel = { name: string; type: string; downloaded: boolean }

export type TaskModelEnvironment = {
  catalog: TaskCatalogModel[]
  embeddingModels?: TaskEmbeddingModel[]
  services: TaskServiceInfo[]
  cloudProviders: TaskCloudProvider[]
  cloudProxyUrl?: string
}

export type ResolvedTaskModel = {
  modelConfig: AgentModeModelConfig
  readiness?: AgentModeTurnConfig['readiness']
  planningThinkingOnly: boolean
}

export const LOCAL_TASK_SERVICES = {
  llamaCPP: 'llamacpp-backend',
  openVINO: 'openvino-backend',
} as const

/** The catalog entry a local task model refers to, if it still exists. */
export function taskCatalogEntry(
  model: AgentTaskModel,
  catalog: TaskCatalogModel[],
): TaskCatalogModel | undefined {
  return catalog.find((entry) => entry.type === model.backend && entry.name === model.model)
}

/** Whether a task model offers the thinking switch (the form shows it only then). */
export function taskModelSupportsThinkingToggle(
  model: AgentTaskModel,
  catalog: TaskCatalogModel[],
): boolean {
  return (
    model.backend !== 'cloud' && taskCatalogEntry(model, catalog)?.supportsThinkingToggle === true
  )
}

/** The context size the task asks a local backend for, bounded by the model's ceiling. */
export function taskContextSize(model: AgentTaskModel, entry?: TaskCatalogModel): number {
  const requested = model.contextSize ?? DEFAULT_TASK_CONTEXT_SIZE
  return entry?.maxContextSize ? Math.min(requested, entry.maxContextSize) : requested
}

export function normalizeCloudBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

export type ResolvedTaskEmbedding = {
  embeddingModel?: string
  embeddingBackend?: 'llamaCPP' | 'openVINO'
  /** Set only once the file is on disk, so a missing model still prompts on first use. */
  readinessEmbeddingModel?: string
}

/** The embedding model a task's `rag` capability runs on; empty when rag is off or unset. */
export function resolveTaskEmbedding(
  model: AgentTaskModel,
  capabilities: readonly string[],
  env: Pick<TaskModelEnvironment, 'embeddingModels'>,
): ResolvedTaskEmbedding {
  if (!capabilities.includes('rag') || !model.embeddingModel) return {}
  const embeddingBackend = model.embeddingBackend ?? 'llamaCPP'
  const downloaded = env.embeddingModels?.some(
    (entry) =>
      entry.name === model.embeddingModel && entry.type === embeddingBackend && entry.downloaded,
  )
  // The embedding server rides the LLM's readiness only when both share a backend.
  const sameBackend = model.backend === embeddingBackend
  return {
    embeddingModel: model.embeddingModel,
    embeddingBackend,
    ...(downloaded && sameBackend ? { readinessEmbeddingModel: model.embeddingModel } : {}),
  }
}

export function resolveTaskModel(
  model: AgentTaskModel,
  env: TaskModelEnvironment,
): ResolvedTaskModel {
  return model.backend === 'cloud' ? resolveCloud(model, env) : resolveLocal(model, env)
}

function resolveCloud(model: AgentTaskModel, env: TaskModelEnvironment): ResolvedTaskModel {
  const provider = env.cloudProviders.find((entry) => entry.id === model.providerId)
  const upstreamBaseUrl = provider ? normalizeCloudBaseUrl(provider.baseUrl) : ''
  if (!provider || !upstreamBaseUrl) {
    throw new Error(
      `The task's cloud provider is no longer configured. Edit the task and pick a provider.`,
    )
  }
  if (!env.cloudProxyUrl) throw new Error('The cloud proxy is not available.')
  const caps = provider.modelCapabilities?.[model.model]
  return {
    modelConfig: {
      source: 'cloud',
      model: model.model,
      proxyBaseUrl: env.cloudProxyUrl,
      upstreamBaseUrl,
      providerId: provider.id,
      authStyle: provider.authStyle ?? 'bearer',
      supportsVision: caps?.supportsVision ?? true,
      reasoningAdvertised: caps?.reasoningAdvertised ?? false,
      contextWindow: caps?.contextLength,
    },
    planningThinkingOnly: false,
  }
}

function resolveLocal(model: AgentTaskModel, env: TaskModelEnvironment): ResolvedTaskModel {
  const backend = model.backend as 'llamaCPP' | 'openVINO'
  const entry = taskCatalogEntry(model, env.catalog)
  if (!entry) {
    throw new Error(
      `The task's model "${model.model}" is no longer available. Edit the task and pick a model.`,
    )
  }
  const serviceName = LOCAL_TASK_SERVICES[backend]
  const service = env.services.find((info) => info.serviceName === serviceName)
  if (!service?.baseUrl) {
    throw new Error(`The ${backend} backend is not installed. Install it in the setup wizard.`)
  }
  const device = service.devices.find((d) => d.selected)
  const onNpu = backend === 'openVINO' && !!device?.id.includes('NPU')
  const contextSize = taskContextSize(model, entry)
  // OpenVINO on GPU sizes its KV cache at runtime; NPU compiles a capped graph.
  const contextWindow =
    backend === 'openVINO'
      ? onNpu
        ? npuPromptLen(contextSize)
        : (entry.maxContextSize ?? contextSize)
      : contextSize

  const supportsThinkingToggle = entry.supportsThinkingToggle === true
  const thinkingEnabled = model.thinkingEnabled ?? true
  const thinkingActive = supportsThinkingToggle ? thinkingEnabled : entry.supportsReasoning === true
  const sampling = resolveSampling(entry.inferenceDefaults, thinkingActive)
  const samplingParams: Record<string, unknown> = {
    ...toRequestBody(sampling, backend),
    ...(backend === 'openVINO' ? ovmsMtpRequestFields(service.ovmsMtpArmed === true) : {}),
    temperature: sampling.temperature ?? DEFAULT_TEMPERATURE,
  }
  const kwargs = chatTemplateKwargs({
    supportsThinkingToggle,
    thinkingEnabled,
    thinkingActive,
    reasoningEffort: recommendedReasoningEffort(entry.inferenceDefaults),
  })
  if (Object.keys(kwargs).length > 0) samplingParams.chat_template_kwargs = kwargs

  return {
    modelConfig: {
      source: 'local',
      model: model.model.split('/').join('---'),
      backend,
      device: device?.id,
      deviceName: device?.name,
      baseUrl: openAiApiBase(service.baseUrl),
      contextWindow,
      supportsVision: entry.supportsVision === true,
      samplingParams,
    },
    readiness: {
      serviceName,
      llmModelName: model.model,
      contextSize,
      modelArgs: backend === 'llamaCPP' ? entry.llamaCppArgs : undefined,
    },
    planningThinkingOnly:
      supportsThinkingToggle && thinkingEnabled && (model.planningThinkingOnly ?? true),
  }
}
