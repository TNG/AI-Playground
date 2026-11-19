import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { KernelEvent } from '@/types/kernelEvents'
import type { RemoteKernelConnection } from '@/types/remoteKernelIpc'
import type { RemoteForwarder } from './dispatch'
import { decodeWire, encodeWire } from './wireCodec'
import { REMOTE_HEADER_TOKEN, REMOTE_PATH, loopbackRewriter } from './protocol'
import { certificateFingerprint, derToPem } from './tlsIdentity'
import {
  clientIdentity,
  hostIdentity,
  openSealedToken,
  pairingSalt,
  type SealedToken,
} from './pairing'
import { createSpake2Party, passwordScalar } from './spake2'

/** A workstation this client paired with: its certificate is pinned, its token is ours alone. */
export type PairedTarget = {
  host: string
  port: number
  hostname: string
  certPem: string
  fingerprint: string
  token: string
  deviceId: string
}

export type RemoteKernelClientDeps = {
  target: PairedTarget
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

export const CERTIFICATE_MISMATCH = 'The workstation certificate does not match the paired one'
export const NO_LONGER_PAIRED = 'This device is no longer paired'
const VERIFY_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
])

/** A certificate other than the pinned one fails OpenSSL's chain check before ours runs. */
function explainTlsError(error: Error): Error {
  const code = (error as Error & { code?: string }).code
  return code && VERIFY_ERRORS.has(code) ? new Error(CERTIFICATE_MISMATCH) : error
}

/**
 * TLS options that trust exactly the paired certificate. The hostname is not checked: the
 * workstation is addressed by a LAN IP that can change, and the pin is what identifies it.
 */
export function pinnedTls(
  target: Pick<PairedTarget, 'certPem' | 'fingerprint'>,
): https.RequestOptions {
  return {
    ca: [target.certPem],
    checkServerIdentity: (_host, cert) =>
      certificateFingerprint(cert.raw) === target.fingerprint
        ? undefined
        : new Error(CERTIFICATE_MISMATCH),
  }
}

function requestText(
  target: Pick<PairedTarget, 'host' | 'port'>,
  tlsOptions: https.RequestOptions,
  method: string,
  route: string,
  body?: string,
  headers: Record<string, string> = {},
  timeoutMs?: number,
): Promise<HttpResult & { fingerprint?: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: target.host,
        port: target.port,
        method,
        path: `${REMOTE_PATH}${route}`,
        agent: false,
        ...tlsOptions,
        headers: {
          ...headers,
          ...(body !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            : {}),
        },
      },
      (res) => {
        const peer = (res.socket as tls.TLSSocket).getPeerCertificate?.()
        const fingerprint = peer?.raw ? certificateFingerprint(peer.raw) : undefined
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
            fingerprint,
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', (error) => reject(explainTlsError(error)))
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Timed out reaching the workstation')))
    }
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Reach the paired workstation with its pinned certificate and this device's token. */
export async function probeRemoteKernel(target: PairedTarget, timeoutMs = 5000): Promise<string> {
  const { status, text } = await requestText(
    target,
    pinnedTls(target),
    'GET',
    '/hello',
    undefined,
    { [REMOTE_HEADER_TOKEN]: target.token },
    timeoutMs,
  )
  if (status === 401) throw new Error(NO_LONGER_PAIRED)
  const body = decodeWire<{ ok?: boolean; hostname?: string; error?: string }>(text)
  if (status !== 200 || !body?.ok) throw new Error(body?.error ?? `HTTP ${status}`)
  return body.hostname ?? target.hostname
}

/** Read the certificate a workstation presents, before anything is trusted. */
function peekCertificate(host: string, port: number): Promise<{ der: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, servername: undefined })
    socket.setTimeout(10_000, () => socket.destroy(new Error('Timed out reaching the workstation')))
    socket.once('secureConnect', () => {
      const der = socket.getPeerCertificate().raw
      socket.end()
      if (der) resolve({ der })
      else reject(new Error('The workstation presented no certificate'))
    })
    socket.once('error', reject)
  })
}

export type PairRequest = {
  host: string
  port: number
  code: string
  deviceName: string
  deviceId?: string
}

/**
 * Pair with a workstation over SPAKE2. The code never leaves this machine; it is hashed with
 * the fingerprint of the certificate this client sees, so a device in the middle presenting
 * its own certificate fails the key confirmation instead of learning anything.
 */
export async function pairWithHost(request: PairRequest): Promise<PairedTarget> {
  const { host, port } = request
  const deviceId = request.deviceId ?? `device-${randomUUID()}`
  const { der } = await peekCertificate(host, port)
  const fingerprint = certificateFingerprint(der)
  const unpinned: https.RequestOptions = { rejectUnauthorized: false }

  const party = createSpake2Party(
    'A',
    passwordScalar(request.code, pairingSalt(fingerprint)),
    clientIdentity(deviceId),
    hostIdentity(fingerprint),
  )
  const started = await requestText(
    { host, port },
    unpinned,
    'POST',
    '/pair/start',
    JSON.stringify({ deviceId, deviceName: request.deviceName, pA: party.message.toString('hex') }),
  )
  const start = decodeWire<{
    ok?: boolean
    error?: string
    sessionId?: string
    pB?: string
    confirmB?: string
  }>(started.text)
  if (!start.ok || !start.sessionId || !start.pB || !start.confirmB) {
    throw new Error(start.error ?? `Pairing failed (HTTP ${started.status})`)
  }
  if (started.fingerprint !== fingerprint) throw new Error('The workstation certificate changed')
  const keys = party.finish(Buffer.from(start.pB, 'hex'))
  if (!keys.verifyPeer(Buffer.from(start.confirmB, 'hex'))) {
    throw new Error('The pairing code did not match')
  }

  const finished = await requestText(
    { host, port },
    unpinned,
    'POST',
    '/pair/finish',
    JSON.stringify({ sessionId: start.sessionId, confirmA: keys.confirmation.toString('hex') }),
  )
  const finish = decodeWire<{
    ok?: boolean
    error?: string
    hostname?: string
    sealed?: SealedToken
  }>(finished.text)
  if (!finish.ok || !finish.sealed) {
    throw new Error(finish.error ?? `Pairing failed (HTTP ${finished.status})`)
  }
  if (finished.fingerprint !== fingerprint) throw new Error('The workstation certificate changed')

  return {
    host,
    port,
    hostname: finish.hostname ?? host,
    certPem: derToPem(der),
    fingerprint,
    token: openSealedToken(keys.Ke, finish.sealed),
    deviceId,
  }
}

/** Loopback tunnel the renderer's direct backend fetches are rewritten onto. */
function startTunnel(target: PairedTarget): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/svc/')) {
      res.writeHead(404)
      res.end()
      return
    }
    const headers: http.OutgoingHttpHeaders = {
      ...req.headers,
      [REMOTE_HEADER_TOKEN]: target.token,
    }
    delete headers.host
    const upstream = https.request(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: `${REMOTE_PATH}${req.url}`,
        headers,
        ...pinnedTls(target),
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
  const tlsOptions = pinnedTls(target)
  const auth = { [REMOTE_HEADER_TOKEN]: target.token }
  const tunnel = await startTunnel(target)
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
      tlsOptions,
      'POST',
      '/rpc',
      encodeWire({ kind, channel, args }, rewrite.outbound),
      auth,
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
    if (state.connection !== 'disconnected')
      deps.log(`remote kernel stream lost: ${reason}`, 'warn')
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
    const req = https.request(
      {
        host: target.host,
        port: target.port,
        method: 'GET',
        path: `${REMOTE_PATH}/events${since}`,
        headers: { ...auth, Accept: 'text/event-stream' },
        agent: false,
        ...tlsOptions,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          onLost(res.statusCode === 401 ? NO_LONGER_PAIRED : `HTTP ${res.statusCode}`)
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
        res.on('close', () => onLost('stream closed'))
      },
    )
    req.on('error', (error) => onLost(explainTlsError(error).message))
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
    fetchMedia: (request) =>
      new Promise<Response>((resolve, reject) => {
        const headers: Record<string, string> = { ...auth }
        const range = request.headers.get('range')
        if (range) headers.range = range
        const req = https.request(
          {
            host: target.host,
            port: target.port,
            method: 'GET',
            path: `${REMOTE_PATH}/media?u=${encodeURIComponent(request.url)}`,
            headers,
            ...tlsOptions,
          },
          (res) => {
            const responseHeaders = new Headers()
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === 'string') responseHeaders.set(key, value)
            }
            responseHeaders.set('Access-Control-Allow-Origin', '*')
            const status = res.statusCode ?? 502
            const nullBody = status === 204 || status === 304
            if (nullBody) res.resume()
            resolve(
              new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream), {
                status,
                headers: responseHeaders,
              }),
            )
          },
        )
        req.on('error', reject)
        req.end()
      }),
    status: () => state,
    close: () => {
      closed = true
      stream?.destroy()
      tunnel.close()
    },
  }
}
