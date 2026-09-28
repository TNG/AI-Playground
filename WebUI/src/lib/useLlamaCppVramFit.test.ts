import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, reactive } from 'vue'
import type { LlamaCppVramInputs } from '../../electron/llamaCppVramInputs'
import type { LlmModel } from '@/assets/js/store/textInference'
import { GIB, MIB } from '@/lib/vram'

const textInference = reactive({
  backend: 'llamaCPP' as string,
  contextSize: 8192,
  llmModels: [] as Record<string, unknown>[],
})

const computeMetrics = reactive({
  primaryGpu: undefined as { memTotalMiB?: number; memUsedMiB?: number } | undefined,
})

vi.mock('@/assets/js/store/textInference', () => ({ useTextInference: () => textInference }))
vi.mock('@/assets/js/store/computeMetrics', () => ({ useComputeMetrics: () => computeMetrics }))

const { useLlamaCppVramFit } = await import('./useLlamaCppVramFit.ts')

// A 7B-ish dense model: 32 layers, 4096 wide, 8 KV heads.
const inputs: LlamaCppVramInputs = {
  arch: {
    architecture: 'llama',
    blockCount: 32,
    embeddingLength: 4096,
    headCount: 32,
    headCountKv: 8,
    vocabSize: 128256,
  },
  weightsBytes: 4 * GIB,
  mmprojBytes: 0,
}

const getLlamaCppVramInputs = vi.fn(async (_name: string, _mmproj?: string) => inputs)

beforeEach(async () => {
  getLlamaCppVramInputs.mockClear()
  // The composable is the renderer's only caller of this IPC.
  ;(globalThis as unknown as { window: unknown }).window = {
    electronAPI: { getLlamaCppVramInputs },
  }
  textInference.backend = 'llamaCPP'
  textInference.contextSize = 8192
  textInference.llmModels = [
    { name: 'owner/repo/model.gguf', type: 'llamaCPP', active: true, downloaded: true },
  ]
  computeMetrics.primaryGpu = { memTotalMiB: 16 * 1024, memUsedMiB: 2 * 1024 }
})

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('useLlamaCppVramFit', () => {
  it('reports the fit at the current, reference and maximum context', async () => {
    textInference.llmModels[0].maxContextSize = 131072
    const { summary } = useLlamaCppVramFit()
    await settle()

    const fit = summary.value
    expect(fit).not.toBeNull()
    expect(fit?.totalBytes).toBe(16 * 1024 * MIB)
    expect(fit?.availableBytes).toBe(14 * 1024 * MIB)
    expect(fit?.current.contextTokens).toBe(8192)
    expect(fit?.reference.contextTokens).toBe(8192)
    expect(fit?.max.contextTokens).toBe(131072)
    // Base is the file itself; only the context part grows with the window.
    expect(fit?.max.baseBytes).toBe(fit?.current.baseBytes)
    expect(fit?.max.contextBytes).toBeGreaterThan(fit?.current.contextBytes ?? 0)
    expect(fit?.level).toBe('easy')
  })

  it('follows the context slider, and re-reads no GGUF to do it', async () => {
    const { summary } = useLlamaCppVramFit()
    await settle()
    const atEightK = summary.value?.current.totalBytes ?? 0
    const reads = getLlamaCppVramInputs.mock.calls.length

    textInference.contextSize = 131072
    await nextTick()
    expect(summary.value?.current.totalBytes).toBeGreaterThan(atEightK)
    expect(getLlamaCppVramInputs).toHaveBeenCalledTimes(reads)
  })

  it('reads a model once for every place the chip is mounted', async () => {
    textInference.llmModels = [
      { name: 'owner/repo/second.gguf', type: 'llamaCPP', active: true, downloaded: true },
    ]
    useLlamaCppVramFit()
    await settle()
    const reads = getLlamaCppVramInputs.mock.calls.length
    useLlamaCppVramFit()
    await settle()
    expect(getLlamaCppVramInputs).toHaveBeenCalledTimes(reads)
  })

  it('judges a model that is not downloaded yet, projector included', async () => {
    textInference.llmModels = [
      {
        name: 'owner/repo/not-here.gguf',
        mmproj: 'owner/repo/mmproj-BF16.gguf',
        type: 'llamaCPP',
        active: true,
        downloaded: false,
      },
    ]
    const { summary } = useLlamaCppVramFit()
    await settle()

    expect(getLlamaCppVramInputs).toHaveBeenCalledWith(
      'owner/repo/not-here.gguf',
      'owner/repo/mmproj-BF16.gguf',
    )
    expect(summary.value?.level).toBe('easy')
  })

  it('judges a listed model rather than the active one, and reads each list model once', async () => {
    const listed = [
      { name: 'owner/repo/listed-a.gguf', type: 'llamaCPP', active: false, downloaded: false },
      { name: 'owner/repo/listed-b.gguf', type: 'llamaCPP', active: false, downloaded: true },
    ]
    textInference.llmModels = [
      { name: 'owner/repo/active.gguf', type: 'llamaCPP', active: true, downloaded: true },
      ...listed,
    ]
    // Two rows of the picker, each mounting its own chip, plus a second pass over
    // the same rows (the menu reopened).
    const fits = [...listed, ...listed].map((m) =>
      useLlamaCppVramFit(computed(() => m as unknown as LlmModel)),
    )
    await settle()

    const read = getLlamaCppVramInputs.mock.calls.map(([name]) => name)
    expect(fits.every((fit) => fit.summary.value?.level === 'easy')).toBe(true)
    expect(read).toContain('owner/repo/listed-a.gguf')
    expect(read).toContain('owner/repo/listed-b.gguf')
    expect(read).toHaveLength(new Set(read).size)
  })

  it('never has more than three headers in flight', async () => {
    let inFlight = 0
    let peak = 0
    getLlamaCppVramInputs.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return inputs
    })
    const models = Array.from({ length: 9 }, (_, i) => ({
      name: `owner/repo/many-${i}.gguf`,
      type: 'llamaCPP',
      active: false,
      downloaded: false,
    }))
    models.forEach((m) => useLlamaCppVramFit(computed(() => m as unknown as LlmModel)))
    await vi.waitFor(() => expect(getLlamaCppVramInputs).toHaveBeenCalledTimes(9))

    expect(peak).toBeLessThanOrEqual(3)
  })

  it('turns red once the model no longer fits the card', async () => {
    computeMetrics.primaryGpu = { memTotalMiB: 4 * 1024, memUsedMiB: 512 }
    const { summary } = useLlamaCppVramFit()
    await settle()
    expect(summary.value?.level).toBe('over')
  })

  it('says nothing without a GPU sample or on another backend', async () => {
    computeMetrics.primaryGpu = undefined
    const { summary } = useLlamaCppVramFit()
    await settle()
    expect(summary.value).toBeNull()

    computeMetrics.primaryGpu = { memTotalMiB: 16 * 1024 }
    await nextTick()
    expect(summary.value).not.toBeNull()

    textInference.backend = 'openVINO'
    await settle()
    expect(summary.value).toBeNull()
  })
})
