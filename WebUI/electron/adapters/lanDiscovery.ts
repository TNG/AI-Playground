import { Bonjour, type Service } from 'bonjour-service'
import type { DiscoveredHost } from '@/types/remoteKernelIpc'

// mDNS / DNS-SD for the remote kernel: a workstation in host mode advertises `_aipg-kernel._tcp`,
// a thin client browses for it. What is advertised is unauthenticated — trust comes from
// pairing — so the fingerprint is only a hint the user can compare.

export const SERVICE_TYPE = 'aipg-kernel'

export type Advertisement = {
  port: number
  name: string
  fingerprint: string
  pairingOpen: boolean
}

export type ServiceTxt = Record<string, string>

export function encodeTxt(ad: Advertisement): ServiceTxt {
  return {
    v: '1',
    name: ad.name.slice(0, 63),
    fp: ad.fingerprint.slice(0, 16),
    pairing: ad.pairingOpen ? '1' : '0',
  }
}

export function parseService(service: {
  name?: string
  host?: string
  port?: number
  addresses?: string[]
  referer?: { address?: string }
  txt?: unknown
}): DiscoveredHost | null {
  const txt = (service.txt ?? {}) as Record<string, unknown>
  const text = (key: string) => {
    const value = txt[key]
    return typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString() : ''
  }
  if (text('v') !== '1' || !service.port) return null
  const ipv4 = (service.addresses ?? []).filter((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address))
  const addresses =
    ipv4.length > 0 ? ipv4 : service.referer?.address ? [service.referer.address] : []
  if (addresses.length === 0) return null
  return {
    name: text('name') || service.name || service.host || addresses[0],
    hostname: service.host ?? '',
    addresses,
    port: service.port,
    fingerprintHint: text('fp'),
    pairingOpen: text('pairing') === '1',
  }
}

export function createLanDiscovery(log: (message: string, level?: 'info' | 'warn') => void) {
  let bonjour: Bonjour | null = null
  let published: Service | null = null

  function instance(): Bonjour {
    bonjour ??= new Bonjour(undefined, (error: unknown) =>
      log(`mDNS error: ${String(error)}`, 'warn'),
    )
    return bonjour
  }

  function unpublish(): Promise<void> {
    const service = published
    published = null
    if (!service) return Promise.resolve()
    return new Promise((resolve) => service.stop?.(() => resolve()))
  }

  return {
    /** Publish (or re-publish with a new TXT record) this workstation. */
    async advertise(ad: Advertisement): Promise<void> {
      await unpublish()
      published = instance().publish({
        name: ad.name,
        type: SERVICE_TYPE,
        port: ad.port,
        txt: encodeTxt(ad),
        probe: false,
      })
      published.on('error', (error: unknown) =>
        log(`mDNS publish failed: ${String(error)}`, 'warn'),
      )
    },

    /** Listen for workstations for `timeoutMs` and return what answered. */
    browse(timeoutMs: number): Promise<DiscoveredHost[]> {
      return new Promise((resolve) => {
        const found = new Map<string, DiscoveredHost>()
        const browser = instance().find({ type: SERVICE_TYPE }, (service) => {
          const host = parseService(service)
          if (host) found.set(`${host.addresses[0]}:${host.port}`, host)
        })
        setTimeout(() => {
          browser.stop()
          resolve([...found.values()])
        }, timeoutMs)
      })
    },

    async stop(): Promise<void> {
      await unpublish()
      bonjour?.destroy()
      bonjour = null
    },
  }
}

export type LanDiscovery = ReturnType<typeof createLanDiscovery>
