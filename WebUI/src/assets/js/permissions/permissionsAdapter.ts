import { useDialogStore, type DownloadDialogOptions } from '../store/dialogs'
import { remoteTurnPort, type DownloadChannelQuestion } from './remoteTurnPort'
import {
  isAgentSessionTurn,
  sessionAnswerOrigin,
  sessionLabel,
  whenSessionInView,
  whenSessionTurnEnds,
} from './sessionPromptPort'
import { createCancellation, extractMessage, isCancellation } from '../errors/appError'
import {
  modelDownloads,
  modelKey,
  throwUnlessDone,
  type ModelDownloadWaiter,
} from '../models/modelDownloadQueue'
import {
  holdOpenDownloadQuestion,
  resetOpenDownloadQuestionsForTest,
} from '../models/openDownloadQuestions'
import { channelQuestionTemplates } from '@/lib/channelQuestionWording'
import type { PermissionsPromptPayload, PermissionsPromptResponse } from '@/types/permissionsIpc'
import { answerDownloadSession } from './answerDownloadKey'

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

function untilAborted(signal: AbortSignal): Promise<{ side: 'aborted' }> {
  if (signal.aborted) return Promise.resolve({ side: 'aborted' })
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve({ side: 'aborted' }), { once: true }),
  )
}

type DownloadAnswer =
  { kind: 'yes'; accepted: DownloadModelParam[]; fromChannel: boolean } | { kind: 'joined' }

/**
 * The first answer, from the modal or the Channel Question, wins (docs/adr/0004).
 * The question ends early when its waiter settles first: the turn stopped, or a
 * Model Download it already waits on was cancelled or failed.
 */
async function askDownloadQuestion(args: {
  models: DownloadModelParam[]
  alreadyDownloading: DownloadModelParam[]
  conversationKey: string
  question: DownloadChannelQuestion | null
  waiter: ModelDownloadWaiter
}): Promise<DownloadAnswer> {
  const { models, question, waiter } = args
  const desktop = desktopQuestion(models, args.conversationKey, {
    mode: 'ask',
    alreadyDownloading: args.alreadyDownloading,
  })
  let join: (label: string) => void = () => {}
  const joined = new Promise<{ side: 'joined'; label: string }>((resolve) => {
    join = (label) => resolve({ side: 'joined', label })
  })
  const stopHolding = holdOpenDownloadQuestion({ waiter, models, join: (label) => join(label) })
  const fromDesktop = desktop.done.then(
    (accepted) => ({ side: 'desktop' as const, accepted }),
    (error: unknown) => ({ side: 'desktop' as const, error }),
  )
  const fromChannel = question
    ? question.answer.then((answer) => ({ side: 'channel' as const, answer }))
    : never
  const ended = waiter.settled.then((outcome) => ({ side: 'ended' as const, outcome }))
  try {
    const winner = await Promise.race([fromDesktop, fromChannel, joined, ended])
    switch (winner.side) {
      case 'joined':
        desktop.dismiss()
        question?.retire({ alreadyDownloadingFor: winner.label })
        return { kind: 'joined' }
      case 'ended':
        desktop.dismiss()
        question?.retire('closed')
        throwUnlessDone(winner.outcome, () =>
          declined('The turn stopped waiting for this download'),
        )
        return { kind: 'joined' }
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
    stopHolding()
  }
}

function channelQuestionFor(
  models: DownloadModelParam[],
  conversationKey: string,
  label: string,
  alreadyDownloading: DownloadModelParam[],
): DownloadChannelQuestion | null {
  const forAnswer = answerDownloadSession(conversationKey) !== null
  if (!forAnswer && !isAgentSessionTurn(conversationKey)) return null
  const port = remoteTurnPort()
  if (!port.canAskChannelQuestion()) return null
  const answer = sessionAnswerOrigin(conversationKey)
  return port.askDownloadQuestion(models, {
    label,
    conversationKey,
    ...(alreadyDownloading.length ? { alreadyDownloading } : {}),
    ...(answer ? { answer } : {}),
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
  skipConfirmation?: boolean
}): Promise<void> {
  const { conversationKey, signal } = args
  const waiter = modelDownloads().waiter(conversationKey)
  const leave = () => waiter.detach()
  signal.addEventListener('abort', leave, { once: true })
  if (signal.aborted) leave()
  try {
    const uncovered = waiter.attach(args.models)
    if (uncovered.length > 0 && args.skipConfirmation) {
      waiter.start(uncovered, args.label)
    } else if (uncovered.length > 0) {
      const alreadyDownloading = waitedOn(args.models, uncovered)
      const question = channelQuestionFor(
        uncovered,
        conversationKey,
        args.label,
        alreadyDownloading,
      )
      const answer = await askDownloadQuestion({
        models: uncovered,
        alreadyDownloading,
        conversationKey,
        question,
        waiter,
      })
      if (answer.kind === 'yes') {
        const started = waiter.start(answer.accepted, args.label)
        if (started) question?.follow(started, { answeredInApp: !answer.fromChannel })
        else if (!answer.fromChannel) question?.retire('answered-in-app')
      }
    }
    waiter.release()
    args.answered()
    throwUnlessDone(await waiter.settled, () => declined('The model download was cancelled'))
  } catch (error) {
    waiter.detach()
    throw error
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
  const group = `panel:${args.requestId}`
  const { uncovered } = modelDownloads().split(args.models)
  const joined = uncovered.length === 0
  const desktop = desktopQuestion(joined ? args.models : uncovered, undefined, {
    mode: 'progress',
    group,
    joined,
    alreadyDownloading: joined ? [] : waitedOn(args.models, uncovered),
    onConfirm: args.answered,
  })
  if (joined) args.answered()
  const winner = await Promise.race([
    desktop.done.then(() => ({ side: 'done' as const })),
    untilAborted(args.signal),
  ])
  if (winner.side === 'aborted') {
    desktop.dismiss()
    modelDownloads().detachGroup(group)
    throw declined('The prompt was dropped')
  }
}

function respond(payload: PermissionsPromptResponse): void {
  void window.electronAPI.permissions.respond(payload)
}

const requestAborts = new Map<string, AbortController>()

async function handleDownload(
  request: Extract<PermissionsPromptPayload, { kind: 'download' }>,
  signal: AbortSignal,
): Promise<void> {
  const models = request.models as DownloadModelParam[]
  const key = request.conversationKey
  const answered = () => respond({ requestId: request.requestId, answered: true })
  const answeredSession = answerDownloadSession(key)
  // An Agent Mode session never takes the remote-turn path: the pre-grant must not skip it.
  if (key && answeredSession !== null) {
    const label = sessionLabel(answeredSession)
    const skipConfirmation = request.skipConfirmation
    await turnDownload({ models, conversationKey: key, label, signal, answered, skipConfirmation })
  } else if (key && isAgentSessionTurn(key)) {
    void whenSessionTurnEnds(key).then(() => requestAborts.get(request.requestId)?.abort())
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
    requestAborts.get(request.requestId)?.abort()
    return
  }
  const controller = new AbortController()
  requestAborts.set(request.requestId, controller)
  const pings = setInterval(() => {
    if (!controller.signal.aborted) respond({ requestId: request.requestId, progress: true })
  }, PING_INTERVAL_MS)
  try {
    switch (request.kind) {
      case 'is-remote': {
        // An Agent Mode turn is never a remote turn's, whatever the Home Agent is doing.
        const key = request.conversationKey
        const remote =
          answerDownloadSession(key) !== null ||
          (remoteTurnPort().isActive() && !isAgentSessionTurn(key))
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
    requestAborts.delete(request.requestId)
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
  resetOpenDownloadQuestionsForTest()
  requestAborts.clear()
}
