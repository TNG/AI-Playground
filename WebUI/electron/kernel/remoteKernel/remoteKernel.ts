import os from 'node:os'
import type { KernelEvent } from '@/types/kernelEvents'
import type {
  DiscoveredHost,
  PairingWindowInfo,
  RemoteKernelConfigUpdate,
  RemoteKernelMode,
  RemoteKernelPairRequest,
  RemoteKernelStatus,
} from '@/types/remoteKernelIpc'
import type { LocalSettings } from '../localSettings'
import type { ProtectedJsonFile } from '../../persist/remoteKernelSecrets'
import type { LanDiscovery } from '../../adapters/lanDiscovery'
import { setRemoteForwarder } from './dispatch'
import {
  pairWithHost,
  startRemoteKernelClient,
  type PairedTarget,
  type RemoteKernelClient,
} from './client'
import { startRemoteKernelHost, type RemoteKernelHost } from './host'
import { createDeviceRegistry, createPairing, type PairedDevice, type Pairing } from './pairing'
import { createTlsIdentity, type StoredIdentity, type TlsIdentity } from './tlsIdentity'

export type RemoteKernelDeps = {
  settings: () => LocalSettings
  persistSettings: () => void
  files: {
    tls: ProtectedJsonFile<StoredIdentity>
    devices: ProtectedJsonFile<PairedDevice[]>
    pairedHost: ProtectedJsonFile<PairedTarget>
  }
  discovery: LanDiscovery
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

const DISCOVERY_MS = 3000

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => !!entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry!.address)
}

export function createRemoteKernel(deps: RemoteKernelDeps) {
  const tlsIdentity = createTlsIdentity(deps.files.tls, `AI Playground on ${os.hostname()}`)
  const devices = createDeviceRegistry(deps.files.devices)
  let activeMode: RemoteKernelMode = 'off'
  let client: RemoteKernelClient | null = null
  let host: RemoteKernelHost | null = null
  let identity: TlsIdentity | null = null
  let pairing: Pairing | null = null
  let hostWiring: RemoteKernelHostWiring | null = null

  function advertise(): void {
    if (!host || !identity) return
    deps.discovery
      .advertise({
        port: host.port,
        name: os.hostname(),
        fingerprint: identity.fingerprint,
        pairingOpen: pairing?.isOpen() ?? false,
      })
      .catch((error) => deps.log(`mDNS advertise failed: ${String(error)}`, 'warn'))
  }

  /** Runs before the registries register: a thin client's remote rows become forwarders. */
  async function startClient(wiring: RemoteKernelClientWiring): Promise<boolean> {
    if (deps.settings().remoteKernelMode !== 'client') return false
    const target = deps.files.pairedHost.read()
    if (!target) {
      deps.log(
        'remote kernel client mode set without a paired workstation; running locally',
        'warn',
      )
      return false
    }
    client = await startRemoteKernelClient({ target, ...wiring, log: deps.log })
    setRemoteForwarder(client.forwarder)
    activeMode = 'client'
    deps.log(`remote kernel client → ${target.hostname} (${target.host}:${target.port})`)
    return true
  }

  async function listen(wiring: RemoteKernelHostWiring): Promise<void> {
    identity = await tlsIdentity.current()
    const current = identity
    pairing = createPairing({
      devices,
      fingerprint: async () => current.fingerprint,
      onChange: advertise,
    })
    host = await startRemoteKernelHost({
      port: deps.settings().remoteKernelHostPort,
      tls: current,
      devices,
      pairing,
      hostname: os.hostname(),
      ...wiring,
      log: deps.log,
    })
    activeMode = 'host'
    advertise()
  }

  async function startHost(wiring: RemoteKernelHostWiring): Promise<void> {
    if (deps.settings().remoteKernelMode !== 'host') return
    hostWiring = wiring
    try {
      await listen(wiring)
    } catch (error) {
      deps.log(`remote kernel host failed to start: ${String(error)}`, 'error')
    }
  }

  function requireHost(): Pairing {
    if (!host || !pairing) throw new Error('Restart in workstation mode to pair devices')
    return pairing
  }

  function status(): RemoteKernelStatus {
    const s = deps.settings()
    const clientState = client?.status()
    const paired = deps.files.pairedHost.read()
    return {
      activeMode,
      configuredMode: s.remoteKernelMode,
      hostPort: s.remoteKernelHostPort,
      hostAddresses: lanAddresses(),
      hostFingerprint: identity?.fingerprint,
      hostPeers: host?.peerCount() ?? 0,
      pairing: pairing?.state() ?? null,
      devices: devices.list(),
      pairedHost: paired
        ? {
            host: paired.host,
            port: paired.port,
            hostname: paired.hostname,
            fingerprint: paired.fingerprint,
          }
        : null,
      connection: clientState?.connection ?? 'off',
      remoteHostname: clientState?.remoteHostname,
      lastError: clientState?.lastError,
    }
  }

  function saveConfig(update: RemoteKernelConfigUpdate): void {
    const s = deps.settings()
    s.remoteKernelMode = update.mode
    if (update.hostPort !== undefined) s.remoteKernelHostPort = update.hostPort
    deps.persistSettings()
  }

  return {
    startClient,
    startHost,
    status,
    saveConfig,
    openPairing: (): Promise<PairingWindowInfo> => requireHost().open(),
    closePairing: (): void => pairing?.close(),
    revokeDevice(id: string): boolean {
      const revoked = devices.revoke(id)
      host?.disconnectDevice(id)
      return revoked
    },
    /** New certificate, no paired devices: every client has to pair again. */
    async resetPairing(): Promise<void> {
      for (const device of devices.list()) host?.disconnectDevice(device.id)
      devices.clear()
      pairing?.close()
      await tlsIdentity.rotate()
      if (host && hostWiring) {
        await host.close()
        host = null
        await listen(hostWiring)
      }
    },
    discover: (): Promise<DiscoveredHost[]> => deps.discovery.browse(DISCOVERY_MS),
    async pair(request: RemoteKernelPairRequest): Promise<string> {
      const previous = deps.files.pairedHost.read()
      const target = await pairWithHost({
        host: request.host.trim(),
        port: request.port,
        code: request.code.trim(),
        deviceName: os.hostname(),
        deviceId: previous?.deviceId,
      })
      deps.files.pairedHost.write(target)
      return target.hostname
    },
    forgetHost: (): void => deps.files.pairedHost.remove(),
    isClient: () => activeMode === 'client',
    fetchMedia: (request: Request) => client?.fetchMedia(request) ?? null,
    close: async () => {
      client?.close()
      pairing?.close()
      await host?.close()
      await deps.discovery.stop()
    },
  }
}

export type RemoteKernel = ReturnType<typeof createRemoteKernel>
