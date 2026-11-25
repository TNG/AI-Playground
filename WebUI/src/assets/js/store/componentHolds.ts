import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, shallowRef, watch } from 'vue'
import { connectKernelEventStream } from '@/assets/js/projection/kernelProjection'
import { windowComponentHolds } from '@/lib/componentHoldsRegistry'
import type { BackendServiceName } from './backendServices'
import type { ComponentWork, HeldComponent } from '@/types/componentChange'

// Which Components Work holds right now, and whether any In-flight Work exists.
// Main pushes its own holds (turns, Agent Runs, media runs) on the kernel stream;
// the window's own (speech turns, model downloads) are read from the hold registry
// and reported back to main, so the tab and the kernel refuse the same changes.

export const useComponentHolds = defineStore('componentHolds', () => {
  const mainHolds = shallowRef<HeldComponent[]>([])
  const anyInFlightWork = shallowRef(false)

  const projection = connectKernelEventStream(
    (event) => {
      if (event.type !== 'component-holds') return
      mainHolds.value = event.holds
      anyInFlightWork.value = event.anyInFlightWork
    },
    (snapshot) => {
      mainHolds.value = snapshot.state.componentHolds ?? []
      anyInFlightWork.value = snapshot.state.anyInFlightWork ?? false
    },
  )
  projection.ready.catch((reason: unknown) => {
    console.warn('component hold snapshot unavailable; waiting on stream events instead', reason)
  })
  if (import.meta.hot) {
    import.meta.hot.dispose(() => projection.dispose())
  }

  // The window's holds go back to main so the kernel refuses the same changes.
  watch(windowComponentHolds, (holds) => window.electronAPI?.reportComponentHolds?.(holds), {
    immediate: true,
  })

  const holds = computed<HeldComponent[]>(() => [...mainHolds.value, ...windowComponentHolds.value])

  /** The work holding `component`, or null when it is free to change. */
  function workFor(component: BackendServiceName): ComponentWork | null {
    return holds.value.find((entry) => entry.component === component)?.work ?? null
  }

  return {
    holds,
    anyInFlightWork: computed(() => anyInFlightWork.value || windowComponentHolds.value.length > 0),
    workFor,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useComponentHolds, import.meta.hot))
}
