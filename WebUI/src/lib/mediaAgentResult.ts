import type { MediaAgentRunResult } from '@/types/chatIpc'

/** Comfy-shaped media entry produced by an inner specialist tool. */
export type CondensedMediaEntry = {
  id: string
  type: 'image' | 'video' | 'model3d'
  imageUrl?: string
  videoUrl?: string
  model3dUrl?: string
  mode: string
  settings: Record<string, unknown>
}

export type CondensedMediaAgentResult = {
  images: CondensedMediaEntry[]
  steps: string[]
  summary: string
  success?: boolean
  message?: string
  /** A step's model download was declined by the user; the message says not to retry. */
  declined?: true
}

const MEDIA_TYPES = new Set(['image', 'video', 'model3d'])

/** Media entries out of one inner tool output (comfy result shape). */
export function mediaEntriesOf(output: unknown): CondensedMediaEntry[] {
  if (typeof output !== 'object' || output === null) return []
  const record = output as Record<string, unknown>
  if (record.type === 'json' && record.value !== undefined && record.value !== output) {
    return mediaEntriesOf(record.value)
  }
  if (!Array.isArray(record.images) && record.output !== undefined && record.output !== output) {
    return mediaEntriesOf(record.output)
  }
  const images = record.images
  if (!Array.isArray(images)) return []
  return images.filter((item): item is CondensedMediaEntry => {
    if (typeof item !== 'object' || item === null) return false
    const media = item as Record<string, unknown>
    if (typeof media.id !== 'string' || !MEDIA_TYPES.has(String(media.type))) return false
    const url = media.imageUrl ?? media.videoUrl ?? media.model3dUrl
    return typeof url === 'string' && url !== ''
  })
}

export function describeMediaAgentStep(step: {
  toolName: string
  input: unknown
  output: unknown
}): string {
  const record = (step.input ?? {}) as Record<string, unknown>
  const workflow = typeof record.workflow === 'string' ? record.workflow : 'default workflow'
  const output = (step.output ?? {}) as Record<string, unknown>
  if (output.success === false) {
    return `${step.toolName} (${workflow}): failed — ${output.message ?? 'unknown error'}`
  }
  const produced = mediaEntriesOf(step.output)
  const kinds = produced.map((item) => item.type).join(', ')
  return `${step.toolName} (${workflow}): produced ${produced.length || 'no'} ${kinds || 'media'}`
}

/** Condenses the nested loop's raw steps into the parent tool's result shape. */
export function condenseMediaAgentRun(result: MediaAgentRunResult): CondensedMediaAgentResult {
  const images = result.steps.flatMap((step) => {
    const prompt = (step.input as { prompt?: unknown } | null)?.prompt
    return mediaEntriesOf(step.output).map((entry) =>
      typeof prompt === 'string' && prompt
        ? { ...entry, settings: { ...entry.settings, prompt } }
        : entry,
    )
  })
  const failures = result.steps
    .map(
      (step) =>
        (step.output as { success?: boolean; message?: string; declined?: boolean } | null) ?? {},
    )
    .filter((output) => output.success === false)
  const declined = failures.find((output) => output.declined === true)
  const summary =
    result.text.trim() || (images.length > 0 ? 'Media generated.' : 'No media generated.')
  const steps = result.steps.map(describeMediaAgentStep)
  const declinedFields = declined ? { declined: true as const, message: declined.message } : {}
  if (images.length === 0) {
    return {
      images: [],
      steps,
      summary,
      success: false,
      message: failures.at(-1)?.message ?? summary,
      ...declinedFields,
    }
  }
  return { images, steps, summary, ...declinedFields }
}

/** Drop bulky per-item settings before the result enters the parent model context. */
export function slimCondensedMedia(result: CondensedMediaAgentResult): Record<string, unknown> {
  const slim: Record<string, unknown> = {
    summary: result.summary,
    steps: result.steps,
    images: result.images.map((item) => {
      const entry: Record<string, unknown> = { id: item.id, type: item.type }
      if (item.imageUrl) entry.imageUrl = item.imageUrl
      if (item.videoUrl) entry.videoUrl = item.videoUrl
      if (item.model3dUrl) entry.model3dUrl = item.model3dUrl
      if (typeof item.settings?.prompt === 'string') {
        entry.settings = { prompt: item.settings.prompt }
      }
      return entry
    }),
  }
  if (result.success !== undefined) slim.success = result.success
  if (result.message !== undefined) slim.message = result.message
  if (result.declined) slim.declined = true
  return slim
}
