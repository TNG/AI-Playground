import { computed, reactive, watchEffect, type Ref } from 'vue'
import type { LlamaCppVramInputs } from '../../electron/llamaCppVramInputs'
import { useComputeMetrics } from '@/assets/js/store/computeMetrics'
import { useTextInference, type LlmModel } from '@/assets/js/store/textInference'
import {
  emptyCardBudgetBytes,
  estimateLlamaCppVram,
  mibToBytes,
  vramFitLevel,
  type VramFitLevel,
} from '@/lib/vram'

/** The context size every model is also shown at, so two models compare on one scale. */
export const REFERENCE_CONTEXT_TOKENS = 8192

// A header for a model that is not downloaded is a range request to HuggingFace,
// and the picker asks for every model it lists at once.
const MAX_PARALLEL_READS = 3

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

// One read per model for the whole app: the chip is mounted on the status bar, on
// the picker's trigger and on every row of its list, and a GGUF header does not
// change while the app runs. Keyed by where the header came from, so a model that
// finishes downloading is read again from the file itself.
const inputsCache = reactive(new Map<string, LlamaCppVramInputs | null>())
const inFlight = new Set<string>()
let running = 0
const waiting: (() => void)[] = []

function acquire(): Promise<void> {
  if (running < MAX_PARALLEL_READS) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    waiting.push(() => {
      running += 1
      resolve()
    }),
  )
}

function release(): void {
  running -= 1
  waiting.shift()?.()
}

const cacheKey = (model: LlmModel) => `${model.downloaded ? 'local' : 'remote'}:${model.name}`

function requestInputs(model: LlmModel): void {
  const key = cacheKey(model)
  if (inputsCache.has(key) || inFlight.has(key)) return
  inFlight.add(key)
  void (async () => {
    await acquire()
    try {
      inputsCache.set(key, await window.electronAPI.getLlamaCppVramInputs(model.name, model.mmproj))
    } catch {
      inputsCache.set(key, null)
    } finally {
      release()
      inFlight.delete(key)
    }
  })()
}

/**
 * How a llama.cpp model sits in the card's memory, at the current, a reference
 * and the model's maximum context. Defaults to the active model; pass one to ask
 * about a model the user is only looking at. Null whenever the answer would be a
 * guess: another backend, a header that could not be read, or no GPU sample yet.
 *
 * A model that is not on disk is read from its header on HuggingFace, which is
 * the moment the verdict is worth the most: before paying for the download.
 */
export function useLlamaCppVramFit(target?: Ref<LlmModel | undefined>) {
  const textInference = useTextInference()
  const computeMetrics = useComputeMetrics()

  const model = computed(() => {
    if (target) return target.value?.type === 'llamaCPP' ? target.value : undefined
    if (textInference.backend !== 'llamaCPP') return undefined
    return textInference.llmModels.find((m) => m.active && m.type === 'llamaCPP')
  })

  watchEffect(() => {
    if (model.value) requestInputs(model.value)
  })

  const inputs = computed(() => {
    const current = model.value
    return current ? (inputsCache.get(cacheKey(current)) ?? null) : null
  })

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
    const maxContext = model.value?.maxContextSize

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

    // A model narrower than the setting never gets the whole window.
    const current = pointAt(Math.min(textInference.contextSize, maxContext ?? Infinity))
    return {
      level: current.level,
      totalBytes,
      availableBytes,
      usableBytes,
      current,
      reference: pointAt(REFERENCE_CONTEXT_TOKENS),
      max: pointAt(maxContext ?? textInference.contextSize),
    }
  })

  return { summary }
}
