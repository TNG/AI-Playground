import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import getPort, { portNumbers } from 'get-port'
import type { WebContents } from 'electron'
import type { KernelEvent } from '@/types/kernelEvents'
import type { ProtectedJsonFile } from '../../../persist/remoteKernelSecrets'
import {
  recordInvokeHandler,
  recordSendHandler,
  resetRemoteDispatchForTest,
} from '../../../kernel/remoteKernel/dispatch'
import { startRemoteKernelHost, type RemoteKernelHost } from '../../../kernel/remoteKernel/host'
import {
  pairWithHost,
  startRemoteKernelClient,
  type PairedTarget,
  type RemoteKernelClient,
} from '../../../kernel/remoteKernel/client'
import {
  PAIRING_ATTEMPTS,
  PAIRING_WINDOW_MS,
  createDeviceRegistry,
  createPairing,
  type DeviceRegistry,
  type PairedDevice,
  type Pairing,
} from '../../../kernel/remoteKernel/pairing'
import {
  createTlsIdentity,
  type StoredIdentity,
  type TlsIdentity,
} from '../../../kernel/remoteKernel/tlsIdentity'
import { deliverPush, resetRendererSinksForTest } from '../../../kernel/rendererSinks'

function memoryFile<T>(initial: T | null = null): ProtectedJsonFile<T> {
  let value = initial
  return {
    read: () => value,
    write: (next) => {
      value = next
    },
    remove: () => {
      value = null
    },
  }
}

let identity: TlsIdentity
let otherIdentity: TlsIdentity
let host: RemoteKernelHost
let devices: DeviceRegistry
let pairing: Pairing
let clock = Date.now()
let client: RemoteKernelClient | null = null
let upstream: http.Server | null = null
let mediaFile: string
const taps = new Set<(event: KernelEvent) => void>()
const relayed: KernelEvent[] = []
const pushes: { channel: string; payload: unknown }[] = []
const rehydrate = vi.fn()

function emitKernelEvent(seq: number): void {
  for (const tap of taps) tap({ type: 'activity', seq, scope: { kind: 'global' } } as never)
}

async function startHost(tls: TlsIdentity, port = 0): Promise<RemoteKernelHost> {
  return startRemoteKernelHost({
    port,
    tls,
    devices,
    pairing,
    hostname: 'workstation-1',
    sender: () => ({ id: 'window' }),
    resolveMediaPath: (url) => (url === 'aipg-media://media/a.png' ? mediaFile : null),
    onKernelEvent: (tap) => {
      taps.add(tap)
      return () => taps.delete(tap)
    },
    log: () => {},
  })
}

async function pair(code?: string): Promise<PairedTarget> {
  const window = code ? null : await pairing.open()
  return pairWithHost({
    host: '127.0.0.1',
    port: host.port,
    code: code ?? window!.code,
    deviceName: 'laptop',
  })
}

async function connectClient(target: PairedTarget): Promise<RemoteKernelClient> {
  client = await startRemoteKernelClient({
    target,
    relayKernelEvent: (event) => relayed.push(event),
    deliverPush: (channel, payload) => pushes.push({ channel, payload }),
    rehydrate,
    log: () => {},
  })
  return client
}

function wrongCode(right: string): string {
  return right === '0000' ? '0001' : '0000'
}

beforeAll(async () => {
  identity = await createTlsIdentity(memoryFile<StoredIdentity>(), 'test host').current()
  otherIdentity = await createTlsIdentity(memoryFile<StoredIdentity>(), 'impostor').current()
})

beforeEach(async () => {
  resetRemoteDispatchForTest()
  resetRendererSinksForTest()
  relayed.length = 0
  pushes.length = 0
  rehydrate.mockClear()
  clock = Date.now()
  mediaFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-remote-')), 'a.png')
  fs.writeFileSync(mediaFile, Buffer.from([10, 11, 12, 13, 14]))
  devices = createDeviceRegistry(memoryFile<PairedDevice[]>())
  pairing = createPairing({
    devices,
    fingerprint: async () => identity.fingerprint,
    onChange: () => {},
    now: () => clock,
  })
  host = await startHost(identity)
})

afterEach(async () => {
  client?.close()
  client = null
  upstream?.close()
  upstream = null
  pairing.close()
  await host.close()
  taps.clear()
})

describe('remote kernel pairing', () => {
  it('pairs with the code the workstation shows and pins its certificate', async () => {
    const target = await pair()
    expect(target.fingerprint).toBe(identity.fingerprint)
    expect(target.hostname).toBe('workstation-1')
    expect(devices.list().map((device) => device.name)).toEqual(['laptop'])
    expect(devices.authenticate(target.token)?.id).toBe(target.deviceId)
    expect(pairing.isOpen()).toBe(false)
  })

  it('refuses a wrong code and closes after the last attempt', async () => {
    const { code } = await pairing.open()
    for (let attempt = 0; attempt < PAIRING_ATTEMPTS; attempt++) {
      await expect(pair(wrongCode(code))).rejects.toThrow('did not match')
    }
    await expect(pair(code)).rejects.toThrow('No pairing attempts left')
    expect(devices.list()).toEqual([])
  })

  it('refuses pairing outside an open window, and once the window has expired', async () => {
    await expect(pair('1234')).rejects.toThrow('No pairing window is open')
    const { code } = await pairing.open()
    clock += PAIRING_WINDOW_MS + 1
    await expect(pair(code)).rejects.toThrow('No pairing window is open')
  })

  it('rejects a workstation whose certificate changed after pairing', async () => {
    const target = await pair()
    const port = host.port
    await host.close()
    host = await startHost(otherIdentity, port)
    recordInvokeHandler('getServices', (() => []) as never)
    const remote = await connectClient(target)
    await expect(remote.forwarder.invoke('getServices', [])).rejects.toThrow(
      'does not match the paired one',
    )
  })

  it('cuts off a revoked device', async () => {
    recordInvokeHandler('getServices', (() => []) as never)
    const target = await pair()
    const remote = await connectClient(target)
    await vi.waitFor(() => expect(remote.status().connection).toBe('connected'))
    devices.revoke(target.deviceId)
    host.disconnectDevice(target.deviceId)
    await vi.waitFor(() => expect(remote.status().connection).toBe('disconnected'))
    await expect(remote.forwarder.invoke('getServices', [])).rejects.toThrow('Unauthorized')
    await vi.waitFor(
      () => expect(remote.status().lastError).toBe('This device is no longer paired'),
      { timeout: 5000 },
    )
  })
})

describe('remote kernel host + client over pinned TLS', () => {
  it('runs a remote-routed invoke through the recorded handler, bytes and all', async () => {
    const seen: unknown[] = []
    recordInvokeHandler('agentMode:importAttachment', ((
      event: { sender: unknown },
      dir: string,
      name: string,
      bytes: Uint8Array,
    ) => {
      seen.push(event.sender)
      return { success: true, path: `${dir}/${name}`, size: bytes.length }
    }) as never)
    const { forwarder } = await connectClient(await pair())
    const result = await forwarder.invoke('agentMode:importAttachment', [
      '/games/x',
      'sprite.png',
      new Uint8Array([1, 2, 3]),
    ])
    expect(result).toEqual({ success: true, path: '/games/x/sprite.png', size: 3 })
    expect(seen).toEqual([{ id: 'window' }])
  })

  it('refuses a local-routed channel and surfaces handler errors as rejections', async () => {
    recordInvokeHandler('showOpenDialog', (() => ({ canceled: true, filePaths: [] })) as never)
    recordInvokeHandler('getServices', (() => {
      throw new Error('registry not ready')
    }) as never)
    const { forwarder } = await connectClient(await pair())
    await expect(forwarder.invoke('showOpenDialog', [{}])).rejects.toThrow(/not served remotely/)
    await expect(forwarder.invoke('getServices', [])).rejects.toThrow('registry not ready')
  })

  it('dispatches send rows', async () => {
    const listener = vi.fn()
    recordSendHandler('permissions:awaitingUser', listener as never)
    const { forwarder } = await connectClient(await pair())
    forwarder.send('permissions:awaitingUser', [{ conversationKey: 'c1', waiting: true }])
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
    expect(listener.mock.calls[0][1]).toEqual({ conversationKey: 'c1', waiting: true })
  })

  it('streams kernel events and routes pushes to the peer that drives the turn', async () => {
    recordInvokeHandler('chat:submitTurn', (() => ({ success: true })) as never)
    const remote = await connectClient(await pair())
    await vi.waitFor(() => expect(remote.status().connection).toBe('connected'))
    expect(host.peerCount()).toBe(1)

    emitKernelEvent(7)
    await vi.waitFor(() => expect(relayed.map((event) => event.seq)).toEqual([7]))

    const windowSend = vi.fn()
    const sender = { send: windowSend, isDestroyed: () => false } as unknown as WebContents
    deliverPush(sender, 'permissions:prompt', { requestId: 'p1' } as never)
    await vi.waitFor(() => expect(pushes).toHaveLength(1))
    expect(windowSend).toHaveBeenCalledTimes(1)

    await remote.forwarder.invoke('chat:submitTurn', [{}])
    deliverPush(sender, 'chat:ask', { requestId: 'q1' } as never)
    await vi.waitFor(() => expect(pushes).toHaveLength(2))
    expect(pushes[1]).toEqual({ channel: 'chat:ask', payload: { requestId: 'q1' } })
    expect(windowSend).toHaveBeenCalledTimes(1)
  })

  it("rewrites the workstation's loopback service URLs onto a tunnel that reaches them", async () => {
    const upstreamPort = await getPort({ port: portNumbers(59500, 59999) })
    const seenHeaders: http.IncomingHttpHeaders[] = []
    upstream = http.createServer((req, res) => {
      seenHeaders.push(req.headers)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ path: req.url }))
    })
    await new Promise<void>((resolve) => upstream!.listen(upstreamPort, '127.0.0.1', resolve))
    recordInvokeHandler('getServices', (() => [
      { serviceName: 'ai-backend', baseUrl: `http://127.0.0.1:${upstreamPort}` },
    ]) as never)
    const { forwarder } = await connectClient(await pair())
    const [service] = (await forwarder.invoke('getServices', [])) as { baseUrl: string }[]
    expect(service.baseUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/svc/${upstreamPort}$`))

    const response = await fetch(`${service.baseUrl}/api/getModelSize?x=1`, {
      headers: { 'X-AIPG-Auth': 'backend-token' },
    })
    expect(await response.json()).toEqual({ path: '/api/getModelSize?x=1' })
    expect(seenHeaders[0]['x-aipg-auth']).toBe('backend-token')
    expect(seenHeaders[0]['x-aipg-remote-token']).toBeUndefined()
  })

  it('serves aipg-media files, ranges included', async () => {
    const remote = await connectClient(await pair())
    const whole = await remote.fetchMedia(new Request('aipg-media://media/a.png'))
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('image/png')
    expect([...new Uint8Array(await whole.arrayBuffer())]).toEqual([10, 11, 12, 13, 14])

    const part = await remote.fetchMedia(
      new Request('aipg-media://media/a.png', { headers: { range: 'bytes=1-2' } }),
    )
    expect(part.status).toBe(206)
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([11, 12])

    const missing = await remote.fetchMedia(new Request('aipg-media://media/../secret'))
    expect(missing.status).toBe(404)
  })

  it('reconnects after the host restarts and asks the renderer to re-hydrate', async () => {
    const remote = await connectClient(await pair())
    await vi.waitFor(() => expect(remote.status().connection).toBe('connected'))
    emitKernelEvent(1)
    await vi.waitFor(() => expect(relayed).toHaveLength(1))

    const port = host.port
    await host.close()
    await vi.waitFor(() => expect(remote.status().connection).toBe('disconnected'))
    host = await startHost(identity, port)
    await vi.waitFor(() => expect(remote.status().connection).toBe('connected'), {
      timeout: 5000,
    })
    expect(rehydrate).toHaveBeenCalledTimes(1)
  })
})
