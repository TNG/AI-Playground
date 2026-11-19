import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { KernelEvent } from '@/types/kernelEvents'
import { addRemotePeer, remotePeerCount } from '../rendererSinks'
import { dispatchErrorStatus, dispatchRemote } from './dispatch'
import { decodeWire, encodeWire } from './wireCodec'
import { REMOTE_HEADER_TOKEN, REMOTE_PATH, isLoopbackServicePort, mimeTypeFor } from './protocol'
import type { DeviceRegistry, Pairing } from './pairing'
import type { TlsIdentity } from './tlsIdentity'

export type RemoteKernelHostDeps = {
  port: number
  tls: TlsIdentity
  devices: DeviceRegistry
  pairing: Pairing
  hostname: string
  /** What remote handlers see as `event.sender` (this app's window). */
  sender: () => unknown
  /** The same containment-checked resolver the `aipg-media` protocol handler uses. */
  resolveMediaPath: (url: string) => string | null
  onKernelEvent: (tap: (event: KernelEvent) => void) => () => void
  log: (message: string, level?: 'info' | 'warn' | 'error') => void
}

export type RemoteKernelHost = {
  port: number
  peerCount: () => number
  /** Ends a revoked device's event stream; its next request is refused. */
  disconnectDevice: (deviceId: string) => void
  close: () => Promise<void>
}

const MAX_RPC_BODY = 128 * 1024 * 1024
const EVENT_REPLAY = 5000
const HEARTBEAT_MS = 15_000
const MAX_FAILURES = 10
const FAILURE_WINDOW_MS = 60_000

type FailureRecord = { count: number; firstAt: number }

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = encodeWire(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** An answer sent before the request body is read must close, or keep-alive desyncs. */
function refuse(res: http.ServerResponse, status: number, message: string): void {
  res.setHeader('Connection', 'close')
  sendJson(res, status, { ok: false, error: message })
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function startRemoteKernelHost(deps: RemoteKernelHostDeps): Promise<RemoteKernelHost> {
  const bootId = randomUUID()
  const failures = new Map<string, FailureRecord>()
  const replay: KernelEvent[] = []
  const streams = new Map<http.ServerResponse, string>()

  const unsubscribe = deps.onKernelEvent((event) => {
    replay.push(event)
    if (replay.length > EVENT_REPLAY) replay.shift()
    const frame = `event: kernel\ndata: ${encodeWire(event)}\n\n`
    for (const stream of streams.keys()) stream.write(frame)
  })

  function rateLimited(ip: string): boolean {
    const record = failures.get(ip)
    if (!record) return false
    if (Date.now() - record.firstAt > FAILURE_WINDOW_MS) {
      failures.delete(ip)
      return false
    }
    return record.count >= MAX_FAILURES
  }

  function noteFailure(ip: string): void {
    const record = failures.get(ip)
    if (!record || Date.now() - record.firstAt > FAILURE_WINDOW_MS) {
      failures.set(ip, { count: 1, firstAt: Date.now() })
    } else {
      record.count += 1
    }
  }

  async function handleRpc(req: http.IncomingMessage, res: http.ServerResponse, peerId: string) {
    let call: { kind?: unknown; channel?: unknown; args?: unknown }
    try {
      call = decodeWire(await readBody(req, MAX_RPC_BODY))
    } catch (error) {
      refuse(res, dispatchErrorStatus(error) === 413 ? 413 : 400, String(error))
      return
    }
    const { kind, channel, args } = call ?? {}
    if ((kind !== 'invoke' && kind !== 'send') || typeof channel !== 'string') {
      sendJson(res, 400, { ok: false, error: 'Malformed call' })
      return
    }
    try {
      const result = await dispatchRemote(
        peerId,
        kind,
        channel,
        Array.isArray(args) ? args : [],
        deps.sender(),
      )
      sendJson(res, 200, { ok: true, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = dispatchErrorStatus(error)
      if (status !== 500) deps.log(`remote ${kind} ${channel} refused: ${message}`, 'warn')
      sendJson(res, status === 500 ? 200 : status, { ok: false, error: message })
    }
  }

  function handleEvents(req: http.IncomingMessage, res: http.ServerResponse, peerId: string) {
    const since = Number(new URL(req.url ?? '/', 'http://host').searchParams.get('since'))
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(`event: hello\ndata: ${encodeWire({ hostname: deps.hostname, bootId })}\n\n`)
    if (Number.isFinite(since) && since > 0) {
      const oldest = replay[0]?.seq
      if (oldest !== undefined && oldest > since + 1) {
        res.write('event: resync\ndata: {}\n\n')
      } else {
        for (const event of replay) {
          if (event.seq > since) res.write(`event: kernel\ndata: ${encodeWire(event)}\n\n`)
        }
      }
    }
    streams.set(res, peerId)
    const removePeer = addRemotePeer({
      id: peerId,
      push: (channel, payload) =>
        res.write(`event: push\ndata: ${encodeWire({ channel, payload })}\n\n`),
    })
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
    deps.devices.persistLastSeen()
    deps.log(`remote peer ${peerId} connected (${req.socket.remoteAddress})`)
    req.on('close', () => {
      clearInterval(heartbeat)
      streams.delete(res)
      removePeer()
      deps.log(`remote peer ${peerId} disconnected`)
    })
  }

  function handleMedia(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://host').searchParams.get('u') ?? ''
    const filePath = deps.resolveMediaPath(url)
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    const size = fs.statSync(filePath).size
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': mimeTypeFor(path.extname(filePath)),
      'Accept-Ranges': 'bytes',
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (range && size > 0) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` })
        res.end()
        return
      }
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
      })
      fs.createReadStream(filePath, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, { ...headers, 'Content-Length': size })
    fs.createReadStream(filePath).pipe(res)
  }

  function handleServiceProxy(req: http.IncomingMessage, res: http.ServerResponse, rest: string) {
    const match = /^\/(\d+)(\/.*)?$/.exec(rest)
    const port = match ? Number(match[1]) : NaN
    if (!match || !isLoopbackServicePort(port) || port === deps.port) {
      refuse(res, 403, 'Port not proxied')
      return
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${port}` }
    delete headers[REMOTE_HEADER_TOKEN]
    const upstream = http.request(
      { host: '127.0.0.1', port, method: req.method, path: match[2] ?? '/', headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      if (!res.headersSent) refuse(res, 502, String(error))
      else res.destroy()
    })
    req.pipe(upstream)
  }

  async function handlePair(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    step: 'start' | 'finish',
    ip: string,
  ) {
    if (!deps.pairing.isOpen()) {
      refuse(res, 403, 'No pairing window is open')
      return
    }
    try {
      const body = JSON.parse(await readBody(req, 16 * 1024)) as Record<string, unknown>
      const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '')
      if (step === 'start') {
        const started = deps.pairing.start({
          deviceId: text('deviceId'),
          deviceName: text('deviceName'),
          pA: text('pA'),
        })
        sendJson(res, 200, { ok: true, ...started })
        return
      }
      const { device, sealed } = deps.pairing.finish({
        sessionId: text('sessionId'),
        confirmA: text('confirmA'),
      })
      deps.log(`paired device ${device.name} (${device.id}) from ${ip}`)
      sendJson(res, 200, { ok: true, hostname: deps.hostname, sealed })
    } catch (error) {
      noteFailure(ip)
      const status = dispatchErrorStatus(error)
      sendJson(res, status === 500 ? 400 : status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const server = https.createServer(
    { cert: deps.tls.certPem, key: deps.tls.keyPem },
    (req, res) => {
      const ip = req.socket.remoteAddress ?? 'unknown'
      const url = new URL(req.url ?? '/', 'http://host')
      if (!url.pathname.startsWith(REMOTE_PATH)) {
        refuse(res, 404, 'Not found')
        return
      }
      if (rateLimited(ip)) {
        refuse(res, 429, 'Too many failed attempts')
        return
      }
      const route = url.pathname.slice(REMOTE_PATH.length)
      if ((route === '/pair/start' || route === '/pair/finish') && req.method === 'POST') {
        void handlePair(req, res, route === '/pair/start' ? 'start' : 'finish', ip)
        return
      }
      const given = req.headers[REMOTE_HEADER_TOKEN]
      const device = deps.devices.authenticate(typeof given === 'string' ? given : undefined)
      if (!device) {
        noteFailure(ip)
        refuse(res, 401, 'Unauthorized')
        return
      }
      failures.delete(ip)
      deps.devices.touch(device.id)
      const peerId = device.id
      if (route.startsWith('/svc/')) {
        handleServiceProxy(req, res, route.slice('/svc'.length) + url.search)
        return
      }
      if (route === '/hello' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, hostname: deps.hostname })
        return
      }
      if (route === '/rpc' && req.method === 'POST') {
        void handleRpc(req, res, peerId)
        return
      }
      if (route === '/events' && req.method === 'GET') {
        handleEvents(req, res, peerId)
        return
      }
      if (route === '/media' && req.method === 'GET') {
        handleMedia(req, res)
        return
      }
      refuse(res, 404, 'Not found')
    },
  )

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // Every interface on purpose: serving a thin client on the LAN is the feature.
    server.listen(deps.port, '0.0.0.0', () => {
      server.off('error', reject)
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : deps.port
      deps.log(`remote kernel host listening on 0.0.0.0:${port}`)
      resolve({
        port,
        peerCount: remotePeerCount,
        disconnectDevice: (deviceId) => {
          for (const [stream, owner] of streams) {
            if (owner === deviceId) stream.destroy()
          }
        },
        close: () =>
          new Promise<void>((done) => {
            unsubscribe()
            for (const stream of streams.keys()) stream.end()
            streams.clear()
            server.close(() => done())
            server.closeAllConnections()
          }),
      })
    })
  })
}
