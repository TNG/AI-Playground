import type { InvokeHandlerMap, RemoteKernelInvokeName } from '../ipcRegistries'
import { ipcErrorText, ipcFail } from '../typedIpc'
import type { RemoteKernel } from '../remoteKernel/remoteKernel'

export function buildRemoteKernelRegistry(deps: { remoteKernel: RemoteKernel }) {
  const { remoteKernel } = deps
  const mutation = async (run: () => unknown) => {
    try {
      await run()
      return { success: true } as const
    } catch (error) {
      return ipcFail(error)
    }
  }

  return {
    'remoteKernel:getStatus': () => remoteKernel.status(),
    'remoteKernel:saveConfig': (_event, update) => mutation(() => remoteKernel.saveConfig(update)),
    'remoteKernel:openPairing': async () => {
      try {
        return { success: true, pairing: await remoteKernel.openPairing() }
      } catch (error) {
        return ipcFail(error)
      }
    },
    'remoteKernel:closePairing': () => remoteKernel.closePairing(),
    'remoteKernel:listDevices': () => remoteKernel.status().devices,
    'remoteKernel:revokeDevice': (_event, id) =>
      mutation(() => {
        if (!remoteKernel.revokeDevice(id)) throw new Error('No such device')
      }),
    'remoteKernel:resetPairing': () => mutation(() => remoteKernel.resetPairing()),
    'remoteKernel:discover': async () => {
      try {
        return { success: true, data: await remoteKernel.discover() }
      } catch (error) {
        return ipcFail(error)
      }
    },
    'remoteKernel:pair': async (_event, request) => {
      try {
        return { success: true, hostname: await remoteKernel.pair(request) }
      } catch (error) {
        return { success: false, error: ipcErrorText(error) }
      }
    },
    'remoteKernel:forgetHost': () => mutation(() => remoteKernel.forgetHost()),
  } satisfies InvokeHandlerMap<RemoteKernelInvokeName>
}
