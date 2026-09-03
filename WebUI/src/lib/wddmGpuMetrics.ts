import type { GpuSample, GpuVendor } from '@/types/computeMetrics'

/** PDH instance: `luid_0x00000000_0x00017AB2_phys_0` or `…_eng_0_engtype_3D`. */
export type PdhGpuInstance = {
  high: number
  low: number
  phys: number
  engine?: number
  engineType?: string
}

const INSTANCE_RE =
  /^luid_0x([0-9a-f]+)_0x([0-9a-f]+)(?:_phys_(\d+))?(?:_eng_(\d+)_engtype_(.+))?$/i

export function parsePdhGpuInstance(name: string): PdhGpuInstance | undefined {
  const trimmed = name.trim().replace(/^\\+/, '')
  const match = INSTANCE_RE.exec(trimmed)
  if (!match) return undefined
  return {
    high: Number.parseInt(match[1] ?? '0', 16),
    low: Number.parseInt(match[2] ?? '0', 16),
    phys: Number.parseInt(match[3] ?? '0', 10),
    engine: match[4] !== undefined ? Number.parseInt(match[4], 10) : undefined,
    engineType: match[5],
  }
}

export function luidKey(high: number, low: number, phys = 0): string {
  return `${high}:${low}:${phys}`
}

export function bytesToMiB(bytes: number): number {
  return bytes / (1024 * 1024)
}

export function vendorFromPciId(vendorId: number): GpuVendor {
  if (vendorId === 0x8086) return 'intel'
  if (vendorId === 0x10de) return 'nvidia'
  return 'unknown'
}

/** Dedicated ≥ 3 GiB is a discrete card; below that, Task Manager's "GPU memory" is dedicated+shared. */
export const DISCRETE_DEDICATED_MIB = 3072

export function applyGpuMemoryRollup(gpu: GpuSample): GpuSample {
  const dedicatedTotal = gpu.dedicatedTotalMiB
  const sharedTotal = gpu.sharedTotalMiB
  if (dedicatedTotal == null && sharedTotal == null) return gpu
  const discrete = (dedicatedTotal ?? 0) >= DISCRETE_DEDICATED_MIB
  if (discrete) {
    return {
      ...gpu,
      memUsedMiB: gpu.dedicatedUsedMiB,
      memTotalMiB: dedicatedTotal,
    }
  }
  const usedParts = [gpu.dedicatedUsedMiB, gpu.sharedUsedMiB].filter(
    (n): n is number => n !== undefined,
  )
  const total = (dedicatedTotal ?? 0) + (sharedTotal ?? 0)
  return {
    ...gpu,
    memUsedMiB: usedParts.length > 0 ? usedParts.reduce((a, b) => a + b, 0) : undefined,
    memTotalMiB: total > 0 ? total : undefined,
  }
}

export function namesOverlap(a: string, b: string): boolean {
  const left = a.trim().toLowerCase()
  const right = b.trim().toLowerCase()
  if (!left || !right) return false
  return left.includes(right) || right.includes(left)
}

/** Keep WDDM memory; take clocks/power (and util if WDDM had none) from nvidia-smi / xpu-smi. */
export function overlaySmiOntoWddm(wddm: GpuSample[], smi: GpuSample[]): GpuSample[] {
  if (wddm.length === 0) return smi
  return wddm.map((gpu) => {
    const extra = smi.find((row) => namesOverlap(row.name, gpu.name))
    if (!extra) return gpu
    return {
      ...gpu,
      utilPct: gpu.utilPct ?? extra.utilPct,
      freqMHz: extra.freqMHz ?? gpu.freqMHz,
      powerW: extra.powerW ?? gpu.powerW,
    }
  })
}

export function peakEngineUtil(byLuid: Map<string, number[]>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [key, values] of byLuid) {
    if (values.length === 0) continue
    out.set(key, Math.max(...values))
  }
  return out
}
