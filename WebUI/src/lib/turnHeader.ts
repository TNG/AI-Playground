import type { InjectionKey } from 'vue'

/** Inside a Turn the header line names the assistant, so its answer bubbles do not repeat it. */
export const turnHeaderShownKey: InjectionKey<boolean> = Symbol('turnHeaderShown')
