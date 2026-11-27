import type { BrowserWindow } from 'electron'
import { setChannelTransport, type ChannelSend } from '@/assets/js/store/channels/channelTransport'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { ChannelInboundMessage } from '@/types/channelIpc'
import { emitChannelQueues, emitChannelsState, onKernelEvent } from '../kernel/kernelBus'
import { typedSend } from '../kernel/typedIpc'
import { channelMessageOwner, recordStartPromptRequest } from '../persist/channelMessageMap'
import { readPreferenceSection, writePreferenceSection } from '../persist/preferencesFile'
import { appLoggerInstance } from '../observability/logger'
import { createChannelHost, type ChannelHost } from './channelHost'
import { createChannelState, type ChannelStateHost, type ChannelStore } from './channelState'
import { createWindowPort, type WindowPort } from './windowPort'

const SCOPE = 'channels'
const HOME_AGENT_SERVICE = 'home-agent-backend'

/** What the Channels need of the Home Agent backend; absent when the feature is not built in. */
export type ChannelBackend = ChannelStore & {
  poll: (kind: ChannelKind) => Promise<ChannelInboundMessage[]>
  send: ChannelSend
  running: () => boolean
}

export type ChannelsKernel = {
  state: ChannelStateHost
  host: ChannelHost
  windowPort: WindowPort
  /** Starts the dispatcher; only the machine whose backend fields the Channels calls it. */
  start: () => Promise<void>
  stop: () => void
}

const NO_BACKEND: ChannelBackend = {
  loadConfig: () => null,
  saveConfig: () => ({ success: false, error: 'Channels are not available' }),
  clearConfig: () => {},
  loadPrefs: () => null,
  savePrefs: () => ({ success: true }),
  inject: async () => ({ status: 'not_running' }),
  poll: async () => [],
  send: async () => ({ success: false, error: 'Channels are not available' }),
  running: () => false,
}

function log(message: string, error?: unknown): void {
  appLoggerInstance.warn(error === undefined ? message : `${message} ${String(error)}`, SCOPE)
}

export function createChannelsKernel(deps: {
  /** Read on use: the backend exists only once the service registry is up. */
  backend: () => ChannelBackend | null
  window: () => BrowserWindow | null
}): ChannelsKernel {
  const current = () => deps.backend() ?? NO_BACKEND
  const backend: ChannelBackend = {
    loadConfig: (kind) => current().loadConfig(kind),
    saveConfig: (kind, config) => current().saveConfig(kind, config),
    clearConfig: (kind) => current().clearConfig(kind),
    loadPrefs: (kind) => current().loadPrefs(kind),
    savePrefs: (kind, prefs) => current().savePrefs(kind, prefs),
    inject: (kind, config) => current().inject(kind, config),
    poll: (kind) => current().poll(kind),
    send: (kind, action, payload) => current().send(kind, action, payload),
    running: () => current().running(),
  }
  const state = createChannelState({
    store: backend,
    readMaster: async () => {
      const section = (await readPreferenceSection('channels')) as {
        masterEnabled?: unknown
      } | null
      return typeof section?.masterEnabled === 'boolean' ? section.masterEnabled : null
    },
    writeMaster: (on) => writePreferenceSection('channels', { masterEnabled: on }),
    log,
  })
  const windowPort = createWindowPort({
    post: (ask) => {
      const win = deps.window()
      if (!win || win.isDestroyed()) return false
      typedSend(win.webContents, 'channelHost:portAsk', ask)
      return true
    },
    lookup: (kind, ref) =>
      channelMessageOwner(kind, ref).catch((error: unknown) => {
        log('channels: message lookup failed:', error)
        return null
      }),
    recordStartPromptRequest: (kind, ref) =>
      recordStartPromptRequest(kind, ref).catch((error: unknown) =>
        log('channels: recording a Start Prompt Request failed:', error),
      ),
    log,
  })
  const host = createChannelHost({
    poll: backend.poll,
    state,
    windowPort,
    readPointers: async () => {
      const section = (await readPreferenceSection('channelSessions')) as {
        pointers?: Partial<Record<ChannelKind, string>>
      } | null
      return section?.pointers ?? {}
    },
    writePointers: (pointers) => writePreferenceSection('channelSessions', { pointers }),
    publishQueues: emitChannelQueues,
    log,
  })
  let stopTap: (() => void) | null = null
  let stopState: (() => void) | null = null

  return {
    state,
    host,
    windowPort,
    start: async () => {
      setChannelTransport(backend.send)
      stopState = state.onChange(emitChannelsState)
      stopTap = onKernelEvent((event) => {
        if (event.type !== 'service') return
        const info = event.info as { serviceName?: string; status?: string }
        if (info?.serviceName === HOME_AGENT_SERVICE) state.setAvailable(info.status === 'running')
      })
      await state.init()
      state.setAvailable(backend.running())
      await host.start()
    },
    stop: () => {
      host.stop()
      stopTap?.()
      stopState?.()
    },
  }
}
