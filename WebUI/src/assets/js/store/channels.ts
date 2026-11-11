import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, reactive, computed, watch } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { useConfirmations } from './confirmations'
import { useGlobalSetup } from './globalSetup'
import { useModels } from './models'
import { fetchModelMeta } from '@/lib/modelDownloader'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import type { IpcMutationResult } from '@/types/ipcChannels'
import {
  NO_TRANSCRIPTION_ENDPOINT,
  installSynthesisModel,
  missingTranscriptionModels,
  readyTranscriptionUnattended,
  synthesisModelMissing,
  synthesizeClip,
  transcribe,
  transcriptionAvailable,
} from '../speech/speechIO'
import { base64ToBlob } from '@/lib/transcribe'
import { useConversations } from './conversations'
import * as toast from '../toast'
import {
  CHANNEL_FIELD_SPEC,
  type ChannelConfig,
  type ChannelKind,
  type ChannelPrefs,
  type ChannelRuntimeState,
  type InboundMeta,
} from './channels/types'
import type { ChannelAdapter } from './channels/adapter'
import { escapeHtml } from './channels/adapterHelpers'
import { createAppError, createCancellation } from '../errors/appError'
import { useErrors } from './errors'
import { useChannelSessionPointers } from './channelSessionPointers'
import { useChannelQueue } from './channelQueue'
import { createTelegramAdapter } from './channels/telegramAdapter'
import { createSlackAdapter } from './channels/slackAdapter'
import { createLocalWebAdapter } from './channels/localWebAdapter'
import { createChannelQuestionRegistry, type ChannelQuestion } from './channels/channelQuestions'
import { fanOutDownloadQuestion } from './channels/downloadQuestionFanOut'
import { createAnswerRouter } from './channels/answerRouter'
import { createRemoteSpeech, type SpeechClip } from './channels/remoteSpeech'
import { sessionPort } from './channels/sessionPort'
import {
  closeDownloadMessages,
  postDownloadMessage,
  runHeadlessDownload,
  trackModelDownload,
  type HeadlessDownloadText,
} from './channels/headlessDownload'
import {
  modelDownloads,
  throwUnlessDone,
  type ModelDownloadOutcome,
} from '../models/modelDownloadQueue'
import { holdOpenDownloadQuestion } from '../models/openDownloadQuestions'
import { channelQuestionTemplates } from '@/lib/channelQuestionWording'
import { fillTemplate } from '@/lib/fillTemplate'
import {
  registerRemoteTurnPort,
  type ChannelQuestionOutcome,
  type DownloadChannelQuestion,
} from '@/assets/js/permissions/remoteTurnPort'
import { requestDownloadConsent } from '@/assets/js/permissions/permissions'

// ── Channel registry ────────────────────────────────────────────────────────
// Kinds we manage in this store. Adding a fourth one means appending to this
// list and dropping in a new adapter — no other edits to this file.
const KINDS = ['telegram', 'slack', 'local-web'] as readonly ChannelKind[]

const POLL_INTERVAL_MS = 2000
/** How long to wait for an in-channel yes/no before auto-cancelling a download. */
const CONFIRM_TIMEOUT_MS = 2 * 60_000
/** Title shown on the inline desktop confirmation card for remote downloads. */
const DOWNLOAD_CONFIRM_TITLE = 'Download model?'

/** Module-level so Vite HMR does not orphan intervals across Pinia setup
 *  closures. Indexed by ChannelKind so adding a kind = one map entry. */
const pollIntervalIds: Partial<Record<ChannelKind, ReturnType<typeof setInterval>>> = {}
// One poll per Channel at a time, so its messages are routed in the order they came.
const pollBusyByKind: Partial<Record<ChannelKind, boolean>> = {}

function disposePoll(kind: ChannelKind) {
  const id = pollIntervalIds[kind]
  if (id !== undefined) {
    clearInterval(id)
    delete pollIntervalIds[kind]
  }
}

function disposeAllPollHandlers() {
  for (const kind of KINDS) disposePoll(kind)
}

function emptyRuntimeState(kind: ChannelKind): ChannelRuntimeState {
  return {
    kind,
    config: {},
    active: false,
  }
}

function emptyPrefs(): ChannelPrefs {
  return { verified: false, identity: null, enabled: false }
}

// Read only: the Home Agent thread migration still reads its routing pointer from it.
const LEGACY_STORAGE_KEY = 'homeAgent'

/** The legacy store's title-bar switch, carried over once; the Channels store keeps its own. */
function legacyMasterEnabled(): boolean {
  try {
    const raw = demoAwareStorage.getItem(LEGACY_STORAGE_KEY)
    const stored = raw ? (JSON.parse(raw) as { masterEnabled?: unknown }).masterEnabled : undefined
    return typeof stored === 'boolean' ? stored : true
  } catch {
    return true
  }
}

export const useChannels = defineStore(
  'channels',
  () => {
    const backendServices = useBackendServices()
    const conversations = useConversations()
    const confirmations = useConfirmations()
    const errors = useErrors()
    const channelSessionPointers = useChannelSessionPointers()
    const channelQueue = useChannelQueue()

    /**
     * Master Channels on/off — the single title-bar toggle. Persisted so Channels
     * resume (or stay off) across restarts. A channel only runs when the master
     * is on AND the channel itself is enabled + verified.
     */
    const masterEnabled = ref(legacyMasterEnabled())

    /**
     * Persisted, non-secret per-channel preferences (verified / identity /
     * enabled). Kept separate from `channels` so Pinia can persist it wholesale
     * without ever serializing the in-memory secret `config`. This is the
     * source of truth for "is this channel set up and wanted"; `channels[kind]`
     * holds only runtime state (secrets + derived `active`).
     */
    const channelPrefs = reactive<Record<ChannelKind, ChannelPrefs>>({
      telegram: emptyPrefs(),
      slack: emptyPrefs(),
      discord: emptyPrefs(),
      'local-web': emptyPrefs(),
    })

    // Runtime-only per-channel state (secret config + derived `active`). Never
    // persisted; rebuilt on launch from safeStorage + channelPrefs.
    const channels = reactive<Record<ChannelKind, ChannelRuntimeState>>({
      telegram: emptyRuntimeState('telegram'),
      slack: emptyRuntimeState('slack'),
      discord: emptyRuntimeState('discord'),
      'local-web': emptyRuntimeState('local-web'),
    })

    // Adapter instances — one per kind. Created at setup time; their methods
    // close over the IPC bridge so the renderer always uses the same adapter
    // identity (matters for the draft-stream cache the streaming code uses).
    const adapters: Record<ChannelKind, ChannelAdapter | null> = {
      telegram: createTelegramAdapter(),
      slack: createSlackAdapter(),
      discord: null, // populated when Discord lands
      'local-web': createLocalWebAdapter(),
    }

    /**
     * The Channel message being handled while its voice clip needs a speech model,
     * so the download is asked on that Channel instead of in a desktop modal nobody sees.
     */
    let activeRemoteTurn: { adapter: ChannelAdapter; meta?: InboundMeta } | null = null

    const channelQuestions = createChannelQuestionRegistry({
      staleReply: () => channelQuestionTemplates().stale,
    })

    const remoteSpeech = createRemoteSpeech({
      transcription: {
        ready: readyTranscriptionUnattended,
        transcribe: async (audio) =>
          (await transcribe({ audio: base64ToBlob(audio.data_base64, audio.mime) })).text,
        isNoEndpoint: (e) => e instanceof Error && e.message === NO_TRANSCRIPTION_ENDPOINT,
      },
      synthesis: {
        synthesize: (text) => synthesizeClip({ text, unattended: true, format: 'wav' }),
      },
      transcriptionModel: {
        installed: transcriptionAvailable,
        missing: missingTranscriptionModels,
        download: (models, adapter, meta) =>
          withRemoteTurn({ adapter, meta }, () => requestDownloadConsent(models)),
      },
      synthesisModel: {
        missing: synthesisModelMissing,
        install: (adapter, meta) => withRemoteTurn({ adapter, meta }, installSynthesisModel),
      },
      log: (message, error) => reportSilently(message, error),
    })

    const answerRouter = createAnswerRouter({
      sessions: sessionPort,
      questions: channelQuestions,
      speech: remoteSpeech,
      downloadQuestionChannels: () => notificationChannels.value,
      pointers: channelSessionPointers,
      publishQueue: (sessionRef, queued) => channelQueue.publish(sessionRef, queued),
      publishSending: (sessionRef, sending) => channelQueue.setSending(sessionRef, sending),
      log: (message, error) => reportSilently(message, error),
    })

    // True once at least one channel has actually been set up (verified). The
    // master toggle is meaningless until then — there is nothing for it to turn
    // on — so the title-bar toggle stays disabled and reads "Off".
    const hasConfiguredChannel = computed(() => KINDS.some((k) => channelPrefs[k].verified))

    const isAvailable = computed(
      () =>
        backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.status ===
        'running',
    )

    /**
     * Single source of activation truth. A channel is active iff the backend
     * is available, the master switch is on, and the channel is both enabled
     * (user pref) and verified. Runs immediately (and deeply) so that on
     * launch — once Pinia has restored `masterEnabled` / `channelPrefs` and the
     * backend reports running — previously-on channels resume polling without
     * any user action.
     */
    function recomputeActive() {
      for (const kind of KINDS) {
        channels[kind].active =
          isAvailable.value &&
          masterEnabled.value &&
          channelPrefs[kind].enabled &&
          channelPrefs[kind].verified
      }
    }
    watch(
      [
        isAvailable,
        masterEnabled,
        () => KINDS.map((k) => channelPrefs[k].enabled),
        () => KINDS.map((k) => channelPrefs[k].verified),
      ],
      recomputeActive,
      { immediate: true, deep: true },
    )

    /** Where a Reachable Session's Notifications and Channel Questions go; empty while off. */
    const notificationChannels = computed(() =>
      KINDS.filter((kind) => channels[kind].active && adapters[kind] !== null),
    )
    const notificationsReady = computed(() => notificationChannels.value.length > 0)

    // When the backend + channel credentials are ready, inject so the bot
    // starts (or restarts if creds changed). One watcher per kind so each
    // can decide its own "credentials ready" predicate without coupling.
    for (const kind of KINDS) {
      watch(
        [isAvailable, () => channels[kind].config, () => channelPrefs[kind].identity],
        ([avail, config, identity]) => {
          if (!avail) return
          // Readiness + identity threading are fully data-driven via
          // CHANNEL_FIELD_SPEC — no per-kind branching. A channel injects once
          // every required secret is present; the identity (chatId / userId /
          // …) is folded back into its config key if missing.
          const spec = CHANNEL_FIELD_SPEC[kind]
          const payload: Record<string, string | undefined> = {
            ...(config as Record<string, string>),
          }
          if (spec.requiredSecrets.some((field) => !payload[field])) return
          if (identity && !payload[spec.identityField]) {
            payload[spec.identityField] = identity ?? undefined
          }
          window.electronAPI.homeAgent.channel
            .inject(kind, payload)
            .catch((e: unknown) => console.error(`channels: inject(${kind}) failed:`, e))
        },
        { flush: 'post', immediate: true, deep: true },
      )

      // Per-channel polling lifecycle.
      watch(
        () => channels[kind].active,
        (val) => {
          if (val) {
            startPolling(kind)
          } else {
            stopPolling(kind)
          }
        },
      )
    }

    async function reply(adapter: ChannelAdapter, htmlSnippet: string, meta?: InboundMeta) {
      return adapter.reply(adapter.formatRichSnippet(htmlSnippet), meta)
    }

    /** In-turn confirmation over the active channel: buttons or a typed yes/no, declined on timeout. */
    function requestRemoteConfirmation(
      adapter: ChannelAdapter,
      summaryMarkdown: string,
      meta?: InboundMeta,
    ) {
      return channelQuestions.ask({
        adapter,
        meta,
        summaryMarkdown,
        typedReply: true,
        timeoutMs: CONFIRM_TIMEOUT_MS,
      })
    }

    function settleFromDesktop(id: string, answer: boolean): void {
      channelQuestions.settle(
        id,
        answer,
        answer ? '✅ Confirmed from the desktop app.' : '❌ Cancelled from the desktop app.',
      )
    }

    /** True while a remote (Telegram/Slack) turn is being processed. Lets
     *  desktop-only flows (e.g. the model-download modal) reroute to a remote
     *  path instead of getting stuck waiting for a desktop click. */
    function isRemoteTurnActive(): boolean {
      return activeRemoteTurn !== null
    }

    /** Runs `work` as part of a remote turn, so its download questions go to that channel. */
    async function withRemoteTurn<T>(
      turn: { adapter: ChannelAdapter; meta?: InboundMeta },
      work: () => Promise<T>,
    ): Promise<T> {
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
      turn: { adapter: ChannelAdapter; meta?: InboundMeta },
      conversationKey: string,
      summaryMarkdown: string,
      closedBy: Promise<string>,
    ): Promise<boolean | 'closed'> {
      const kind = turn.adapter.kind
      const mirror = confirmations.request({
        conversationKey,
        title: DOWNLOAD_CONFIRM_TITLE,
        summaryMarkdown,
        origin: 'remote',
        channelLabel: kind,
      })
      const channel = requestRemoteConfirmation(turn.adapter, summaryMarkdown, turn.meta)
      const answer = await Promise.race([
        mirror,
        channel.answer,
        closedBy.then((note) => ({ note })),
      ])
      if (typeof answer === 'object') {
        channelQuestions.settle(channel.id, false, answer.note)
        confirmations.cancelForConversation(conversationKey, false)
        return 'closed'
      }
      settleFromDesktop(channel.id, answer)
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
      const globalSetup = useGlobalSetup()
      const models = useModels()
      const conversationKey = conversations.activeKey
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
          { queue: modelDownloads(), log: reportSilently },
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
          metaList = await fetchModelMeta(toDownload, {
            apiHost: globalSetup.apiHost,
            hfToken: models.hfToken,
          })
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

        const summaryLines = metaList.map(
          (m) => `• \`${m.repo_id}\`${m.size ? ` (${m.size})` : ''}`,
        )
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

    function gatedDownloadText(blocked: { repo_id: string }[]): string {
      const names = blocked.map((m) => m.repo_id).join(', ')
      return `🔒 ${names} ${blocked.length === 1 ? 'is gated' : 'are gated'} and can't be downloaded remotely. Open AI Playground on your computer to accept the license / set a Hugging Face token, then try again.`
    }

    function channelQuestionNote(outcome: ChannelQuestionOutcome): string {
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

    function reportSilently(message: string, error: unknown): void {
      errors.report(error, { surface: 'silent', technicalMessage: message })
    }

    function canAskChannelQuestion(): boolean {
      return notificationsReady.value
    }

    // A channel the user left must not download anything; the desktop keeps asking.
    watch(notificationChannels, (kinds) =>
      channelQuestions.retireOutside(kinds, channelQuestionNote('unavailable')),
    )

    window.addEventListener('beforeunload', () => {
      closeDownloadMessages(channelQuestionTemplates().appClosed)
      channelQuestions.retireOutside([], channelQuestionNote('closed'))
    })

    type DownloadQuestionContext = {
      label: string
      conversationKey: string
      alreadyDownloading?: DownloadModelParam[]
      answer?: AgentAnswerOrigin
    }

    /** An agent's download, asked on the Answer's Channel for a turn it started, else on every one. */
    function askDownloadQuestion(
      list: DownloadModelParam[],
      context: DownloadQuestionContext,
    ): DownloadChannelQuestion {
      const origin = context.answer
      const kinds = origin
        ? notificationChannels.value.filter((kind) => kind === origin.channel)
        : notificationChannels.value
      let lookup: ReturnType<typeof fetchModelMeta> | null = null
      const lookupOnce = () => {
        const globalSetup = useGlobalSetup()
        const models = useModels()
        lookup ??= fetchModelMeta(list, { apiHost: globalSetup.apiHost, hfToken: models.hfToken })
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
      lookupModelMeta: () => ReturnType<typeof fetchModelMeta>,
    ): DownloadChannelQuestion {
      const adapter = adapters[kind]
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
          errors.report(e, { surface: 'silent' })
          if (!retired) {
            await reply(
              adapter,
              fillTemplate(channelQuestionTemplates().lookupFailed, {
                label: escapeHtml(context.label),
              }),
              meta,
            ).catch((err: unknown) => errors.report(err, { surface: 'silent' }))
          }
          return never
        }
        // The channel may have been left while the model sizes were looked up.
        if (retired || !notificationChannels.value.includes(kind)) return never
        const blocked = metaList.filter((m) => m.gated && !m.accessGranted)
        if (blocked.length > 0) {
          const gated = fillTemplate(channelQuestionTemplates().gated, {
            label: escapeHtml(context.label),
            models: escapeHtml(blocked.map((m) => m.repo_id).join(', ')),
          })
          await reply(adapter, gated, meta).catch((err: unknown) =>
            errors.report(err, { surface: 'silent' }),
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
          const posted = postDownloadMessage(
            adapter,
            `${summaryMarkdown}\n\n${prefix}`,
            meta,
            reportSilently,
          )
          followDownload(
            answeredEarly,
            (note) => posted.edit(`${summaryMarkdown}\n\n${note}`),
            prefix,
          )
          return never
        }
        asked = channelQuestions.ask({ adapter, meta, summaryMarkdown, labels: text })
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
          if (prefix) channelQuestions.retire(question.id, prefix)
          followDownload(downloadId, question.edit, prefix)
        },
        retire: (outcome) => {
          if (retired) return
          retired = outcome
          if (asked) channelQuestions.retire(asked.id, channelQuestionNote(outcome))
        },
      }
    }

    async function processChannelMessages(kind: ChannelKind) {
      const adapter = adapters[kind]
      if (!adapter || pollBusyByKind[kind]) return
      pollBusyByKind[kind] = true
      try {
        const msgs = await window.electronAPI.homeAgent.channel.poll(kind)
        for (const msg of msgs ?? []) {
          if (!channels[kind].active) break
          // Threaded so adapters can target reactions / threaded sends at the originating message.
          const meta =
            msg.channel || msg.ts || msg.chat_id
              ? { channel: msg.channel, ts: msg.ts, chatId: msg.chat_id }
              : undefined
          await answerRouter.route(
            adapter,
            { ...msg, replyTo: msg.reply_to, replyTarget: msg.reply_target },
            meta,
          )
        }
      } catch (e) {
        reportSilently(`channels: routing ${kind} messages failed:`, e)
      } finally {
        pollBusyByKind[kind] = false
      }
    }

    function startPolling(kind: ChannelKind) {
      disposePoll(kind)
      pollIntervalIds[kind] = setInterval(() => {
        processChannelMessages(kind).catch((e: unknown) =>
          console.error(`channels: processChannelMessages(${kind}) failed:`, e),
        )
      }, POLL_INTERVAL_MS)
    }

    function stopPolling(kind: ChannelKind) {
      disposePoll(kind)
    }

    // ── Config / activation API (channel-agnostic) ──────────────────────────

    async function saveChannelConfig(
      kind: ChannelKind,
      config: Partial<ChannelConfig>,
    ): Promise<IpcMutationResult> {
      try {
        // safeStorage save (electron main process). Pass the flat config blob;
        // the main side partitions secret vs public fields.
        const result = await window.electronAPI.homeAgent.channel.saveConfig(
          kind,
          config as Record<string, string>,
        )
        if (result.success) {
          const prev = channels[kind].config as Record<string, string>
          const next = config as Record<string, string>
          const fieldChanged = Object.keys(next).some((k) => prev[k] !== next[k])
          channels[kind].config = { ...config }
          // Track identity in the dedicated prefs `.identity` field so consumers
          // don't need to know which sub-key carries it for each kind.
          const idKey = CHANNEL_FIELD_SPEC[kind].identityField
          if (idKey && next[idKey] !== undefined) channelPrefs[kind].identity = next[idKey]
          // Credentials changed — force re-verification (but keep the user's
          // enabled preference; the channel just won't run until re-verified).
          if (fieldChanged) {
            channelPrefs[kind].verified = false
            // Mirror the invalidation to disk so a restart can't resurrect the
            // stale verified flag from the durable config.
            persistChannelPrefs(kind)
          }
        }
        return result
      } catch (e) {
        console.error(`channels.saveChannelConfig(${kind}) failed:`, e)
        return { success: false as const, error: String(e) }
      }
    }

    async function clearChannelConfig(kind: ChannelKind): Promise<void> {
      try {
        await window.electronAPI.homeAgent.channel.clearConfig(kind)
      } catch (e) {
        console.error(`channels.clearChannelConfig(${kind}) failed:`, e)
      }
      channels[kind] = emptyRuntimeState(kind)
      channelPrefs[kind] = emptyPrefs()
    }

    /**
     * Persist the durable setup flags (verified / enabled) to the on-disk
     * channel config so they survive even when the Pinia/localStorage blob is
     * gone (legacy migration, demo-mode sessionStorage, cleared localStorage).
     * Fire-and-forget: the in-memory `channelPrefs` is the live source; disk is
     * the durable backup re-read by `initConfig()` on the next launch.
     */
    function persistChannelPrefs(kind: ChannelKind): void {
      void window.electronAPI.homeAgent.channel
        .savePrefs(kind, {
          verified: channelPrefs[kind].verified,
          enabled: channelPrefs[kind].enabled,
        })
        .catch((e: unknown) => console.error(`channels.persistChannelPrefs(${kind}) failed:`, e))
    }

    /** Mark a channel verified after a successful test. A freshly verified
     *  channel defaults to enabled so it starts running immediately (subject
     *  to the master switch) — matching the prior "verify ⇒ on" behavior. */
    function setVerified(kind: ChannelKind) {
      channelPrefs[kind].verified = true
      channelPrefs[kind].enabled = true
      persistChannelPrefs(kind)
    }

    /** Per-channel enable/disable — invoked from the setup screen. Enabling a
     *  channel requires it to be verified first. */
    function setChannelEnabled(kind: ChannelKind, on: boolean) {
      if (on && !channelPrefs[kind].verified) {
        toast.error(`Verify the ${kind} connection before enabling it.`)
        return
      }
      channelPrefs[kind].enabled = on
      persistChannelPrefs(kind)
    }

    /** Master Channels on/off — the single title-bar toggle. */
    function setMasterEnabled(on: boolean) {
      masterEnabled.value = on
    }

    function toggleMaster() {
      setMasterEnabled(!masterEnabled.value)
    }

    /** Load tokens from safeStorage. Persisted Pinia state already carries
     *  `channelPrefs` (verified / identity / enabled); this rehydrates the
     *  in-memory secret config and back-fills identity when it is missing. */
    async function initConfig() {
      try {
        for (const kind of KINDS) {
          const cfg = await window.electronAPI.homeAgent.channel.loadConfig(kind)
          if (cfg) {
            channels[kind].config = { ...cfg, kind } as Partial<ChannelConfig>
            // Back-fill the prefs `.identity` from the saved config's identity
            // key (chatId / userId / …). The persisted Pinia state may already
            // carry it, but a migrated legacy config or an older persisted blob
            // without identity would otherwise leave it null — making the setup
            // wizard think no chat/DM partner exists even though the backend
            // has one.
            const idKey = CHANNEL_FIELD_SPEC[kind].identityField
            const savedIdentity = (cfg as Record<string, string>)[idKey]
            if (savedIdentity && !channelPrefs[kind].identity) {
              channelPrefs[kind].identity = savedIdentity
            }
          } else if (!channelPrefs[kind].verified) {
            channels[kind].config = {}
          }
          // Back-fill the durable setup flags from disk. This is what makes a
          // previously-verified channel survive a lost Pinia blob: the token +
          // identity already rehydrate from disk above, and verified/enabled
          // now come from the same durable file rather than only localStorage.
          // Disk wins when it has flags set, so a credential-change invalidation
          // (verified=false written to disk) can't be undone by a stale Pinia
          // value either.
          try {
            const prefs = await window.electronAPI.homeAgent.channel.loadPrefs(kind)
            if (prefs) {
              channelPrefs[kind].verified = prefs.verified
              channelPrefs[kind].enabled = prefs.enabled
            }
          } catch (e) {
            console.error(`channels.initConfig: loadPrefs(${kind}) failed:`, e)
          }
        }
      } catch (e) {
        console.error('channels.initConfig failed:', e)
      }
    }

    void initConfig()

    /** A Notifier reply on `kind`, spoken; a missing speech model is asked for there. */
    async function channelVoiceClip(
      kind: ChannelKind,
      text: string,
      replyTo?: string,
    ): Promise<SpeechClip | null> {
      const adapter = adapters[kind]
      if (!adapter) return null
      return remoteSpeech.voiceClip(adapter, text, replyTo ? { threadTs: replyTo } : undefined)
    }

    registerRemoteTurnPort({
      isActive: () => isRemoteTurnActive(),
      downloadModels: (models, options) => handleRemoteModelDownload(models, options),
      canAskChannelQuestion,
      askDownloadQuestion,
    })

    // ── Read-only convenience getters ───────────────────────────────────────
    // External consumers (setup composables, setup-step components) read these.
    // They are NOT used for persistence — `channelPrefs` is persisted directly.
    const telegramVerified = computed(() => channelPrefs.telegram.verified)
    const telegramChatId = computed(() => channelPrefs.telegram.identity ?? '')
    const slackVerified = computed(() => channelPrefs.slack.verified)
    const slackUserId = computed(() => channelPrefs.slack.identity ?? '')

    return {
      // Master title-bar switch + persisted per-channel prefs.
      masterEnabled,
      channelPrefs,
      notificationChannels,
      notificationsReady,
      // Runtime channel state map (secrets + derived `active`); in-memory only.
      channels,
      // Read-only per-kind convenience getters over channelPrefs.
      telegramVerified,
      telegramChatId,
      slackVerified,
      slackUserId,
      isAvailable,
      hasConfiguredChannel,
      // Channel-agnostic control surface
      setChannelEnabled,
      setMasterEnabled,
      toggleMaster,
      saveChannelConfig,
      clearChannelConfig,
      setVerified,
      channelVoiceClip,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      // Persist only non-secret state. `channelPrefs` (verified / identity /
      // enabled per kind) and `masterEnabled` drive activation on the next
      // launch; the secret `config` in `channels` is rehydrated from
      // safeStorage by initConfig() and never serialized here.
      pick: ['masterEnabled', 'channelPrefs'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeAllPollHandlers()
    for (const k of Object.keys(pollBusyByKind)) {
      pollBusyByKind[k as ChannelKind] = false
    }
  })
  import.meta.hot.accept(acceptHMRUpdate(useChannels, import.meta.hot))
}
