import { shell } from 'electron'
import type { HermesBackendService } from '../../adapters/backends/hermesBackendService'
import type { HermesInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { ipcFail } from '../typedIpc'

export type HermesDeps = {
  hermesService: () => HermesBackendService | null
}

export function buildHermesRegistry(deps: HermesDeps) {
  return {
    'hermes:openDashboard': async () => {
      const service = deps.hermesService()
      if (!service) return { success: false as const, error: 'Hermes Agent is not available' }
      try {
        await shell.openExternal(await service.ensureDashboard())
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
  } satisfies InvokeHandlerMap<HermesInvokeName>
}
