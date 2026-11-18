import os from 'node:os'
import type { KernelEvent } from '@/types/kernelEvents'
import type {
  RemoteKernelConfigUpdate,
  RemoteKernelMode,
  RemoteKernelStatus,
  RemoteKernelTarget,
} from '@/types/remoteKernelIpc'
import type { LocalSettings } from '../localSettings'
import type { RemoteKernelSecrets } from '../../persist/remoteKernelSecrets'
import { setRemoteForwarder } from './dispatch'
import { probeRemoteKernel, startRemoteKernelClient, type RemoteKernelClient } from './client'
import { startRemoteKernelHost, type RemoteKernelHost } from './host'

export type RemoteKernelDeps = {
  settings: () => LocalSettings
  persistSettings: () => void
  secrets: RemoteKernelSecrets
  log: (message: string, level?: 'info' | 'warn' | 'error') => void
}

export type RemoteKernelClientWiring = {
  relayKernelEvent: (event: KernelEvent) => void
  deliverPush: (channel: string, payload: unknown) => void
  rehydrate: () => void
}

export type RemoteKernelHostWiring = {
  sender: () => unknown
  resolveMediaPath: (url: string) => string | null
  onKernelEvent: (tap: (event: KernelEvent) => void) => () => void
}

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => !!entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry!.address)
}

export function createRemoteKernel(deps: RemoteKernelDeps) {
  let activeMode: RemoteKernelMode = 'off'
  let client: RemoteKernelClient | null = null
  let host: RemoteKernelHost | null = null

  function clientTarget(): RemoteKernelTarget | null {
    const s = deps.settings()
    const token = deps.secrets.read('clientToken')
    if (!s.remoteKernelClientHost || !token) return null
    return { host: s.remoteKernelClientHost, port: s.remoteKernelClientPort, token }
  }

  /** Runs before the registries register: a thin client's remote rows become forwarders. */
  async function startClient(wiring: RemoteKernelClientWiring): Promise<boolean> {
    if (deps.settings().remoteKernelMode !== 'client') return false
    const target = clientTarget()
    if (!target) {
      deps.log('remote kernel client mode set without a host or token; running locally', 'warn')
      return false
    }
    client = await startRemoteKernelClient({ target, ...wiring, log: deps.log })
    setRemoteForwarder(client.forwarder)
    activeMode = 'client'
    deps.log(`remote kernel client → ${target.host}:${target.port}`)
    return true
  }

  async function startHost(wiring: RemoteKernelHostWiring): Promise<void> {
    if (deps.settings().remoteKernelMode !== 'host') return
    try {
      host = await startRemoteKernelHost({
        port: deps.settings().remoteKernelHostPort,
        token: deps.secrets.hostToken,
        hostname: os.hostname(),
        ...wiring,
        log: deps.log,
      })
      activeMode = 'host'
    } catch (error) {
      deps.log(`remote kernel host failed to start: ${String(error)}`, 'error')
    }
  }

  function status(): RemoteKernelStatus {
    const s = deps.settings()
    const clientState = client?.status()
    return {
      activeMode,
      configuredMode: s.remoteKernelMode,
      hostPort: s.remoteKernelHostPort,
      hostToken: s.remoteKernelMode === 'host' || activeMode === 'host' ? deps.secrets.hostToken() : '',
      hostAddresses: lanAddresses(),
      hostPeers: host?.peerCount() ?? 0,
      clientHost: s.remoteKernelClientHost,
      clientPort: s.remoteKernelClientPort,
      clientHasToken: !!deps.secrets.read('clientToken'),
      connection: clientState?.connection ?? 'off',
      remoteHostname: clientState?.remoteHostname,
      lastError: clientState?.lastError,
    }
  }

  function saveConfig(update: RemoteKernelConfigUpdate): void {
    const s = deps.settings()
    s.remoteKernelMode = update.mode
    if (update.hostPort !== undefined) s.remoteKernelHostPort = update.hostPort
    if (update.clientHost !== undefined) s.remoteKernelClientHost = update.clientHost.trim()
    if (update.clientPort !== undefined) s.remoteKernelClientPort = update.clientPort
    if (update.clientToken) deps.secrets.write('clientToken', update.clientToken.trim())
    if (update.mode === 'host') deps.secrets.hostToken()
    deps.persistSettings()
  }

  return {
    startClient,
    startHost,
    status,
    saveConfig,
    regenerateToken: () => deps.secrets.regenerateHostToken(),
    testConnection: (target: RemoteKernelTarget) => probeRemoteKernel(target),
    isClient: () => activeMode === 'client',
    fetchMedia: (request: Request) => client?.fetchMedia(request) ?? null,
    close: async () => {
      client?.close()
      await host?.close()
    },
  }
}

export type RemoteKernel = ReturnType<typeof createRemoteKernel>
