import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { createPhisonKmRag, type PhisonKmRagDeps } from './phisonKmRag'
import type { IndexedDocument } from '@/types/rag'

const document = {
  filename: 'policy.pdf',
  filepath: 'C:/policy.pdf',
  type: 'pdf',
  hash: 'h1',
  isChecked: true,
  splitDB: [{ pageContent: 'policy text', metadata: {} }],
  mergedGroups: [{ groupId: 'g0', startChunkIdx: 0, endChunkIdx: 0 }],
  mergedGroupsMeta: {},
} as unknown as IndexedDocument

describe('Phison KM warmup cancel', () => {
  const warmupKVCacheForDocument = vi.fn(async () => ({ success: true }))
  const cancelKmWarmup = vi.fn(async () => ({ success: true }))
  const onDone = vi.fn()
  const onFailed = vi.fn()

  function setup() {
    const km = createPhisonKmRag({
      contextSize: ref(32768),
      requestedContextSize: ref(32768),
      maxContextSizeFromModel: computed(() => undefined),
      getActivePreset: () => ({ supportsPhisonKmRag: true, requiresPhison: false }),
      backend: ref('llamaCPP'),
      backendServices: {
        phisonSsdDetected: true,
        llamaCppBuildVariant: 'ssd-offload',
        info: [{ serviceName: 'llamacpp-backend', llamaCppPhisonArtifactReady: true }],
        ensureEmbeddingServerReady: async () => {},
      },
      isLoadingSettings: () => false,
      warmup: {
        ragList: ref([document]),
        activeModel: () => 'gemma-4',
        warmupModel: () => ({ modelId: 'gemma-4' }),
        embeddingModel: () => 'bge-small',
        embeddingService: () => 'llamacpp-backend',
        ensureModels: async () => {},
        onDone,
        onFailed,
      },
    } as unknown as PhisonKmRagDeps)
    km.ragMode.value = 'phisonKm'
    return km
  }

  beforeEach(() => {
    warmupKVCacheForDocument.mockClear()
    cancelKmWarmup.mockClear()
    onDone.mockClear()
    onFailed.mockClear()
    vi.stubGlobal('window', {
      electronAPI: {
        getEmbeddingServerUrl: async () => ({ success: true, url: 'http://127.0.0.1:39200' }),
        warmupKVCacheForDocument,
        cancelKmWarmup,
      },
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('unlocks at once while analyzing, and the analyzed document is not warmed', async () => {
    const km = setup()
    let finishIndexing!: () => void
    const indexed = km.indexWithKmWarmup(
      () => new Promise((resolve) => (finishIndexing = () => resolve(document))),
    )
    await vi.waitFor(() => expect(finishIndexing).toBeTypeOf('function'))
    expect(km.kmWarmupStatus.value?.phase).toBe('analyzing')

    km.cancelKmWarmup()
    expect(km.kmWarmupBlocking.value).toBe(false)

    finishIndexing()
    await expect(indexed).resolves.toBe(document)
    await Promise.resolve()
    expect(km.kmWarmupBlocking.value).toBe(false)
    expect(warmupKVCacheForDocument).not.toHaveBeenCalled()
    expect(cancelKmWarmup).not.toHaveBeenCalled()
  })

  it('drops the document being prefilled, unlocks, and reports neither done nor failed', async () => {
    const km = setup()
    let failPrefill!: (error: Error) => void
    warmupKVCacheForDocument.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (failPrefill = reject)),
    )
    await km.indexWithKmWarmup(async () => document)
    await vi.waitFor(() => expect(km.kmWarmupStatus.value?.phase).toBe('warming'))

    km.cancelKmWarmup()
    expect(cancelKmWarmup).toHaveBeenCalledTimes(1)
    expect(km.kmWarmupBlocking.value).toBe(false)

    failPrefill(new Error('Warmup cancelled'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onDone).not.toHaveBeenCalled()
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('warms a document uploaded while the cancelled prefill is still stopping', async () => {
    const km = setup()
    let failPrefill!: (error: Error) => void
    warmupKVCacheForDocument.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (failPrefill = reject)),
    )
    await km.indexWithKmWarmup(async () => document)
    await vi.waitFor(() => expect(km.kmWarmupStatus.value?.phase).toBe('warming'))
    km.cancelKmWarmup()

    const second = { ...document, hash: 'h2', mergedGroupsMeta: {} } as IndexedDocument
    await km.indexWithKmWarmup(async () => second)
    failPrefill(new Error('Warmup cancelled'))

    await vi.waitFor(() => expect(warmupKVCacheForDocument).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('warms and reports done when nothing is cancelled', async () => {
    const km = setup()
    await km.indexWithKmWarmup(async () => document)
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(warmupKVCacheForDocument).toHaveBeenCalledTimes(1)
    expect(km.kmWarmupBlocking.value).toBe(false)
  })
})
