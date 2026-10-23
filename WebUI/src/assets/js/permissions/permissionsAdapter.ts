import { useDialogStore } from '../store/dialogs'
import { remoteTurnPort, type DownloadChannelQuestion } from './remoteTurnPort'
import {
  isAgentSessionTurn,
  sessionLabel,
  whenSessionInView,
  whenSessionTurnEnds,
} from './sessionPromptPort'
import { createCancellation, extractMessage, isCancellation } from '../errors/appError'

/**
 * Renderer half of the Permissions prompt adapter (step 13). Main owns grant
 * lookup and skip-confirmation; this module shows the desktop modal, routes a
 * remote turn to the registered Home Agent port, races an Agent Mode download
 * against its Channel Question, and asks the VRAM warning.
 * `notify` stays local — it is display-only, not a consent decision.
 */

const PING_INTERVAL_MS = 30_000

const never = new Promise<never>(() => {})

/** The desktop modal, held until the session is on screen; `dismiss` keeps it from ever showing. */
function desktopDownload(
  models: DownloadModelParam[],
  conversationKey: string | undefined,
  onConfirm?: () => void,
) {
  let dismissed = false
  let shown = false
  let modal: { dismiss: () => void } | undefined
  const done = (async () => {
    await whenSessionInView(conversationKey)
    if (dismissed) return never
    shown = true
    await new Promise<void>((resolve, reject) => {
      modal = useDialogStore().showDownloadDialog(models, resolve, reject, { onConfirm })
    })
  })()
  return {
    done,
    wasShown: () => shown,
    dismiss: () => {
      dismissed = true
      modal?.dismiss()
    },
  }
}

/** The first answer, from the modal or the Channel Question, wins (docs/adr/0004). */
async function raceDownload(
  models: DownloadModelParam[],
  conversationKey: string,
  question: DownloadChannelQuestion,
): Promise<void> {
  const desktop = desktopDownload(models, conversationKey, () => question.retire('answered-in-app'))
  // The modal may already be up when the turn ends; the channel must not keep a live question.
  void whenSessionTurnEnds(conversationKey).then(() => question.retire('closed'))
  const fromDesktop = desktop.done.then(
    () => ({ side: 'desktop' as const }),
    (error: unknown) => ({ side: 'desktop' as const, error }),
  )
  const fromChannel = question.answer.then((answer) => ({ side: 'channel' as const, answer }))
  const winner = await Promise.race([fromDesktop, fromChannel])
  if (winner.side === 'desktop') {
    question.retire(desktop.wasShown() ? 'answered-in-app' : 'closed')
    if ('error' in winner) throw winner.error
    return
  }
  desktop.dismiss()
  if (!winner.answer) {
    throw createCancellation({ technicalMessage: 'Download declined in the Notification Channel' })
  }
  await question.download()
}

function channelQuestionFor(
  models: DownloadModelParam[],
  conversationKey: string | undefined,
): DownloadChannelQuestion | null {
  if (!conversationKey || !isAgentSessionTurn(conversationKey)) return null
  const port = remoteTurnPort()
  if (!port.canAskChannelQuestion()) return null
  return port.askDownloadQuestion(models, {
    label: sessionLabel(conversationKey),
    conversationKey,
  })
}

function respond(payload: import('@/types/permissionsIpc').PermissionsPromptResponse): void {
  void window.electronAPI.permissions.respond(payload)
}

async function handlePrompt(
  request: import('@/types/permissionsIpc').PermissionsPromptPayload,
): Promise<void> {
  const pings = setInterval(
    () => respond({ requestId: request.requestId, progress: true }),
    PING_INTERVAL_MS,
  )
  try {
    switch (request.kind) {
      case 'is-remote': {
        respond({ requestId: request.requestId, result: remoteTurnPort().isActive() })
        break
      }
      case 'download': {
        const models = request.models as DownloadModelParam[]
        // Asked before the remote-turn branch: the pre-grant must never skip it.
        const question = channelQuestionFor(models, request.conversationKey)
        if (question && request.conversationKey) {
          await raceDownload(models, request.conversationKey, question)
        } else if (remoteTurnPort().isActive()) {
          await remoteTurnPort().downloadModels(models, {
            skipConfirmation: request.skipConfirmation,
          })
        } else {
          await desktopDownload(models, request.conversationKey).done
        }
        respond({ requestId: request.requestId, result: true })
        break
      }
      case 'vram-warning': {
        await whenSessionInView(request.conversationKey)
        const answer = await new Promise<{ confirmed: boolean; remember: boolean }>((resolve) => {
          useDialogStore().showWarningDialog(
            request.message,
            (dontShowAgain) => resolve({ confirmed: true, remember: Boolean(dontShowAgain) }),
            {
              dontShowAgainKey: request.presetName,
              onCancel: () => resolve({ confirmed: false, remember: false }),
            },
          )
        })
        respond({ requestId: request.requestId, result: answer })
        break
      }
    }
  } catch (error) {
    // An AppError is a plain object, so `String(error)` here was the
    // "[object Object]" a declined in-channel download used to surface as.
    respond({
      requestId: request.requestId,
      error: extractMessage(error),
      cancelled: isCancellation(error),
    })
  } finally {
    clearInterval(pings)
  }
}

let started = false

export function startPermissionsAdapter(): void {
  if (started) return
  started = true
  window.electronAPI.permissions.onPrompt((payload) => {
    void handlePrompt(payload)
  })
}

export function resetPermissionsAdapterForTest(): void {
  started = false
}
