import { useDialogStore, type DownloadDialogOptions } from '../store/dialogs'
import { remoteTurnPort, type DownloadChannelQuestion } from './remoteTurnPort'
import {
  isAgentSessionTurn,
  sessionLabel,
  whenSessionInView,
  whenSessionTurnEnds,
} from './sessionPromptPort'
import { createCancellation, extractMessage, isCancellation } from '../errors/appError'
import { modelDownloads, modelKey, throwUnlessDone } from '../models/modelDownloadQueue'
import { channelQuestionTemplates } from '@/lib/channelQuestionWording'
import type { PermissionsPromptPayload, PermissionsPromptResponse } from '@/types/permissionsIpc'

/**
 * Renderer half of the Permissions prompt adapter (step 13). Main owns grant
 * lookup and skip-confirmation; this module decides which Download Question to
 * ask (docs/adr/0005): models a Model Download already covers are waited on, the
 * rest are asked in the held dialog — raced against a Channel Question for an
 * Agent Mode session — and a yes starts a Model Download in the shared queue.
 * `notify` stays local — it is display-only, not a consent decision.
 */

const PING_INTERVAL_MS = 30_000

const never = new Promise<never>(() => {})

const declined = (technicalMessage: string) => createCancellation({ technicalMessage })

/** The desktop modal, held until the session is on screen; `dismiss` keeps it from ever showing. */
function desktopQuestion(
  models: DownloadModelParam[],
  conversationKey: string | undefined,
  options: DownloadDialogOptions,
) {
  let dismissed = false
  let shown = false
  let modal: { dismiss: () => void } | undefined
  const done = (async () => {
    await whenSessionInView(conversationKey)
    if (dismissed) return never
    shown = true
    return new Promise<DownloadModelParam[]>((resolve, reject) => {
      modal = useDialogStore().showDownloadDialog(
        models,
        (accepted) => resolve(accepted ?? models),
        reject,
        options,
      )
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

/** An unanswered Download Question, so a yes elsewhere that covers it can close it. */
type OpenDownloadQuestion = { models: DownloadModelParam[]; join: (label: string) => void }

const openQuestions = new Set<OpenDownloadQuestion>()

/** Closes every open Download Question that the Model Downloads now running fully cover. */
function closeCoveredQuestions(label: string): void {
  const queue = modelDownloads()
  for (const question of [...openQuestions]) {
    if (queue.split(question.models).uncovered.length === 0) question.join(label)
  }
}

function untilAborted(signal: AbortSignal): Promise<{ side: 'aborted' }> {
  if (signal.aborted) return Promise.resolve({ side: 'aborted' })
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve({ side: 'aborted' }), { once: true }),
  )
}

type DownloadAnswer =
  { kind: 'yes'; accepted: DownloadModelParam[]; fromChannel: boolean } | { kind: 'joined' }

/** The first answer, from the modal or the Channel Question, wins (docs/adr/0004). */
async function askDownloadQuestion(args: {
  models: DownloadModelParam[]
  alreadyDownloading: DownloadModelParam[]
  conversationKey: string
  question: DownloadChannelQuestion | null
  signal: AbortSignal
}): Promise<DownloadAnswer> {
  const { models, question } = args
  const desktop = desktopQuestion(models, args.conversationKey, {
    mode: 'ask',
    alreadyDownloading: args.alreadyDownloading,
  })
  let join: (label: string) => void = () => {}
  const joined = new Promise<{ side: 'joined'; label: string }>((resolve) => {
    join = (label) => resolve({ side: 'joined', label })
  })
  const open: OpenDownloadQuestion = { models, join: (label) => join(label) }
  openQuestions.add(open)
  const fromDesktop = desktop.done.then(
    (accepted) => ({ side: 'desktop' as const, accepted }),
    (error: unknown) => ({ side: 'desktop' as const, error }),
  )
  const fromChannel = question
    ? question.answer.then((answer) => ({ side: 'channel' as const, answer }))
    : never
  try {
    const winner = await Promise.race([fromDesktop, fromChannel, joined, untilAborted(args.signal)])
    switch (winner.side) {
      case 'joined':
        desktop.dismiss()
        question?.retire({ alreadyDownloadingFor: winner.label })
        return { kind: 'joined' }
      case 'aborted':
        desktop.dismiss()
        question?.retire('closed')
        throw declined('The turn stopped waiting for this download')
      case 'desktop':
        if ('error' in winner) {
          const shownAndDeclined = desktop.wasShown() && isCancellation(winner.error)
          question?.retire(shownAndDeclined ? 'declined-in-app' : 'closed')
          throw winner.error
        }
        return { kind: 'yes', accepted: winner.accepted, fromChannel: false }
      case 'channel':
        desktop.dismiss()
        if (!winner.answer) throw declined('Download declined in the Notification Channel')
        return { kind: 'yes', accepted: models, fromChannel: true }
    }
  } finally {
    openQuestions.delete(open)
  }
}

function channelQuestionFor(
  models: DownloadModelParam[],
  conversationKey: string,
  alreadyDownloading: DownloadModelParam[],
): DownloadChannelQuestion | null {
  if (!isAgentSessionTurn(conversationKey)) return null
  const port = remoteTurnPort()
  if (!port.canAskChannelQuestion()) return null
  return port.askDownloadQuestion(models, {
    label: sessionLabel(conversationKey),
    conversationKey,
    ...(alreadyDownloading.length ? { alreadyDownloading } : {}),
  })
}

function waitedOn(models: DownloadModelParam[], uncovered: DownloadModelParam[]) {
  const asked = new Set(uncovered.map(modelKey))
  return models.filter((model) => !asked.has(modelKey(model)))
}

/**
 * A turn's download: Agent Mode and Chat show the dialog ask-only and wait on the
 * Model Download in their session or conversation (the download card).
 */
async function turnDownload(args: {
  models: DownloadModelParam[]
  conversationKey: string
  label: string
  signal: AbortSignal
  answered: () => void
}): Promise<void> {
  const { conversationKey: waiter, signal } = args
  const queue = modelDownloads()
  const uncovered = queue.attach(waiter, args.models)
  if (uncovered.length > 0) {
    const alreadyDownloading = waitedOn(args.models, uncovered)
    const question = channelQuestionFor(uncovered, waiter, alreadyDownloading)
    let answer: DownloadAnswer
    try {
      answer = await askDownloadQuestion({
        models: uncovered,
        alreadyDownloading,
        conversationKey: waiter,
        question,
        signal,
      })
    } catch (error) {
      queue.detach(waiter)
      throw error
    }
    if (answer.kind === 'joined') {
      queue.attach(waiter, uncovered)
    } else {
      const started = queue.start(answer.accepted, [waiter], args.label)
      if (started) {
        closeCoveredQuestions(args.label)
        question?.follow(started, { answeredInApp: !answer.fromChannel })
      } else if (!answer.fromChannel) {
        question?.retire('answered-in-app')
      }
    }
  }
  args.answered()
  const leave = () => queue.detach(waiter)
  signal.addEventListener('abort', leave, { once: true })
  if (signal.aborted) leave()
  try {
    throwUnlessDone(await queue.settled(waiter), () => declined('The model download was cancelled'))
  } finally {
    signal.removeEventListener('abort', leave)
  }
}

/** A download no turn owns (a panel run): the dialog asks and shows the progress itself. */
async function panelDownload(args: {
  models: DownloadModelParam[]
  requestId: string
  signal: AbortSignal
  answered: () => void
}): Promise<void> {
  const waiter = `panel:${args.requestId}`
  const queue = modelDownloads()
  const uncovered = queue.attach(waiter, args.models)
  const joined = uncovered.length === 0
  const desktop = desktopQuestion(joined ? args.models : uncovered, undefined, {
    mode: 'progress',
    waiter,
    joined,
    alreadyDownloading: joined ? [] : waitedOn(args.models, uncovered),
    onConfirm: () => {
      closeCoveredQuestions(channelQuestionTemplates().forOther)
      args.answered()
    },
  })
  if (joined) args.answered()
  const winner = await Promise.race([
    desktop.done.then(() => ({ side: 'done' as const })),
    untilAborted(args.signal),
  ]).catch((error: unknown) => {
    queue.detach(waiter)
    throw error
  })
  if (winner.side === 'aborted') {
    desktop.dismiss()
    queue.detach(waiter)
    throw declined('The prompt was dropped')
  }
}

function respond(payload: PermissionsPromptResponse): void {
  void window.electronAPI.permissions.respond(payload)
}

const dropped = new Map<string, AbortController>()

async function handleDownload(
  request: Extract<PermissionsPromptPayload, { kind: 'download' }>,
  signal: AbortSignal,
): Promise<void> {
  const models = request.models as DownloadModelParam[]
  const key = request.conversationKey
  const answered = () => respond({ requestId: request.requestId, answered: true })
  // An Agent Mode session never takes the remote-turn path: the pre-grant must not skip it.
  if (key && isAgentSessionTurn(key)) {
    void whenSessionTurnEnds(key).then(() => dropped.get(request.requestId)?.abort())
    await turnDownload({ models, conversationKey: key, label: sessionLabel(key), signal, answered })
  } else if (remoteTurnPort().isActive()) {
    await remoteTurnPort().downloadModels(models, {
      skipConfirmation: request.skipConfirmation,
      signal,
    })
  } else if (key) {
    const label = channelQuestionTemplates().forChat
    await turnDownload({ models, conversationKey: key, label, signal, answered })
  } else {
    await panelDownload({ models, requestId: request.requestId, signal, answered })
  }
}

async function handlePrompt(request: PermissionsPromptPayload): Promise<void> {
  if (request.kind === 'drop') {
    dropped.get(request.requestId)?.abort()
    return
  }
  const controller = new AbortController()
  dropped.set(request.requestId, controller)
  const pings = setInterval(() => {
    if (!controller.signal.aborted) respond({ requestId: request.requestId, progress: true })
  }, PING_INTERVAL_MS)
  try {
    switch (request.kind) {
      case 'is-remote': {
        // An Agent Mode turn is never a remote turn's, whatever the Home Agent is doing.
        const remote = remoteTurnPort().isActive() && !isAgentSessionTurn(request.conversationKey)
        respond({ requestId: request.requestId, result: remote })
        break
      }
      case 'download': {
        await handleDownload(request, controller.signal)
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
    dropped.delete(request.requestId)
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
  openQuestions.clear()
  dropped.clear()
}
