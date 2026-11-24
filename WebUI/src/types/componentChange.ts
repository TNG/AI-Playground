import type { BackendServiceName } from '@/assets/js/store/backendServices'

// The in-use guard's vocabulary (ticket 04): work that holds a Component, and the
// kernel's answer to whether a change is allowed. Kernel and renderer share it so
// a refusal names the same kind of work on both sides.

/** What holds a Component: a turn, an Agent Run, a media run, a speech turn or a model download. */
export type ComponentWork = 'turn' | 'agent-run' | 'media-run' | 'speech-turn' | 'model-download'

/** A Component held by work right now. */
export type HeldComponent = {
  component: BackendServiceName
  work: ComponentWork
}

export type ComponentChangeRefusal = {
  code: 'component-in-use'
  work: ComponentWork
}
