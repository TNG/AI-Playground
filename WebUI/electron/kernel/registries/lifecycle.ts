import type { WebContents } from 'electron'
import type { CloseAnswerPayload, InFlightWorkItem } from '@/types/lifecycleIpc'
import type {
  InvokeHandlerMap,
  LifecycleInvokeName,
  LifecycleSendName,
  SendHandlerMap,
} from '../ipcRegistries'
import type { IpcMutationResult } from '@/types/ipcChannels'

export type LifecycleDeps = {
  setRendererWork: (work: InFlightWorkItem[]) => void
  requestClose: () => void
  answerClose: (payload: CloseAnswerPayload) => void
  closeBridgeReady: (sender: WebContents) => void
}

export function buildLifecycleSendRegistry(deps: LifecycleDeps) {
  return {
    'lifecycle:reportWork': (_event, work) => {
      deps.setRendererWork(Array.isArray(work) ? work : [])
    },
    'lifecycle:requestClose': () => {
      deps.requestClose()
    },
    'lifecycle:answerClose': (_event, payload) => {
      deps.answerClose(payload)
    },
    'lifecycle:bridgeReady': (event) => {
      deps.closeBridgeReady(event.sender)
    },
  } satisfies SendHandlerMap<LifecycleSendName>
}

export type LifecycleInvokeDeps = {
  requestRestart: () => void
  settingsPath: () => string
  /** Resolves to an error message, empty on success (Electron's `shell.openPath`). */
  openPath: (path: string) => Promise<string>
}

export function buildLifecycleInvokeRegistry(deps: LifecycleInvokeDeps) {
  return {
    'lifecycle:restart': () => {
      deps.requestRestart()
    },
    'lifecycle:openSettingsFile': async (): Promise<IpcMutationResult> => {
      const error = await deps.openPath(deps.settingsPath())
      return error ? { success: false, error } : { success: true }
    },
  } satisfies InvokeHandlerMap<LifecycleInvokeName>
}
