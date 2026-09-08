/** Architecture fields that size llama.cpp's KV cache and compute buffers. */
export type GgufArch = {
  architecture?: string
  blockCount?: number
  embeddingLength?: number
  feedForwardLength?: number
  contextLength?: number
  vocabSize?: number
  headCount?: number
  headCountKv?: number
  /** Per-layer KV heads when the GGUF stores an array instead of a scalar. */
  headCountKvByLayer?: number[]
  keyLength?: number
  valueLength?: number
  slidingWindow?: number
  /** True = SWA layer. Scalar GGUF period is expanded to this array. */
  slidingWindowPattern?: boolean[]
  fullAttentionInterval?: number
  kvLoraRank?: number
  keyLengthMla?: number
  keyLengthSwa?: number
  valueLengthSwa?: number
  sharedKvLayers?: number
  ssmInnerSize?: number
  ssmStateSize?: number
  ssmGroupCount?: number
  ssmConvKernel?: number
  nextnPredictLayers?: number
}

export type KvCacheType =
  | 'f32'
  | 'f16'
  | 'bf16'
  | 'q8_0'
  | 'q5_1'
  | 'q5_0'
  | 'q4_1'
  | 'q4_0'
  | 'iq4_nl'

export type KvPath = 'mla' | 'hybrid' | 'swa' | 'gqa' | 'legacy' | 'none'

export type LlamaCppRuntime = {
  contextSize: number
  cacheTypeKv?: KvCacheType
  flashAttention?: boolean
  nParallel?: number
  kvUnified?: boolean
  nUbatch?: number
  swaFull?: boolean
  /** `--spec-type draft-mtp`: extra KV for the embedded nextn head. */
  mtp?: boolean
}

export type LlamaCppVramEstimate = {
  weightsBytes: number
  kvCacheBytes: number
  recurrentStateBytes: number
  computeBufferBytes: number
  mtpBytes: number
  totalBytes: number
  kvPath: KvPath
}

export type VramBudget = {
  memTotalBytes: number
  memUsedBytes?: number
  /** Our currently loaded LLM, so live free is not charged twice. */
  residentEstimateBytes?: number
  hostFreeBytes?: number
}

export type VramFit = {
  requiredBytes: number
  emptyCardBudgetBytes: number
  liveBudgetBytes: number
  fitsEmptyCard: boolean
  fitsLive: boolean
  /** Set when the budget included host RAM (iGPU / unified memory). */
  fitsHost?: boolean
}

/** Traffic light shown next to a model: fits easily / barely / not at all. */
export type VramFitLevel = 'easy' | 'tight' | 'over'
