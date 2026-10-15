import type { PauseReason } from '@/types/kernelEvents'

const NAMED_MODELS = 3
const MODEL_FILE_EXTENSION = /\.(gguf|safetensors|bin|onnx|pth?|ckpt|sft)$/i

function modelLabel(model: unknown): string | undefined {
  const { repo_id: repoId, size } = (model ?? {}) as { repo_id?: unknown; size?: unknown }
  if (typeof repoId !== 'string' || !repoId) return undefined
  const name = repoId.split('/').filter(Boolean).at(-1)?.replace(MODEL_FILE_EXTENSION, '') ?? repoId
  return typeof size === 'string' && size ? `${name} (${size})` : name
}

/** "model-a, model-b +2": the models a download prompt asks for, named for a status line. */
export function downloadPauseReason(models: unknown[]): PauseReason {
  const labels = models.map(modelLabel).filter((label): label is string => Boolean(label))
  const named = labels.slice(0, NAMED_MODELS).join(', ')
  const more = labels.length > NAMED_MODELS ? ` +${labels.length - NAMED_MODELS}` : ''
  return named ? { kind: 'download', summary: named + more } : { kind: 'download' }
}
