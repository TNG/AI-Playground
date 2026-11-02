import type { WebContents } from 'electron'
import type { CloseAnswerPayload, InFlightWorkItem } from '@/types/lifecycleIpc'
import type { LifecycleSendName, SendHandlerMap } from '../ipcRegistries'

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
