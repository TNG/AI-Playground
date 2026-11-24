import type { BackendServiceName } from '@/assets/js/store/backendServices'
import type { ComponentChangeRefusal, HeldComponent } from '@/types/componentChange'

// The in-use guard (ticket 04): one admission rule keyed by Component. Install,
// repair, update and uninstall consult it in the kernel, so no surface can
// bypass it; the live manager's disable action consults the same decision.

export type ComponentChange = { allowed: true } | ({ allowed: false } & ComponentChangeRefusal)

/** Whether `component` may be changed, and the work blocking it when it may not. */
export function componentChange(
  component: BackendServiceName,
  held: readonly HeldComponent[],
): ComponentChange {
  const holder = held.find((entry) => entry.component === component)
  if (!holder) return { allowed: true }
  return { allowed: false, code: 'component-in-use', work: holder.work }
}

export type ComponentUninstall =
  { allowed: true } | { allowed: false; code: 'component-required'; error: string }

/** Whether `component` may be uninstalled. A required Component never may. */
export function uninstallComponent(
  component: BackendServiceName,
  isRequired: boolean,
): ComponentUninstall {
  if (!isRequired) return { allowed: true }
  return {
    allowed: false,
    code: 'component-required',
    error: `Cannot uninstall ${component}: it is required.`,
  }
}

export type ComponentChangeDeps = {
  /** Every Component held by work in flight: what main owns and what the window reports. */
  heldComponents: () => readonly HeldComponent[]
  /** Whether any In-flight Work exists at all; a Hardware Mode change is refused then. */
  hasInFlightWork: () => boolean
}

export function createComponentChanges(deps: ComponentChangeDeps) {
  return {
    change: (component: BackendServiceName): ComponentChange =>
      componentChange(component, deps.heldComponents()),
    uninstall: (component: BackendServiceName, isRequired: boolean): ComponentUninstall =>
      uninstallComponent(component, isRequired),
    anyInFlightWork: (): boolean => deps.hasInFlightWork(),
  }
}

export type ComponentChanges = ReturnType<typeof createComponentChanges>
