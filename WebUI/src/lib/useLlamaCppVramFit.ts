import { computed, ref, watch } from 'vue'
import type { LlamaCppVramInputs } from '../../electron/llamaCppVramInputs'
import { useComputeMetrics } from '@/assets/js/store/computeMetrics'
import { useTextInference } from '@/assets/js/store/textInference'
import {
  emptyCardBudgetBytes,
  estimateLlamaCppVram,
  mibToBytes,
  vramFitLevel,
  type VramFitLevel,
} from '@/lib/vram'

/** The context size every model is also shown at, so two models compare on one scale. */
export const REFERENCE_CONTEXT_TOKENS = 8192

export type VramFitPoint = {
  contextTokens: number
  /** Weights plus a multimodal projector — everything that does not scale with context. */
  baseBytes: number
  /** KV cache, recurrent states, compute buffers and MTP draft. */
  contextBytes: number
  totalBytes: number
  level: VramFitLevel
}

export type VramFitSummary = {
  level: VramFitLevel
  /** Card size, and what is left of it right now. */
  totalBytes: number
  availableBytes: number
  /** The budget the verdict is against: an empty card minus the driver's share. */
  usableBytes: number
  current: VramFitPoint
  reference: VramFitPoint
  max: VramFitPoint
}

// One IPC per model for the whole app: the chip is mounted on both the status bar
// and the model picker, and a GGUF header does not change while the app runs.
const inputsCache = new Map<string, LlamaCppVramInputs | null>()

async function loadInputs(modelName: string): Promise<LlamaCppVramInputs | null> {
  const cached = inputsCache.get(modelName)
  if (cached) return cached
  let inputs: LlamaCppVramInputs | null = null
  try {
    inputs = await window.electronAPI.getLlamaCppVramInputs(modelName)
  } catch {
    inputs = null
  }
  // A miss is not cached: the same model is readable once its download finishes.
  if (inputs) inputsCache.set(modelName, inputs)
  return inputs
}

/**
 * How the active llama.cpp model sits in the card's memory, at the current, a
 * reference and the model's maximum context. Null whenever the answer would be a
 * guess: another backend, a model that is not on disk, or no GPU sample yet.
 */
export function useLlamaCppVramFit() {
  const textInference = useTextInference()
  const computeMetrics = useComputeMetrics()
  const inputs = ref<LlamaCppVramInputs | null>(null)

  const model = computed(() =>
    textInference.backend === 'llamaCPP'
      ? textInference.llmModels.find((m) => m.active && m.type === 'llamaCPP')
      : undefined,
  )

  // Keyed on the downloaded model, so a model that is still downloading is
  // re-read once its files are there.
  const readableModel = computed(() =>
    model.value?.downloaded === true ? model.value.name : undefined,
  )

  watch(
    readableModel,
    async (name) => {
      if (!name) {
        inputs.value = null
        return
      }
      const loaded = await loadInputs(name)
      // The selection may have moved on while the IPC was in flight.
      if (readableModel.value === name) inputs.value = loaded
    },
    { immediate: true },
  )

  const summary = computed<VramFitSummary | null>(() => {
    const gpu = computeMetrics.primaryGpu
    const source = inputs.value
    if (!source || !gpu?.memTotalMiB) return null

    const totalBytes = mibToBytes(gpu.memTotalMiB)
    const usableBytes = emptyCardBudgetBytes(totalBytes)
    const availableBytes =
      gpu.memUsedMiB != null ? Math.max(0, totalBytes - mibToBytes(gpu.memUsedMiB)) : totalBytes
    // The catalog asks for MTP off the model's own draft head on some models,
    // which costs KV and a slice of the weights on top of everything else.
    const mtp = (model.value?.llamaCppArgs ?? '').includes('draft-mtp')

    const pointAt = (contextTokens: number): VramFitPoint => {
      const estimate = estimateLlamaCppVram({
        arch: source.arch,
        weightsBytes: source.weightsBytes,
        mmprojBytes: source.mmprojBytes,
        contextSize: contextTokens,
        flashAttention: true,
        nParallel: 1,
        mtp,
      })
      return {
        contextTokens,
        baseBytes: estimate.weightsBytes,
        contextBytes: estimate.totalBytes - estimate.weightsBytes,
        totalBytes: estimate.totalBytes,
        level: vramFitLevel(estimate.totalBytes, usableBytes),
      }
    }

    const current = pointAt(textInference.contextSize)
    return {
      level: current.level,
      totalBytes,
      availableBytes,
      usableBytes,
      current,
      reference: pointAt(REFERENCE_CONTEXT_TOKENS),
      max: pointAt(model.value?.maxContextSize ?? textInference.contextSize),
    }
  })

  return { summary }
}
