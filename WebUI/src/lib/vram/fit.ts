import type { VramBudget, VramFit } from './types.ts'
import { GIB } from './units.ts'

/** Fraction of card size treated as usable. The rest covers Vulkan/driver fragmentation. */
export const VRAM_USABLE_FRACTION = 0.9

/** Host RAM to leave for the OS when GPU memory is shared (iGPU). */
export const HOST_RESERVE_BYTES = 4 * GIB

export function emptyCardBudgetBytes(
  memTotalBytes: number,
  fraction = VRAM_USABLE_FRACTION,
): number {
  return Math.max(0, memTotalBytes * fraction)
}

export function liveBudgetBytes(budget: VramBudget, fraction = VRAM_USABLE_FRACTION): number {
  const used = budget.memUsedBytes ?? 0
  const resident = budget.residentEstimateBytes ?? 0
  const freePlusOurs = budget.memTotalBytes - used + resident
  return Math.max(0, Math.min(emptyCardBudgetBytes(budget.memTotalBytes, fraction), freePlusOurs))
}

export function fitVram(requiredBytes: number, budget: VramBudget): VramFit {
  const empty = emptyCardBudgetBytes(budget.memTotalBytes)
  const live = liveBudgetBytes(budget)
  const fit: VramFit = {
    requiredBytes,
    emptyCardBudgetBytes: empty,
    liveBudgetBytes: live,
    fitsEmptyCard: requiredBytes <= empty,
    fitsLive: requiredBytes <= live,
  }
  if (budget.hostFreeBytes !== undefined) {
    const hostUsable = Math.max(0, budget.hostFreeBytes - HOST_RESERVE_BYTES)
    fit.fitsHost = requiredBytes <= hostUsable
  }
  return fit
}

/** Whether two resident footprints can share the GPU under the same budget. */
export function bothFit(aBytes: number, bBytes: number, budget: VramBudget): boolean {
  return fitVram(aBytes + bBytes, budget).fitsLive
}
