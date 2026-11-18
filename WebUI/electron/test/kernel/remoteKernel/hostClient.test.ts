import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import getPort, { portNumbers } from 'get-port'
import type { WebContents } from 'electron'
import type { KernelEvent } from '@/types/kernelEvents'
import {
  recordInvokeHandler,
  recordSendHandler,
  resetRemoteDispatchForTest,
} from '../../../kernel/remoteKernel/dispatch'
import { startRemoteKernelHost, type RemoteKernelHost } from '../../../kernel/remoteKernel/host'
import {
  probeRemoteKernel,
  startRemoteKernelClient,
  type RemoteKernelClient,
} from '../../../kernel/remoteKernel/client'
import { deliverPush, resetRendererSinksForTest } from '../../../kernel/rendererSinks'

const TOKEN = 'test-token'

let host: RemoteKernelHost
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

async function connectClient(token = TOKEN): Promise<RemoteKernelClient> {
  const started = await startRemoteKernelClient({
    target: { host: '127.0.0.1', port: host.port, token },
    relayKernelEvent: (event) => relayed.push(event),
    deliverPush: (channel, payload) => pushes.push({ channel, payload }),
    rehydrate,
    log: () => {},
  })
  client = started
  return started
}

beforeEach(async () => {
  resetRemoteDispatchForTest()
  resetRendererSinksForTest()
  relayed.length = 0
  pushes.length = 0
  rehydrate.mockClear()
  mediaFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-remote-')), 'a.png')
  fs.writeFileSync(mediaFile, Buffer.from([10, 11, 12, 13, 14]))
  host = await startRemoteKernelHost({
    port: 0,
    token: () => TOKEN,
    hostname: 'workstation-1',
    sender: () => ({ id: 'window' }),
    resolveMediaPath: (url) => (url === 'aipg-media://media/a.png' ? mediaFile : null),
    onKernelEvent: (tap) => {
      taps.add(tap)
      return () => taps.delete(tap)
    },
    log: () => {},
  })
})

afterEach(async () => {
  client?.close()
  client = null
  upstream?.close()
  upstream = null
  await host.close()
  taps.clear()
})

describe('remote kernel host + client', () => {
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
    const { forwarder } = await connectClient()
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
    const { forwarder } = await connectClient()
    await expect(forwarder.invoke('showOpenDialog', [{}])).rejects.toThrow(/not served remotely/)
    await expect(forwarder.invoke('getServices', [])).rejects.toThrow('registry not ready')
  })

  it('dispatches send rows', async () => {
    const listener = vi.fn()
    recordSendHandler('permissions:awaitingUser', listener as never)
    const { forwarder } = await connectClient()
    forwarder.send('permissions:awaitingUser', [{ conversationKey: 'c1', waiting: true }])
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
    expect(listener.mock.calls[0][1]).toEqual({ conversationKey: 'c1', waiting: true })
  })

  it('rejects a wrong token', async () => {
    await expect(
      probeRemoteKernel({ host: '127.0.0.1', port: host.port, token: 'nope' }),
    ).rejects.toThrow('Unauthorized')
    await expect(
      probeRemoteKernel({ host: '127.0.0.1', port: host.port, token: TOKEN }),
    ).resolves.toBe('workstation-1')
  })

  it('streams kernel events and routes pushes to the peer that drives the turn', async () => {
    recordInvokeHandler('chat:submitTurn', (() => ({ success: true })) as never)
    const remote = await connectClient()
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
    const { forwarder } = await connectClient()
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
    const remote = await connectClient()
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
    const remote = await connectClient()
    await vi.waitFor(() => expect(remote.status().connection).toBe('connected'))
    emitKernelEvent(1)
    await vi.waitFor(() => expect(relayed).toHaveLength(1))

    const port = host.port
    await host.close()
    await vi.waitFor(() => expect(remote.status().connection).toBe('disconnected'))
    host = await startRemoteKernelHost({
      port,
      token: () => TOKEN,
      hostname: 'workstation-1',
      sender: () => null,
      resolveMediaPath: () => null,
      onKernelEvent: (tap) => {
        taps.add(tap)
        return () => taps.delete(tap)
      },
      log: () => {},
    })
    await vi.waitFor(() => expect(remote.status().connection).toBe('connected'), {
      timeout: 5000,
    })
    expect(rehydrate).toHaveBeenCalledTimes(1)
  })
})
