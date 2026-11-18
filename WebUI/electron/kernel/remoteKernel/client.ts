import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { KernelEvent } from '@/types/kernelEvents'
import type { RemoteKernelConnection, RemoteKernelTarget } from '@/types/remoteKernelIpc'
import type { RemoteForwarder } from './dispatch'
import { decodeWire, encodeWire } from './wireCodec'
import { REMOTE_HEADER_PEER, REMOTE_HEADER_TOKEN, REMOTE_PATH, loopbackRewriter } from './protocol'

export type RemoteKernelClientDeps = {
  target: RemoteKernelTarget
  relayKernelEvent: (event: KernelEvent) => void
  deliverPush: (channel: string, payload: unknown) => void
  /** The renderer missed events it cannot replay; it re-hydrates from a fresh snapshot. */
  rehydrate: () => void
  log: (message: string, level?: 'info' | 'warn' | 'error') => void
}

export type RemoteKernelClientStatus = {
  connection: RemoteKernelConnection
  remoteHostname?: string
  lastError?: string
}

export type RemoteKernelClient = {
  forwarder: RemoteForwarder
  fetchMedia: (request: Request) => Promise<Response>
  status: () => RemoteKernelClientStatus
  close: () => void
}

type HttpResult = { status: number; text: string }

function authHeaders(target: RemoteKernelTarget, peerId: string): Record<string, string> {
  return { [REMOTE_HEADER_TOKEN]: target.token, [REMOTE_HEADER_PEER]: peerId }
}

function requestText(
  target: RemoteKernelTarget,
  peerId: string,
  method: string,
  route: string,
  body?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.host,
        port: target.port,
        method,
        path: `${REMOTE_PATH}${route}`,
        headers: {
          ...authHeaders(target, peerId),
          ...(body !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Reach a workstation and return its hostname; used by the settings "Test" button. */
export async function probeRemoteKernel(target: RemoteKernelTarget): Promise<string> {
  const { status, text } = await requestText(target, 'probe', 'GET', '/hello')
  const body = decodeWire<{ ok?: boolean; hostname?: string; error?: string }>(text)
  if (status !== 200 || !body?.ok) throw new Error(body?.error ?? `HTTP ${status}`)
  return body.hostname ?? target.host
}

/** Loopback tunnel the renderer's direct backend fetches are rewritten onto. */
function startTunnel(target: RemoteKernelTarget, peerId: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/svc/')) {
      res.writeHead(404)
      res.end()
      return
    }
    const headers = { ...req.headers, ...authHeaders(target, peerId) }
    delete headers.host
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: `${REMOTE_PATH}${req.url}`,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

export async function startRemoteKernelClient(
  deps: RemoteKernelClientDeps,
): Promise<RemoteKernelClient> {
  const { target } = deps
  const peerId = `peer-${randomUUID()}`
  const tunnel = await startTunnel(target, peerId)
  const address = tunnel.address()
  const rewrite = loopbackRewriter(typeof address === 'object' && address ? address.port : 0)

  let state: RemoteKernelClientStatus = { connection: 'connecting' }
  let lastSeq = 0
  let hostBootId: string | null = null
  let closed = false
  let stream: http.ClientRequest | null = null
  let retryDelay = 1000

  async function call(kind: 'invoke' | 'send', channel: string, args: unknown[]) {
    const { status, text } = await requestText(
      target,
      peerId,
      'POST',
      '/rpc',
      encodeWire({ kind, channel, args }, rewrite.outbound),
    )
    const body = decodeWire<{ ok?: boolean; result?: unknown; error?: string }>(
      text,
      rewrite.inbound,
    )
    if (!body?.ok) throw new Error(body?.error ?? `Remote ${channel} failed (HTTP ${status})`)
    return body.result
  }

  function handleFrame(event: string, data: string) {
    if (event === 'hello') {
      const hello = decodeWire<{ hostname?: string; bootId?: string }>(data)
      const restarted = hostBootId !== null && hello.bootId !== hostBootId
      hostBootId = hello.bootId ?? null
      state = { connection: 'connected', remoteHostname: hello.hostname }
      retryDelay = 1000
      if (restarted) {
        lastSeq = 0
        deps.rehydrate()
      }
      return
    }
    if (event === 'resync') {
      deps.rehydrate()
      return
    }
    if (event === 'kernel') {
      const kernelEvent = decodeWire<KernelEvent>(data, rewrite.inbound)
      lastSeq = Math.max(lastSeq, kernelEvent.seq)
      deps.relayKernelEvent(kernelEvent)
      return
    }
    if (event === 'push') {
      const push = decodeWire<{ channel: string; payload: unknown }>(data, rewrite.inbound)
      deps.deliverPush(push.channel, push.payload)
    }
  }

  function scheduleReconnect(reason: string) {
    if (closed) return
    if (state.connection !== 'disconnected') deps.log(`remote kernel stream lost: ${reason}`, 'warn')
    state = { ...state, connection: 'disconnected', lastError: reason }
    setTimeout(connect, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 10_000)
  }

  function connect() {
    if (closed) return
    const since = lastSeq > 0 ? `?since=${lastSeq}` : ''
    let lost = false
    const onLost = (reason: string) => {
      if (lost) return
      lost = true
      scheduleReconnect(reason)
    }
    const req = http.request(
      {
        host: target.host,
        port: target.port,
        method: 'GET',
        path: `${REMOTE_PATH}/events${since}`,
        headers: { ...authHeaders(target, peerId), Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          onLost(`HTTP ${res.statusCode}`)
          return
        }
        res.setEncoding('utf8')
        let buffer = ''
        res.on('data', (chunk: string) => {
          buffer += chunk
          let boundary = buffer.indexOf('\n\n')
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            let event = 'message'
            const data: string[] = []
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7)
              else if (line.startsWith('data: ')) data.push(line.slice(6))
            }
            if (data.length > 0) {
              try {
                handleFrame(event, data.join('\n'))
              } catch (error) {
                deps.log(`remote kernel frame ${event} failed: ${String(error)}`, 'error')
              }
            }
            boundary = buffer.indexOf('\n\n')
          }
        })
        res.on('end', () => onLost('stream ended'))
        res.on('error', (error) => onLost(String(error)))
      },
    )
    req.on('error', (error) => onLost(String(error)))
    req.end()
    stream = req
  }

  connect()

  return {
    forwarder: {
      invoke: (channel, args) => call('invoke', channel, args),
      send: (channel, args) => {
        call('send', channel, args).catch((error) =>
          deps.log(`remote send ${channel} failed: ${String(error)}`, 'warn'),
        )
      },
    },
    fetchMedia: async (request) => {
      const headers: Record<string, string> = authHeaders(target, peerId)
      const range = request.headers.get('range')
      if (range) headers.range = range
      const upstream = await fetch(
        `http://${target.host}:${target.port}${REMOTE_PATH}/media?u=${encodeURIComponent(request.url)}`,
        { headers },
      )
      const responseHeaders = new Headers(upstream.headers)
      responseHeaders.set('Access-Control-Allow-Origin', '*')
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      })
    },
    status: () => state,
    close: () => {
      closed = true
      stream?.destroy()
      tunnel.close()
    },
  }
}
