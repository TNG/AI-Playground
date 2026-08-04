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
 *
 * No external npm packages are used — only Node.js built-in http, fs, path.
 */

import http from 'node:http'
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-AIPG-Auth')
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
          body = typeof body === 'object' && body !== null
            ? { ...body as object, name: pathParam }
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
      html = html.replace(
        '<head>',
        `<head>\n<script>\n${polyfillScript}\n</script>`,
      )
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    const content = await fs.promises.readFile(filePath)
    res.writeHead(200, { 'Content-Type': mimeType(filePath) })
    res.end(content)
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[headless] AI Playground HTTP server listening on http://0.0.0.0:${port}`)
    console.log(`[headless] Open http://localhost:${port} in your browser`)
  })

  return server
}
