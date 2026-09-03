/** One GPU as of a sample. Missing fields are unavailable from that probe. */
export type GpuVendor = 'intel' | 'nvidia' | 'unknown'

export type GpuSample = {
  id: string
  name: string
  vendor: GpuVendor
  utilPct?: number
  memUsedMiB?: number
  memTotalMiB?: number
  freqMHz?: number
  powerW?: number
}

export type ComputeSnapshot = {
  ts: number
  /** How the GPU rows were filled. Host RAM is always present. */
  source: 'nvidia-smi' | 'xpu-smi' | 'host' | 'mixed'
  host: { memUsedMiB: number; memTotalMiB: number }
  gpus: GpuSample[]
}

/** Peaks and last values over a time window, for a trace or a chat turn. */
export type ComputeWindowStats = {
  sampleCount: number
  gpuName?: string
  gpuUtilPeakPct?: number
  gpuUtilLastPct?: number
  gpuMemPeakMiB?: number
  gpuMemLastMiB?: number
  gpuMemTotalMiB?: number
  hostMemPeakMiB?: number
  hostMemLastMiB?: number
  hostMemTotalMiB?: number
}
