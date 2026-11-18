import type { InvokeHandlerMap, RemoteKernelInvokeName } from '../ipcRegistries'
import { ipcErrorText, ipcFail } from '../typedIpc'
import type { RemoteKernel } from '../remoteKernel/remoteKernel'

export function buildRemoteKernelRegistry(deps: { remoteKernel: RemoteKernel }) {
  return {
    'remoteKernel:getStatus': () => deps.remoteKernel.status(),
    'remoteKernel:saveConfig': (_event, update) => {
      try {
        deps.remoteKernel.saveConfig(update)
        return { success: true }
      } catch (error) {
        return ipcFail(error)
      }
    },
    'remoteKernel:regenerateToken': () => ({ token: deps.remoteKernel.regenerateToken() }),
    'remoteKernel:testConnection': async (_event, target) => {
      try {
        return { success: true, hostname: await deps.remoteKernel.testConnection(target) }
      } catch (error) {
        return { success: false, error: ipcErrorText(error) }
      }
    },
  } satisfies InvokeHandlerMap<RemoteKernelInvokeName>
}
