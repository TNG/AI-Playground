/**
 * Headless HTTP server for AI Playground.
 *
 * When started with --headless, Electron skips creating a BrowserWindow and
 * instead runs this server. It:
 *   1. Serves the built Vue.js dist/ files statically on port 8080
 *   2. Injects the electron-api-polyfill.js into index.html so the Vue app
 *      can talk to the Electron backend via REST instead of window.electronAPI
 *   3. Exposes /api/* REST endpoints that delegate to the same ipcMain handler
 *      logic already registered in main.ts
 *   4. Exposes /api/events (Server-Sent Events) so push events from backend
 *      services (serviceInfoUpdate, serviceSetUpProgress) reach the browser
 *   5. Exposes /api/proxy/<serviceName>/<path> as a streaming reverse proxy to
 *      a backend's own baseUrl (e.g. llama.cpp, OpenVINO) — chat completions
 *      fetch that baseUrl directly from the browser, which is only reachable
 *      if the browser is on the same host; over an SSH tunnel forwarding only
 *      this server's port, that direct address means the browser's own
 *      machine. Routing through here keeps a single port sufficient.
 *
 * No external npm packages are used — only Node.js built-in http, fs, path.
 */

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

// ── SSE client registry ───────────────────────────────────────────────────────
// Service files call win.webContents.send('serviceInfoUpdate', data) which in
// headless mode routes through the fake-win created in main.ts → broadcastSSE.
const sseClients = new Set<http.ServerResponse>()

export function broadcastSSE(channel: string, data: unknown): void {
  const payload = JSON.stringify({ channel, data })
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`)
    } catch {
      sseClients.delete(client)
    }
  }
}

// ── MIME type helper ──────────────────────────────────────────────────────────
function mimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
  }
  return types[ext] ?? 'application/octet-stream'
}

// ── JSON body parser helper ───────────────────────────────────────────────────
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk.toString()))
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : undefined)
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

// ── API handler registry ──────────────────────────────────────────────────────
type ApiHandler = (body: unknown) => Promise<unknown> | unknown

const apiHandlers = new Map<string, ApiHandler>()

/** Register a REST handler under a logical name (mirrors the ipcMain handler name). */
export function registerApiHandler(name: string, fn: ApiHandler): void {
  apiHandlers.set(name, fn)
}

// ── Reverse proxy to backend services ─────────────────────────────────────────
// Resolves a service name (e.g. 'llamacpp-backend') to its current baseUrl.
// Set by main.ts once the service registry exists — a plain callback rather
// than importing the registry here to avoid a circular import with main.ts.
let resolveServiceBaseUrl: (serviceName: string) => string | undefined = () => undefined

export function registerProxyResolver(fn: (serviceName: string) => string | undefined): void {
  resolveServiceBaseUrl = fn
}

// ── Media file resolver ───────────────────────────────────────────────────────
// Desktop Electron serves generated images/videos/3D models through the
// `aipg-media://` custom protocol (registered in main.ts), which only exists
// inside the Electron process — a plain browser can't resolve it at all
// (net::ERR_UNKNOWN_URL_SCHEME). Headless mode serves the same files over
// plain HTTP instead (see the '/api/media/' route below); main.ts registers
// this resolver (reusing its own path-traversal-safe lookup) once mediaDir
// exists, the same avoid-circular-import pattern as registerProxyResolver.
let resolveMediaPath: (relativePath: string) => string | null = () => null

export function registerMediaResolver(fn: (relativePath: string) => string | null): void {
  resolveMediaPath = fn
}

/**
 * Parses '/api/proxy/<serviceName>/<tail>' and resolves serviceName's current
 * baseUrl down to just its origin (see proxyToBackend's comment on why the
 * pathname is dropped). Shared by both the HTTP proxy and the WS upgrade
 * proxy below, which must agree on the same URL scheme.
 */
function resolveProxyTarget(url: string): { origin: string; tail: string } | { error: string } {
  const afterPrefix = url.slice('/api/proxy/'.length)
  const slashIdx = afterPrefix.indexOf('/')
  const serviceName = slashIdx === -1 ? afterPrefix.split('?')[0] : afterPrefix.slice(0, slashIdx)
  const tail = slashIdx === -1 ? '' : afterPrefix.slice(slashIdx)
  const baseUrl = resolveServiceBaseUrl(serviceName)
  if (!baseUrl) return { error: `No baseUrl known for service: ${serviceName}` }
  try {
    return { origin: new URL(baseUrl).origin, tail }
  } catch {
    return { error: `Invalid baseUrl for service ${serviceName}: ${baseUrl}` }
  }
}

/** Streams `req` to `targetUrl` and streams the response back through `res` untouched — this must not buffer, since chat completions stream tokens via chunked/SSE responses. */
function proxyToBackend(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetUrl: string,
): Promise<void> {
  return new Promise((resolve) => {
    let target: URL
    try {
      target = new URL(targetUrl)
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Invalid proxy target: ${targetUrl}` }))
      resolve()
      return
    }
    // Drop the browser's own Host header — the upstream backend is addressed
    // by targetUrl, and it (or Node) is what should set the correct Host.
    const { host: _host, ...forwardHeaders } = req.headers
    const proxyReq = http.request(
      {
        hostname: target.hostname,
        port: target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80,
        path: target.pathname + target.search,
        method: req.method,
        headers: forwardHeaders,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
        proxyRes.pipe(res)
        proxyRes.on('end', resolve)
        // Chat backends are stopped/restarted mid-turn to free VRAM for image
        // generation, so an upstream dying mid-stream is expected. Without this
        // the 'error' event is unhandled and the chunked response is left
        // truncated, which the browser reports as a bare "Failed to fetch";
        // ending it writes the terminating chunk so the client sees a clean EOF.
        proxyRes.on('error', () => {
          res.end()
          resolve()
        })
      },
    )
    // The client going away (tab closed, request aborted) must tear down the
    // upstream request too, otherwise it streams on with nowhere to go.
    res.on('close', () => proxyReq.destroy())
    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
      }
      res.end(JSON.stringify({ error: String(err) }))
      resolve()
    })
    req.on('error', () => {
      proxyReq.destroy()
      resolve()
    })
    req.pipe(proxyReq)
  })
}

// ── Server startup ─────────────────────────────────────────────────────────────
export function startHeadlessServer(
  distPath: string,
  polyfillPath: string,
  port = 8080,
): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    // ── CORS preflight ──────────────────────────────────────────────────────
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-AIPG-Auth, X-Upstream-Url, X-Cloud-Upstream, X-Cloud-Provider, X-Cloud-Auth-Style',
    )
    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // ── SSE push events endpoint ────────────────────────────────────────────
    if (url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      })
      res.write('retry: 3000\n\n') // reconnect after 3 s on disconnect
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    // ── Reverse proxy (/api/proxy/<serviceName>/<path>) ──────────────────────
    // Checked before the generic REST dispatch below so 'proxy' is never
    // looked up as a handler name.
    if (url.startsWith('/api/proxy/')) {
      const target = resolveProxyTarget(url)
      if ('error' in target) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: target.error }))
        return
      }
      await proxyToBackend(req, res, target.origin + target.tail)
      return
    }

    // ── Media file serving (/api/media/<path>) ───────────────────────────────
    // Checked before the generic REST dispatch below for the same reason as
    // '/api/proxy/' — media paths can have nested segments (e.g. input/foo.png)
    // that the single-path-param REST dispatch would truncate.
    if (url.startsWith('/api/media/')) {
      const relativePath = url.slice('/api/media/'.length).split('?')[0]
      const filePath = resolveMediaPath(relativePath)
      if (!filePath) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not Found' }))
        return
      }
      try {
        await fs.promises.access(filePath, fs.constants.R_OK)
        const content = await fs.promises.readFile(filePath)
        res.writeHead(200, { 'Content-Type': mimeType(filePath) })
        res.end(content)
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not Found' }))
      }
      return
    }

    // ── REST API  (/api/<handlerName>) ──────────────────────────────────────
    if (url.startsWith('/api/')) {
      // Extract handler name from path, e.g. /api/getServices → 'getServices'
      // Support path params: /api/startService/ai-backend → 'startService' body={name}
      const parts = url.slice(5).split('?')[0].split('/')
      const handlerName = parts[0]
      const pathParam = parts[1] ? decodeURIComponent(parts[1]) : undefined

      const handler = apiHandlers.get(handlerName)
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Unknown API: ${handlerName}` }))
        return
      }
      try {
        let body: unknown
        if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
          body = await readBody(req)
        }
        // Merge path param into body when present (used by service-name routes)
        if (pathParam !== undefined) {
          body =
            typeof body === 'object' && body !== null
              ? { ...(body as object), name: pathParam }
              : { name: pathParam }
        }
        const result = await handler(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result ?? null))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      }
      return
    }

    // ── Static file serving ─────────────────────────────────────────────────
    // Map URL to filesystem path; unknown paths fall back to index.html (SPA routing)
    let filePath: string
    if (url === '/' || url === '/index.html') {
      filePath = path.join(distPath, 'index.html')
    } else {
      // Strip query string
      const clean = url.split('?')[0]
      filePath = path.join(distPath, clean)
    }

    try {
      await fs.promises.access(filePath, fs.constants.R_OK)
    } catch {
      // File not found → serve index.html for SPA client-side routing
      filePath = path.join(distPath, 'index.html')
    }

    const stat = await fs.promises.stat(filePath)
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html')
    }

    // Inject polyfill into index.html so window.electronAPI is available in browser
    if (filePath.endsWith('index.html')) {
      let html = await fs.promises.readFile(filePath, 'utf-8')
      let polyfillScript = ''
      try {
        polyfillScript = await fs.promises.readFile(polyfillPath, 'utf-8')
      } catch {
        polyfillScript = '/* polyfill not found */'
      }
      // Inject the polyfill as the very first script in <head> so it runs before
      // the Vue app initialises and tries to access window.electronAPI.
      html = html.replace('<head>', `<head>\n<script>\n${polyfillScript}\n</script>`)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    const content = await fs.promises.readFile(filePath)
    res.writeHead(200, { 'Content-Type': mimeType(filePath) })
    res.end(content)
  })

  // ── WebSocket proxy (/api/proxy/<serviceName>/<path>, upgrade requests) ──────
  // ComfyUI streams generation progress/previews over a raw WebSocket, not
  // HTTP — the same 127.0.0.1:<port>-over-SSH-tunnel problem the HTTP proxy
  // above solves applies here too. No 'ws' package is used: a WebSocket
  // handshake is just an HTTP Upgrade request, and everything after the 101
  // response is opaque framed bytes, so relaying the raw TCP socket in both
  // directions is sufficient — this process never needs to parse WS frames.
  server.on('upgrade', (req, clientSocket, head) => {
    const url = req.url ?? ''
    const fail = () => clientSocket.destroy()
    if (!url.startsWith('/api/proxy/')) return fail()
    const target = resolveProxyTarget(url)
    if ('error' in target) return fail()

    let originUrl: URL
    try {
      originUrl = new URL(target.origin)
    } catch {
      return fail()
    }
    const upstream = net.connect(
      Number(originUrl.port) || (originUrl.protocol === 'https:' ? 443 : 80),
      originUrl.hostname,
      () => {
        // Replay the client's original upgrade request line/headers to the
        // upstream, with only the path rewritten to the resolved tail and
        // Host corrected to the upstream's own — everything else (the
        // Upgrade/Connection/Sec-WebSocket-* handshake headers) is forwarded
        // as-is so the upstream's own WS implementation completes the
        // handshake exactly as it would for a direct connection.
        const lines = [`GET ${target.tail} HTTP/1.1`]
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (/^host$/i.test(req.rawHeaders[i])) continue
          lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
        }
        lines.push(`Host: ${originUrl.host}`, '', '')
        upstream.write(lines.join('\r\n'))
        if (head?.length) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      },
    )
    upstream.on('error', fail)
    clientSocket.on('error', () => upstream.destroy())
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[headless] AI Playground HTTP server listening on http://0.0.0.0:${port}`)
    console.log(`[headless] Open http://localhost:${port} in your browser`)
  })

  return server
}
