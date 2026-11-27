import { shallowRef } from 'vue'
import type { BackendServiceName } from '@/assets/js/store/backendServices'
import type { ComponentWork, HeldComponent } from '@/types/componentChange'

// The Components only the window knows it is holding: speech turns and model
// downloads. Main's own work (turns, Agent Runs, media runs) reaches the guard
// from the orchestrator, so nothing here duplicates it. Holds are reported to
// main over `lifecycle:reportComponentHolds` and read back by the Component
// Manager, so a change is blocked on both sides by the same facts.

let entries: HeldComponent[] = []
const held = shallowRef<HeldComponent[]>([])

/** The window's current holds, for display and for the report to main. */
export const windowComponentHolds = held

function publish(): void {
  held.value = [...entries]
}

/** Marks a Component in use until the returned release runs; safe to call twice. */
export function beginComponentHold(component: BackendServiceName, work: ComponentWork): () => void {
  const entry: HeldComponent = { component, work }
  entries = [...entries, entry]
  publish()
  let released = false
  return () => {
    if (released) return
    released = true
    entries = entries.filter((held) => held !== entry)
    publish()
  }
}

export function resetComponentHoldsForTest(): void {
  entries = []
  publish()
}
