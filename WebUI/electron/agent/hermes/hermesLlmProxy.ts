import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { openAiApiBase } from '@/lib/inferenceApiBase'
import { HERMES_PROXY_MODEL } from '../../adapters/backends/hermesConfig.ts'

// Hermes reads its `base_url` once, when the gateway starts, but AIPG's LLM server moves port on
// every GPU swap. The proxy is the fixed address it is given; each request is re-rooted on the
// server as it stands, the same thing piLocalEndpoint.ts does for Pi.

export type HermesProxyTarget = {
  /** The live OpenAI-compatible root, read per request. */
  baseUrl: () => string | undefined
  /** The model id the server actually loaded; Hermes always asks for `HERMES_PROXY_MODEL`. */
  model: string
  /** Sent upstream in place of Hermes' own bearer, which only ever authenticates to this proxy. */
  headers?: Record<string, string>
  /** Recommended sampling for that model, merged over every completion body. */
  samplingParams?: Record<string, unknown>
  contextWindow?: number
  /** Token counts of each completion the server answered, as it reported them. */
  onUsage?: (usage: CompletionUsage) => void
}

export type CompletionUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export type HermesLlmProxy = {
  url: string
  key: string
  setTarget(target: HermesProxyTarget | null): void
  close(): Promise<void>
}

const MAX_BODY_BYTES = 64 * 1024 * 1024
const HOP_HEADERS = new Set([
  'authorization',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
])

function bearerMatches(header: string | undefined, key: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '')
  const expected = Buffer.from(key)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** Rewrites a completion body for the live server: real model id, then the model's sampling on top. */
export function rewriteCompletionBody(
  body: Record<string, unknown>,
  target: HermesProxyTarget,
): Record<string, unknown> {
  const rewritten: Record<string, unknown> = {
    ...body,
    ...(target.samplingParams ?? {}),
    model: target.model,
  }
  if (body.stream === true) {
    const options = (body.stream_options ?? {}) as Record<string, unknown>
    rewritten.stream_options = { ...options, include_usage: true }
  }
  return rewritten
}

function usageOf(json: string): CompletionUsage | undefined {
  if (!json.includes('"usage"')) return undefined
  try {
    const usage = (JSON.parse(json) as { usage?: unknown }).usage
    return usage && typeof usage === 'object' ? (usage as CompletionUsage) : undefined
  } catch {
    return undefined
  }
}

/** Watches a completion response for its `usage` object without holding the whole body. */
function usageWatcher(streaming: boolean, report: (usage: CompletionUsage) => void) {
  const decoder = new TextDecoder()
  let pending = ''
  const scanLine = (line: string) => {
    if (!line.startsWith('data:')) return
    const usage = usageOf(line.slice(5).trim())
    if (usage) report(usage)
  }
  return {
    write(chunk: Uint8Array) {
      pending += decoder.decode(chunk, { stream: true })
      if (!streaming) {
        if (pending.length > MAX_BODY_BYTES) pending = ''
        return
      }
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      lines.forEach(scanLine)
    },
    end() {
      if (streaming) scanLine(pending)
      else {
        const usage = usageOf(pending)
        if (usage) report(usage)
      }
    },
  }
}

export async function startHermesLlmProxy(key: string): Promise<HermesLlmProxy> {
  let target: HermesProxyTarget | null = null

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith('/v1/')) return sendJson(res, 404, { error: 'not found' })
      if (!bearerMatches(req.headers.authorization, key)) {
        res.setHeader('connection', 'close')
        return sendJson(res, 401, { error: 'unauthorized' })
      }
      const body = await readBody(req)
      if (url.pathname === '/v1/models') {
        return sendJson(res, 200, {
          object: 'list',
          data: [
            {
              id: HERMES_PROXY_MODEL,
              object: 'model',
              owned_by: 'aipg',
              ...(target?.contextWindow ? { context_length: target.contextWindow } : {}),
            },
          ],
        })
      }
      const live = target?.baseUrl()
      if (!target || !live) {
        return sendJson(res, 503, { error: { message: 'No AI Playground model is loaded' } })
      }

      let payload: Buffer = body
      const contentType = req.headers['content-type'] ?? ''
      if (body.length > 0 && contentType.includes('json')) {
        const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>
        if (typeof parsed === 'object' && parsed !== null && 'model' in parsed) {
          payload = Buffer.from(JSON.stringify(rewriteCompletionBody(parsed, target)))
        }
      }

      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_HEADERS.has(name) && typeof value === 'string') headers[name] = value
      }
      Object.assign(headers, target.headers)
      const upstreamPath = url.pathname.replace(/^\/v1/, '') + url.search
      const abort = new AbortController()
      res.on('close', () => abort.abort())
      const upstream = await fetch(`${openAiApiBase(live)}${upstreamPath}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(payload),
        signal: abort.signal,
      })
      const outHeaders: Record<string, string> = {}
      upstream.headers.forEach((value, name) => {
        if (!HOP_HEADERS.has(name) && name !== 'content-encoding') outHeaders[name] = value
      })
      res.writeHead(upstream.status, outHeaders)
      if (!upstream.body) return res.end()
      const onUsage = target.onUsage
      const watcher =
        onUsage && upstream.ok && upstreamPath.startsWith('/chat/completions')
          ? usageWatcher(
              (upstream.headers.get('content-type') ?? '').includes('event-stream'),
              (usage) => {
                try {
                  onUsage(usage)
                } catch {
                  // a usage reader must never break the reply it is reading
                }
              },
            )
          : undefined
      for await (const chunk of upstream.body) {
        res.write(chunk)
        watcher?.write(chunk)
      }
      watcher?.end()
      res.end()
    } catch (error) {
      if (res.headersSent) return res.destroy()
      sendJson(res, 502, { error: { message: `AI Playground proxy: ${String(error)}` } })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    key,
    setTarget(next) {
      target = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
