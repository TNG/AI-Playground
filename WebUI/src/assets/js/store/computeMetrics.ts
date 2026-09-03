import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ComputeSnapshot, ComputeWindowStats } from '@/types/computeMetrics'
import { pickPrimaryGpu, summarizeWindow } from '@/lib/computeMetricsWindow'

export const useComputeMetrics = defineStore('computeMetrics', () => {
  const latest = ref<ComputeSnapshot | null>(null)
  const turnStartedAt = ref<number | null>(null)
  const turnSamples = ref<ComputeSnapshot[]>([])

  function applySnapshot(snapshot: ComputeSnapshot) {
    latest.value = snapshot
    if (turnStartedAt.value != null) {
      const next = [...turnSamples.value, snapshot]
      turnSamples.value = next.length > 120 ? next.slice(-120) : next
    }
  }

  function beginTurn() {
    turnStartedAt.value = Date.now()
    turnSamples.value = latest.value ? [latest.value] : []
  }

  function endTurn(hint?: string): ComputeWindowStats | null {
    const stats = turnSamples.value.length > 0 ? summarizeWindow(turnSamples.value, hint) : null
    turnStartedAt.value = null
    turnSamples.value = []
    return stats
  }

  function currentStats(hint?: string): ComputeWindowStats | null {
    if (turnSamples.value.length > 0) return summarizeWindow(turnSamples.value, hint)
    if (latest.value) return summarizeWindow([latest.value], hint)
    return null
  }

  const primaryGpu = computed(() => (latest.value ? pickPrimaryGpu(latest.value.gpus) : undefined))

  void window.electronAPI.getComputeMetrics().then((snapshot) => {
    if (snapshot) applySnapshot(snapshot)
  })
  window.electronAPI.onComputeMetricsUpdate(applySnapshot)

  return {
    latest,
    primaryGpu,
    applySnapshot,
    beginTurn,
    endTurn,
    currentStats,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useComputeMetrics, import.meta.hot))
}
