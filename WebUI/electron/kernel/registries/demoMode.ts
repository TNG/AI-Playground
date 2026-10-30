import type { DemoModeInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import type { DemoModeConfig } from '../demoModeConfig'

export type DemoModeDeps = {
  demoModeConfig: DemoModeConfig
}

export function buildDemoModeRegistry(deps: DemoModeDeps) {
  return {
    'demoMode:leave': () => deps.demoModeConfig.leaveDemoMode(),
    'demoMode:enter': () => deps.demoModeConfig.enterDemoMode(),
  } satisfies InvokeHandlerMap<DemoModeInvokeName>
}
