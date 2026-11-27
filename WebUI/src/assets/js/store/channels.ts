import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, reactive, computed, watch } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { useConfirmations } from './confirmations'
import { useGlobalSetup } from './globalSetup'
import { useModels } from './models'
import { fetchModelMeta } from '@/lib/modelDownloader'
import type { IpcMutationResult } from '@/types/ipcChannels'
import type { ChannelsLegacyState, ChannelsState } from '@/types/channelHostIpc'
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
import type {
  ChannelConfig,
  ChannelKind,
  ChannelPrefs,
  ChannelRuntimeState,
  InboundMeta,
  RemoteAudio,
} from './channels/types'
import type { ChannelAdapter } from './channels/adapter'
import type { InboundChannelMessage } from './channels/answerRouter'
import { createAppError } from '../errors/appError'
import { useErrors } from './errors'
import { connectKernelEventStream } from '../projection/kernelProjection'
import { createTelegramAdapter } from './channels/telegramAdapter'
import { createSlackAdapter } from './channels/slackAdapter'
import { createLocalWebAdapter } from './channels/localWebAdapter'
import { createChannelQuestionRegistry } from './channels/channelQuestions'
import { channelQuestionNote, createChannelDownloadConsent } from './channels/downloadConsent'
import { CHANNELS } from './channels/channelRegistry'
import { createRemoteSpeech, type SpeechClip } from './channels/remoteSpeech'
import { closeDownloadMessages } from './channels/headlessDownload'
import { channelQuestionTemplates } from '@/lib/channelQuestionWording'
import { registerRemoteTurnPort } from '@/assets/js/permissions/remoteTurnPort'
import { requestDownloadConsent } from '@/assets/js/permissions/permissions'

// Read when called, never at import: the registry's setup composables import this store.
const channelKinds = (): ChannelKind[] => CHANNELS.map((channel) => channel.kind)

function emptyRuntimeState(kind: ChannelKind): ChannelRuntimeState {
  return { kind, config: {}, active: false }
}

function emptyPrefs(): ChannelPrefs {
  return { verified: false, identity: null, enabled: false }
}

// The switch and prefs this window kept before the kernel did; handed to main once.
const LEGACY_STORAGE_KEY = 'channels'
const LEGACY_HOME_AGENT_KEY = 'homeAgent'

function legacyState(): ChannelsLegacyState | null {
  try {
    const raw = demoAwareStorage.getItem(LEGACY_STORAGE_KEY)
    const stored = raw
      ? (JSON.parse(raw) as {
          masterEnabled?: unknown
          channelPrefs?: ChannelsLegacyState['prefs']
        })
      : null
    const homeAgentRaw = demoAwareStorage.getItem(LEGACY_HOME_AGENT_KEY)
    const homeAgentMaster = homeAgentRaw
      ? (JSON.parse(homeAgentRaw) as { masterEnabled?: unknown }).masterEnabled
      : undefined
    const master = stored?.masterEnabled ?? homeAgentMaster
    if (typeof master !== 'boolean' && !stored?.channelPrefs) return null
    return {
      masterEnabled: typeof master === 'boolean' ? master : true,
      prefs: stored?.channelPrefs ?? {},
    }
  } catch {
    return null
  }
}

/**
 * The Channels as this window shows them. The kernel reads and routes every message and owns
 * the switch and each Channel's setup; this window projects that, and keeps what only a window
 * can do for a Channel turn it runs: the speech engine and the download questions.
 */
export const useChannels = defineStore('channels', () => {
  const conversations = useConversations()
  const confirmations = useConfirmations()
  const errors = useErrors()
  const globalSetup = useGlobalSetup()
  const models = useModels()

  const masterEnabled = ref(true)
  const isAvailable = ref(false)
  const channelPrefs = reactive<Record<ChannelKind, ChannelPrefs>>({
    telegram: emptyPrefs(),
    slack: emptyPrefs(),
    discord: emptyPrefs(),
    'local-web': emptyPrefs(),
  })
  // Secrets stay out of the kernel stream; the setup screens read them from the saved config.
  const channels = reactive<Record<ChannelKind, ChannelRuntimeState>>({
    telegram: emptyRuntimeState('telegram'),
    slack: emptyRuntimeState('slack'),
    discord: emptyRuntimeState('discord'),
    'local-web': emptyRuntimeState('local-web'),
  })

  function apply(state: ChannelsState | null | undefined): void {
    if (!state) return
    masterEnabled.value = state.masterEnabled
    isAvailable.value = state.available
    for (const kind of channelKinds()) {
      Object.assign(channelPrefs[kind], state.prefs[kind] ?? emptyPrefs())
      channels[kind].active = state.active[kind] ?? false
    }
  }

  const projection = connectKernelEventStream(
    (event) => {
      if (event.type === 'channels-state') apply(event.state)
    },
    (snapshot) => apply(snapshot.state.channels),
  )
  projection.ready.catch((reason: unknown) => reportSilently('channels: no snapshot', reason))
  if (import.meta.hot) import.meta.hot.dispose(() => projection.dispose())

  // Download and speech messages for a turn this window runs go out from here.
  const adapters: Record<ChannelKind, ChannelAdapter | null> = {
    telegram: createTelegramAdapter(),
    slack: createSlackAdapter(),
    discord: null,
    'local-web': createLocalWebAdapter(),
  }

  const openQuestions = ref(0)
  const channelQuestions = createChannelQuestionRegistry({
    staleReply: () => channelQuestionTemplates().stale,
    onChange: () => openQuestions.value++,
  })
  const typedQuestionKinds = computed(() => {
    void openQuestions.value
    return channelQuestions.typedKinds()
  })

  const downloadConsent = createChannelDownloadConsent({
    questions: channelQuestions,
    confirmations,
    adapterFor: (kind) => adapters[kind],
    channels: () => notificationChannels.value,
    conversationKey: () => conversations.activeKey,
    modelMeta: (list) =>
      fetchModelMeta(list, { apiHost: globalSetup.apiHost, hfToken: models.hfToken }),
    log: (message, error) => reportSilently(message, error),
  })
  const { withRemoteTurn } = downloadConsent

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
      download: (list, adapter, meta) =>
        withRemoteTurn({ adapter, meta }, () => requestDownloadConsent(list)),
    },
    synthesisModel: {
      missing: synthesisModelMissing,
      install: (adapter, meta) => withRemoteTurn({ adapter, meta }, installSynthesisModel),
    },
    log: (message, error) => reportSilently(message, error),
  })

  const hasConfiguredChannel = computed(() => channelKinds().some((k) => channelPrefs[k].verified))

  /** Where a Reachable Session's Notifications and Channel Questions go; empty while off. */
  const notificationChannels = computed(() =>
    channelKinds().filter((kind) => channels[kind].active && adapters[kind] !== null),
  )
  const notificationsReady = computed(() => notificationChannels.value.length > 0)

  function reportSilently(message: string, error: unknown): void {
    errors.report(error, { surface: 'silent', technicalMessage: message })
  }

  function adapterOf(kind: ChannelKind): ChannelAdapter {
    const adapter = adapters[kind]
    if (!adapter) throw new Error(`No ${kind} channel in this build`)
    return adapter
  }

  // A channel the user left must not download anything; the desktop keeps asking.
  watch(notificationChannels, (kinds) =>
    channelQuestions.retireOutside(kinds, channelQuestionNote('unavailable')),
  )

  window.addEventListener('beforeunload', () => {
    closeDownloadMessages(channelQuestionTemplates().appClosed)
    channelQuestions.retireOutside([], channelQuestionNote('closed'))
  })

  function failed(result: IpcMutationResult, what: string): IpcMutationResult {
    if (!result.success) reportSilently(`channels: ${what} failed:`, new Error(result.error))
    return result
  }

  async function saveChannelConfig(
    kind: ChannelKind,
    config: Partial<ChannelConfig>,
  ): Promise<IpcMutationResult> {
    try {
      const result = await window.electronAPI.channelHost.saveConfig(
        kind,
        config as Record<string, string>,
      )
      if (result.success) channels[kind].config = { ...config }
      return result
    } catch (e) {
      reportSilently(`channels.saveChannelConfig(${kind}) failed:`, e)
      return { success: false as const, error: String(e) }
    }
  }

  async function clearChannelConfig(kind: ChannelKind): Promise<void> {
    try {
      failed(await window.electronAPI.channelHost.clearConfig(kind), `clearConfig(${kind})`)
    } catch (e) {
      reportSilently(`channels.clearChannelConfig(${kind}) failed:`, e)
    }
    channels[kind].config = {}
  }

  /** A successful test: the Channel defaults to enabled, so it starts running (switch permitting). */
  function setVerified(kind: ChannelKind): void {
    channelPrefs[kind].verified = true
    channelPrefs[kind].enabled = true
    void window.electronAPI.channelHost
      .setVerified(kind)
      .then((result) => failed(result, `setVerified(${kind})`))
      .catch((e: unknown) => reportSilently(`channels.setVerified(${kind}) failed:`, e))
  }

  function setChannelEnabled(kind: ChannelKind, on: boolean): void {
    if (on && !channelPrefs[kind].verified) {
      const userMessage = `Verify the ${kind} connection before enabling it.`
      errors.report(
        createAppError({
          category: 'validation',
          code: 'channels/not-verified',
          severity: 'warning',
          surface: 'toast',
          userMessage,
          technicalMessage: userMessage,
        }),
      )
      return
    }
    channelPrefs[kind].enabled = on
    void window.electronAPI.channelHost
      .setEnabled(kind, on)
      .then((result) => failed(result, `setEnabled(${kind})`))
      .catch((e: unknown) => reportSilently(`channels.setChannelEnabled(${kind}) failed:`, e))
  }

  /** Master Channels on/off — the single title-bar toggle. */
  function setMasterEnabled(on: boolean): void {
    masterEnabled.value = on
    void window.electronAPI.channelHost
      .setMaster(on)
      .then((result) => failed(result, 'setMaster'))
      .catch((e: unknown) => reportSilently('channels.setMasterEnabled failed:', e))
  }

  function toggleMaster(): void {
    setMasterEnabled(!masterEnabled.value)
  }

  /** The kernel's state, the legacy copy handed over once, and the saved secrets for the forms. */
  async function init(): Promise<void> {
    try {
      const legacy = legacyState()
      if (legacy) {
        await window.electronAPI.channelHost.migrate(legacy)
        demoAwareStorage.removeItem(LEGACY_STORAGE_KEY)
      }
      apply(await window.electronAPI.channelHost.getState())
      for (const kind of channelKinds()) {
        const cfg = await window.electronAPI.channels.loadConfig(kind)
        channels[kind].config = cfg ? ({ ...cfg, kind } as Partial<ChannelConfig>) : {}
      }
    } catch (e) {
      reportSilently('channels.init failed:', e)
    }
  }

  void init()

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

  /** The kernel's router asks this window for what only its stores and engines can do. */
  const windowServices = {
    typedQuestionKinds: () => typedQuestionKinds.value,
    answerQuestion: (kind: ChannelKind, msg: InboundChannelMessage, meta?: InboundMeta) =>
      channelQuestions.handleInbound(adapterOf(kind), msg, meta),
    prepareVoice: (kind: ChannelKind, meta?: InboundMeta) =>
      remoteSpeech.prepare(adapterOf(kind), meta),
    transcribeVoice: (kind: ChannelKind, audio: RemoteAudio[], meta?: InboundMeta) =>
      remoteSpeech.transcribe(adapterOf(kind), audio, meta),
  }

  registerRemoteTurnPort({
    isActive: () => downloadConsent.isRemoteTurnActive(),
    downloadModels: (list, options) => downloadConsent.handleRemoteModelDownload(list, options),
    canAskChannelQuestion: () => notificationsReady.value,
    askDownloadQuestion: downloadConsent.askDownloadQuestion,
  })

  const telegramVerified = computed(() => channelPrefs.telegram.verified)
  const telegramChatId = computed(() => channelPrefs.telegram.identity ?? '')
  const slackVerified = computed(() => channelPrefs.slack.verified)
  const slackUserId = computed(() => channelPrefs.slack.identity ?? '')

  return {
    masterEnabled,
    channelPrefs,
    notificationChannels,
    notificationsReady,
    channels,
    telegramVerified,
    telegramChatId,
    slackVerified,
    slackUserId,
    isAvailable,
    hasConfiguredChannel,
    setChannelEnabled,
    setMasterEnabled,
    toggleMaster,
    saveChannelConfig,
    clearChannelConfig,
    setVerified,
    channelVoiceClip,
    windowServices,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChannels, import.meta.hot))
}
