import type { ProductMode } from './localSettings.ts'

export type RecommendableProductMode = {
  mode: ProductMode
  priority: number
  displayOrder: number
  recommendForIntelDeviceIds: string[]
  recommendForNvidia: boolean
  recommendForAmd: boolean
}

/**
 * Highest-priority mode this machine should be offered. NVIDIA and AMD are
 * eligible only when that vendor's GPU was probed; Intel modes match PCI ids.
 * Equal priority keeps the earlier card (lower displayOrder).
 */
export function pickRecommendedProductMode(
  configs: RecommendableProductMode[],
  gpuIds: string[],
  hasNvidia: boolean,
  hasAmd: boolean,
): ProductMode {
  const eligible = configs
    .filter((c) => c.mode !== 'nvidia' || hasNvidia)
    .filter((c) => c.mode !== 'amd' || hasAmd)
    .filter((c) => {
      if (c.mode === 'nvidia') return c.recommendForNvidia === true
      if (c.mode === 'amd') return c.recommendForAmd === true
      if (!c.recommendForIntelDeviceIds.length) return false
      if (gpuIds.length === 0) return false
      return gpuIds.some((id) => c.recommendForIntelDeviceIds.includes(id))
    })
    .sort((a, b) => b.priority - a.priority || a.displayOrder - b.displayOrder)

  return eligible[0]?.mode ?? 'studio'
}
