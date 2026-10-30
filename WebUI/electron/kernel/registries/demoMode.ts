import type { DemoModeInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import type { DemoModeConfig } from '../demoModeConfig'

export type DemoModeDeps = {
  demoModeConfig: DemoModeConfig
  relaunchApp: () => void
}

export function buildDemoModeRegistry(deps: DemoModeDeps) {
  return {
    'demoMode:leave': () => deps.demoModeConfig.leaveDemoMode(),
    'demoMode:enter': () => deps.demoModeConfig.enterDemoMode(),
    'demoMode:save': (_event, update) => deps.demoModeConfig.saveDemoConfig(update),
    'demoMode:restart': () => deps.relaunchApp(),
  } satisfies InvokeHandlerMap<DemoModeInvokeName>
}
