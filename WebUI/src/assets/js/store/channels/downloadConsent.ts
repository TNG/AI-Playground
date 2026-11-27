import type { ModelMeta } from '@/lib/modelDownloader'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import { channelQuestionTemplates } from '@/lib/channelQuestionWording'
import { fillTemplate } from '@/lib/fillTemplate'
import type {
  ChannelQuestionOutcome,
  DownloadChannelQuestion,
} from '@/assets/js/permissions/remoteTurnPort'
import { createAppError, createCancellation } from '../../errors/appError'
import {
  modelDownloads,
  throwUnlessDone,
  type ModelDownloadOutcome,
} from '../../models/modelDownloadQueue'
import { holdOpenDownloadQuestion } from '../../models/openDownloadQuestions'
import type { ConfirmationRequest } from '../confirmations'
import type { ChannelAdapter } from './adapter'
import { escapeHtml } from './adapterHelpers'
import type { ChannelQuestion, ChannelQuestionRegistry } from './channelQuestions'
import { fanOutDownloadQuestion } from './downloadQuestionFanOut'
import {
  postDownloadMessage,
  runHeadlessDownload,
  trackModelDownload,
  type HeadlessDownloadText,
} from './headlessDownload'
import type { ChannelKind, InboundMeta } from './types'

/** How long to wait for an in-channel yes/no before auto-cancelling a download. */
const CONFIRM_TIMEOUT_MS = 2 * 60_000
/** Title shown on the inline desktop confirmation card for remote downloads. */
const DOWNLOAD_CONFIRM_TITLE = 'Download model?'

type RemoteTurn = { adapter: ChannelAdapter; meta?: InboundMeta }

export type DownloadQuestionContext = {
  label: string
  conversationKey: string
  alreadyDownloading?: DownloadModelParam[]
  answer?: AgentAnswerOrigin
}

export type ChannelDownloadConsentDeps = {
  questions: ChannelQuestionRegistry
  /** The desktop's inline confirmation cards, which mirror an in-channel question. */
  confirmations: {
    request: (input: ConfirmationRequest) => Promise<boolean>
    cancelForConversation: (conversationKey: string, answer: boolean) => void
  }
  adapterFor: (kind: ChannelKind) => ChannelAdapter | null
  /** The Channels an agent's download question is asked on. */
  channels: () => readonly ChannelKind[]
  /** The conversation a remote turn's download is waited on in. */
  conversationKey: () => string
  modelMeta: (list: DownloadModelParam[]) => Promise<ModelMeta[]>
  log: (message: string, error: unknown) => void
}

/** The note a retired download question is edited to show. */
export function channelQuestionNote(outcome: ChannelQuestionOutcome): string {
  const text = channelQuestionTemplates()
  if (typeof outcome === 'object') {
    return fillTemplate(text.alreadyDownloadingFor, { label: outcome.alreadyDownloadingFor })
  }
  switch (outcome) {
    case 'answered-elsewhere':
      return text.answeredElsewhere
    case 'answered-in-app':
      return text.answeredInApp
    case 'declined-in-app':
      return text.declinedInApp
    case 'closed':
      return text.closed
    case 'unavailable':
      return text.unavailable
  }
}

function downloadText(label: string): HeadlessDownloadText {
  const text = channelQuestionTemplates()
  return {
    queued: text.queued,
    starting: text.starting,
    progress: (p) =>
      fillTemplate(text.progress, {
        model: p.repoId,
        percent: String(p.percent),
        completed: String(p.completed),
        total: String(p.total),
      }),
    complete: fillTemplate(text.complete, { label }),
    failed: (error) => fillTemplate(text.failed, { label, error }),
    cancelled: text.cancelledInApp,
  }
}

function gatedDownloadText(blocked: { repo_id: string }[]): string {
  const names = blocked.map((m) => m.repo_id).join(', ')
  return `🔒 ${names} ${blocked.length === 1 ? 'is gated' : 'are gated'} and can't be downloaded remotely. Open AI Playground on your computer to accept the license / set a Hugging Face token, then try again.`
}

function reply(adapter: ChannelAdapter, htmlSnippet: string, meta?: InboundMeta) {
  return adapter.reply(adapter.formatRichSnippet(htmlSnippet), meta)
}

/**
 * Download consent asked on Channels: a remote turn's own download, and an agent's download
 * question asked on every Channel (or the Answer's) while the desktop asks too.
 */
export function createChannelDownloadConsent(deps: ChannelDownloadConsentDeps) {
  const { questions, confirmations, log } = deps
  /** The Channel message being handled whose download is asked on that Channel. */
  let activeRemoteTurn: RemoteTurn | null = null

  function isRemoteTurnActive(): boolean {
    return activeRemoteTurn !== null
  }

  /** Runs `work` as part of a remote turn, so its download questions go to that channel. */
  async function withRemoteTurn<T>(turn: RemoteTurn, work: () => Promise<T>): Promise<T> {
    const previous = activeRemoteTurn
    activeRemoteTurn = previous ?? turn
    try {
      return await work()
    } finally {
      activeRemoteTurn = previous
    }
  }

  /**
   * Ask the remote user (mirrored on the desktop) to approve a download. `closedBy`
   * answers it for them with a note, once a yes elsewhere downloads it all.
   */
  async function requestDownloadConfirmation(
    turn: RemoteTurn,
    conversationKey: string,
    summaryMarkdown: string,
    closedBy: Promise<string>,
  ): Promise<boolean | 'closed'> {
    const mirror = confirmations.request({
      conversationKey,
      title: DOWNLOAD_CONFIRM_TITLE,
      summaryMarkdown,
      origin: 'remote',
      channelLabel: turn.adapter.kind,
    })
    const channel = questions.ask({
      adapter: turn.adapter,
      meta: turn.meta,
      summaryMarkdown,
      typedReply: true,
      timeoutMs: CONFIRM_TIMEOUT_MS,
    })
    const answer = await Promise.race([mirror, channel.answer, closedBy.then((note) => ({ note }))])
    if (typeof answer === 'object') {
      questions.settle(channel.id, false, answer.note)
      confirmations.cancelForConversation(conversationKey, false)
      return 'closed'
    }
    questions.settle(
      channel.id,
      answer,
      answer ? '✅ Confirmed from the desktop app.' : '❌ Cancelled from the desktop app.',
    )
    confirmations.cancelForConversation(conversationKey, answer)
    return answer
  }

  /**
   * Remote model-download path used when a readiness check finds missing
   * models during a remote turn (no desktop user to drive the modal). Declines
   * gated models that need browser interaction, asks approval in-channel
   * (mirrored on the desktop) unless the caller passes a pre-grant's
   * `skipConfirmation`, then waits on a Model Download in the shared queue with
   * one edited progress message (`runHeadlessDownload`). Models another Model
   * Download already covers are joined, not asked about again. Resolves on
   * success; throws (silent/cancelled AppError) on decline or failure so the
   * caller's `reject` unwinds the inference attempt cleanly.
   */
  async function handleRemoteModelDownload(
    list: DownloadModelParam[],
    options?: { skipConfirmation?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    const turn = activeRemoteTurn
    if (!turn) {
      throw createAppError({
        category: 'inference',
        code: 'model/download-no-channel',
        userMessage: 'A model download needs confirmation but no channel is active.',
        surface: 'silent',
      })
    }
    const { adapter, meta } = turn
    const conversationKey = deps.conversationKey()
    const waiter = modelDownloads().waiter(conversationKey)
    const leave = () => waiter.detach()
    options?.signal?.addEventListener('abort', leave, { once: true })
    if (options?.signal?.aborted) leave()
    try {
      // Models another Model Download already covers are waited on, never asked again.
      const toAsk = waiter.attach(list)
      const joined = toAsk.length > 0 && (await approveRemoteDownload(toAsk)) === 'joined'
      await runHeadlessDownload(
        {
          adapter,
          meta,
          list: joined ? [] : toAsk,
          waiter,
          label: channelQuestionTemplates().forChannel,
        },
        { queue: modelDownloads(), log },
      )
    } catch (e) {
      leave()
      throw e
    } finally {
      options?.signal?.removeEventListener('abort', leave)
    }

    async function approveRemoteDownload(
      toDownload: DownloadModelParam[],
    ): Promise<'approved' | 'joined'> {
      let metaList
      try {
        metaList = await deps.modelMeta(toDownload)
      } catch (e) {
        await reply(adapter, '⚠️ Could not check the required model download. Try again.', meta)
        throw createAppError({
          category: 'inference',
          code: 'model/download-meta-failed',
          userMessage: 'Could not check the required model download.',
          surface: 'silent',
          cause: e,
        })
      }

      const blocked = metaList.filter((m) => m.gated && !m.accessGranted)
      if (blocked.length > 0) {
        const names = blocked.map((m) => m.repo_id).join(', ')
        await reply(adapter, gatedDownloadText(blocked), meta)
        throw createCancellation({
          technicalMessage: `gated model(s) not downloadable remotely: ${names}`,
        })
      }

      const summaryLines = metaList.map((m) => `• \`${m.repo_id}\`${m.size ? ` (${m.size})` : ''}`)
      const summaryMarkdown = `I need to download ${metaList.length === 1 ? 'a model' : `${metaList.length} models`} before I can answer:\n${summaryLines.join('\n')}`
      if (options?.skipConfirmation === true) return 'approved'
      let join: (label: string) => void = () => {}
      const joined = new Promise<string>((resolve) => {
        join = (label) =>
          resolve(fillTemplate(channelQuestionTemplates().alreadyDownloadingFor, { label }))
      })
      // A Model Download it already waits on was cancelled or failed mid-question.
      let endedEarly = null as ModelDownloadOutcome | null
      const ended = waiter.settled.then((outcome) => {
        endedEarly = outcome
        return channelQuestionTemplates().cancelledInApp
      })
      const stopHolding = holdOpenDownloadQuestion({ waiter, models: toDownload, join })
      try {
        const answer = await requestDownloadConfirmation(
          { adapter, meta },
          conversationKey,
          summaryMarkdown,
          Promise.race([joined, ended]),
        )
        if (answer === 'closed') {
          if (endedEarly) {
            throwUnlessDone(endedEarly, () =>
              createCancellation({ technicalMessage: 'remote model download cancelled' }),
            )
          }
          return 'joined'
        }
        if (!answer) {
          throw createCancellation({ technicalMessage: 'remote model download declined' })
        }
        return 'approved'
      } finally {
        stopHolding()
      }
    }
  }

  /** An agent's download, asked on the Answer's Channel for a turn it started, else on every one. */
  function askDownloadQuestion(
    list: DownloadModelParam[],
    context: DownloadQuestionContext,
  ): DownloadChannelQuestion {
    const origin = context.answer
    const kinds = origin
      ? deps.channels().filter((kind) => kind === origin.channel)
      : deps.channels()
    let lookup: Promise<ModelMeta[]> | null = null
    const lookupOnce = () => {
      lookup ??= deps.modelMeta(list)
      return lookup
    }
    return fanOutDownloadQuestion(
      kinds.map((kind) => askDownloadQuestionOn(kind, context, lookupOnce)),
      (question) => question.retire('answered-elsewhere'),
    )
  }

  /** One Channel's download question; buttons only, no timeout. */
  function askDownloadQuestionOn(
    kind: ChannelKind,
    context: DownloadQuestionContext,
    lookupModelMeta: () => Promise<ModelMeta[]>,
  ): DownloadChannelQuestion {
    const adapter = deps.adapterFor(kind)
    const { answer: origin } = context
    const meta: InboundMeta | undefined =
      origin?.channel === kind && origin.replyTo ? { threadTs: origin.replyTo } : undefined
    let retired: ChannelQuestionOutcome | null = null
    let asked: ChannelQuestion | null = null
    // A desktop yes that came before the question reached the channel.
    let answeredEarly: string | null = null
    const never = new Promise<boolean>(() => {})

    const answer = (async (): Promise<boolean> => {
      if (!adapter) return never
      let metaList
      try {
        metaList = await lookupModelMeta()
      } catch (e) {
        log('channels: model sizes for a download question failed:', e)
        if (!retired) {
          await reply(
            adapter,
            fillTemplate(channelQuestionTemplates().lookupFailed, {
              label: escapeHtml(context.label),
            }),
            meta,
          ).catch((err: unknown) => log('channels: download question reply failed:', err))
        }
        return never
      }
      // The channel may have been left while the model sizes were looked up.
      if (retired || !deps.channels().includes(kind)) return never
      const blocked = metaList.filter((m) => m.gated && !m.accessGranted)
      if (blocked.length > 0) {
        const gated = fillTemplate(channelQuestionTemplates().gated, {
          label: escapeHtml(context.label),
          models: escapeHtml(blocked.map((m) => m.repo_id).join(', ')),
        })
        await reply(adapter, gated, meta).catch((err: unknown) =>
          log('channels: gated download reply failed:', err),
        )
        return never
      }
      const text = channelQuestionTemplates()
      const lines = metaList.map((m) => `• \`${m.repo_id}\`${m.size ? ` (${m.size})` : ''}`)
      const heading = fillTemplate(metaList.length === 1 ? text.askOne : text.askMany, {
        label: context.label,
        count: String(metaList.length),
      })
      const already = context.alreadyDownloading ?? []
      const alreadyLine = already.length
        ? `\n${fillTemplate(text.alreadyDownloading, {
            models: already.map((m) => `\`${m.repo_id}\``).join(', '),
          })}`
        : ''
      const summaryMarkdown = `${heading}\n${lines.join('\n')}${alreadyLine}`
      if (answeredEarly) {
        // No buttons to answer any more: the message only follows the download.
        const prefix = channelQuestionNote('answered-in-app')
        const posted = postDownloadMessage(adapter, `${summaryMarkdown}\n\n${prefix}`, meta, log)
        followDownload(
          answeredEarly,
          (note) => posted.edit(`${summaryMarkdown}\n\n${note}`),
          prefix,
        )
        return never
      }
      asked = questions.ask({ adapter, meta, summaryMarkdown, labels: text })
      return asked.answer
    })()

    function followDownload(downloadId: string, edit: (note: string) => void, prefix?: string) {
      trackModelDownload({
        queue: modelDownloads(),
        downloadId,
        message: { edit },
        text: downloadText(context.label),
        prefix,
      })
    }

    return {
      answer,
      follow: (downloadId, options) => {
        const question = asked
        if (!question) {
          answeredEarly = downloadId
          return
        }
        const prefix = options?.answeredInApp ? channelQuestionNote('answered-in-app') : undefined
        if (prefix) questions.retire(question.id, prefix)
        followDownload(downloadId, question.edit, prefix)
      },
      retire: (outcome) => {
        if (retired) return
        retired = outcome
        if (asked) questions.retire(asked.id, channelQuestionNote(outcome))
      },
    }
  }

  return { isRemoteTurnActive, withRemoteTurn, handleRemoteModelDownload, askDownloadQuestion }
}
