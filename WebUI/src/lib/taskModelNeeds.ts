import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import { isToolEnabled } from '@/lib/builtinToolEnablement'
import { isWorkflowEnabled, resolveDefaultWorkflow } from '@/lib/mediaToolSettings'
import { applyVariant, type Preset } from '@/lib/presetSchemas'

/** A model a Task may download, in the shape the model check and the download dialog take. */
export type ModelRef = {
  repo_id: string
  type: string
  backend: 'comfyui' | 'llama_cpp' | 'openvino'
  additionalLicenseLink?: string
}

export type MediaTool = 'comfyUI' | 'comfyUiImageEdit'

export type MediaType = 'image' | 'video' | 'model3d'

export type SpeechTool = 'synthesizeTextToSpeech' | 'transcribeAudio'

export type TaskModelNeed =
  | { kind: 'chat'; models: ModelRef[] }
  | { kind: 'embedding'; models: ModelRef[] }
  | {
      kind: 'workflow'
      tool: MediaTool
      mediaType: MediaType
      workflow: string
      models: ModelRef[]
    }
  | { kind: 'speech'; tool: SpeechTool; models: ModelRef[] }

/** `certain`: a run will load these. `maybe`: a run loads these only if the agent asks for them. */
export type TaskModelNeeds = { certain: TaskModelNeed[]; maybe: TaskModelNeed[] }

export type TaskModelNeedsInput = {
  template: AgentSessionSettings
  /** The local chat model, with its vision projector when needed; omitted when not checked. */
  chat?: ModelRef[]
  /** The embedding model the template resolves to, if any. */
  embedding?: { backend: 'llamaCPP' | 'openVINO'; model: string }
  /** The ComfyUI presets the media tools may pick from. */
  workflows: readonly Preset[]
  /** The model each speech tool's engine loads; none for an external engine. */
  speech: Partial<Record<SpeechTool, ModelRef>>
}

const AIPG_BACKEND = { llamaCPP: 'llama_cpp', openVINO: 'openvino' } as const

const MEDIA_TOOL_CATEGORIES: Record<MediaTool, string[]> = {
  comfyUI: ['create-images', 'create-videos'],
  comfyUiImageEdit: ['edit-images'],
}

const MEDIA_TYPES: MediaType[] = ['image', 'video', 'model3d']

const SPEECH_TOOLS: SpeechTool[] = ['synthesizeTextToSpeech', 'transcribeAudio']

export function taskModelNeeds(input: TaskModelNeedsInput): TaskModelNeeds {
  const { template, chat, embedding } = input
  const capabilities = template.capabilities ?? []
  const certain: TaskModelNeed[] = []
  if (chat && chat.length > 0) certain.push({ kind: 'chat', models: chat })
  if (capabilities.includes('rag') && embedding) {
    certain.push({
      kind: 'embedding',
      models: [
        { repo_id: embedding.model, type: 'embedding', backend: AIPG_BACKEND[embedding.backend] },
      ],
    })
  }
  const maybe = capabilities.includes('media') ? [...mediaNeeds(input), ...speechNeeds(input)] : []
  return { certain, maybe }
}

function mediaNeeds({ template, workflows }: TaskModelNeedsInput): TaskModelNeed[] {
  const toolEnablement = template.builtinToolEnablement ?? {}
  const workflowEnablement = template.builtinToolPresetEnablement ?? {}
  const defaults = template.builtinToolDefaultPresets ?? {}
  const delegated = template.toolDelegationEnabled ?? true
  const needs: TaskModelNeed[] = []
  for (const tool of Object.keys(MEDIA_TOOL_CATEGORIES) as MediaTool[]) {
    if (!isToolEnabled(toolEnablement, tool)) continue
    const candidates = workflows.filter(
      (preset) =>
        preset.type === 'comfy' &&
        preset.backend === 'comfyui' &&
        !!preset.toolCategory &&
        MEDIA_TOOL_CATEGORIES[tool].includes(preset.toolCategory) &&
        isWorkflowEnabled(workflowEnablement, preset.name),
    )
    for (const mediaType of MEDIA_TYPES) {
      // Without delegation the agent's generateImage tool offers no video workflows.
      if (!delegated && tool === 'comfyUI' && mediaType === 'video') continue
      const inSlot = candidates.filter((preset) => (preset.mediaType ?? 'image') === mediaType)
      const name = resolveDefaultWorkflow(
        defaults,
        `${tool}:${mediaType}`,
        inSlot.map((preset) => preset.name),
      )
      const preset = inSlot.find((entry) => entry.name === name)
      if (!preset) continue
      const models = workflowModels(preset)
      if (models.length > 0)
        needs.push({ kind: 'workflow', tool, mediaType, workflow: preset.name, models })
    }
  }
  return needs
}

function speechNeeds({ template, speech }: TaskModelNeedsInput): TaskModelNeed[] {
  const toolEnablement = template.builtinToolEnablement ?? {}
  return SPEECH_TOOLS.flatMap((tool) => {
    const model = speech[tool]
    if (!model || !isToolEnabled(toolEnablement, tool)) return []
    return [{ kind: 'speech' as const, tool, models: [model] }]
  })
}

/** The models of the variant an agent's media run picks: the Fast one, else the first. */
function workflowModels(preset: Preset): ModelRef[] {
  const variants = preset.variants ?? []
  const variant = variants.find((entry) => entry.name.toLowerCase().includes('fast')) ?? variants[0]
  const resolved = variant ? applyVariant(preset, variant.name) : preset
  return (resolved.requiredModels ?? []).map((model) => ({
    repo_id: model.model,
    type: model.type,
    backend: 'comfyui',
    ...(model.additionalLicenceLink ? { additionalLicenseLink: model.additionalLicenceLink } : {}),
  }))
}

export type MissingModel = ModelRef & { size?: string }

type WithMissing<T> = T extends TaskModelNeed
  ? Omit<T, 'models'> & { models: MissingModel[] }
  : never

/** A need narrowed to its models that are not on disk. */
export type TaskModelWarning = WithMissing<TaskModelNeed>

export type TaskModelWarnings = { certain: TaskModelWarning[]; maybe: TaskModelWarning[] }

export function modelKey(model: ModelRef): string {
  return `${model.backend}|${model.type}|${model.repo_id}`
}

/** The needs narrowed to the models in `missing`, each with its size when known. */
export function taskModelWarnings(
  needs: TaskModelNeeds,
  missing: ReadonlySet<string>,
  sizes: Readonly<Record<string, string>>,
): TaskModelWarnings {
  const narrow = (list: TaskModelNeed[]): TaskModelWarning[] =>
    list.flatMap((need) => {
      const models = need.models
        .filter((model) => missing.has(modelKey(model)))
        .map((model) => {
          const size = sizes[modelKey(model)]
          return size ? { ...model, size } : model
        })
      return models.length > 0 ? [{ ...need, models } as TaskModelWarning] : []
    })
  return { certain: narrow(needs.certain), maybe: narrow(needs.maybe) }
}

/** The warnings' models once each, without their sizes, for one download request. */
export function modelsToDownload(warnings: readonly TaskModelWarning[]): ModelRef[] {
  const unique = new Map<string, ModelRef>()
  for (const { models } of warnings) {
    for (const { size: _size, ...model } of models) unique.set(modelKey(model), model)
  }
  return [...unique.values()]
}
