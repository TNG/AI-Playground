// Minimal HTTP + SSE client for the Home Agent "local web chat" channel, used by
// home-agent-local-web.spec.ts to play the role of a browser on the LAN. Talks
// straight to the Python `LocalWebChannel` server (plain Node `http`, no browser)
// so the e2e exercises the real transport: password login → session cookie → SSE
// event stream (`/api/events`) + message POST (`/api/chat`).

import http from 'node:http'

const SESSION_COOKIE = 'aipg_local_web'

/** One decoded SSE event `{action, ...payload}` broadcast by the channel. */
export type LocalWebEvent = {
  action?: string
  text?: string
  base64?: string
  caption?: string
  buttons?: Array<Array<{ text?: string; callbackData?: string; callback?: string }>>
}

function requestJson(
  base: string,
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<{ status: number; setCookie?: string; body: string }> {
  const url = new URL(path, base)
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: opts.method ?? (payload ? 'POST' : 'GET'),
        headers: {
          // Set Content-Length explicitly: without it Node sends the body with
          // Transfer-Encoding: chunked, which the stdlib server's body reader
          // doesn't decode (it reads 0 bytes and the unread chunk framing then
          // corrupts the keep-alive stream). Browsers' fetch() always sets it.
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            setCookie: res.headers['set-cookie']?.[0],
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        )
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** Log in with the chat password and return the session cookie header value. */
export async function login(base: string, password: string): Promise<string> {
  const res = await requestJson(base, '/api/login', { body: { password } })
  if (res.status !== 200) throw new Error(`local-web login failed: HTTP ${res.status} ${res.body}`)
  const setCookie = res.setCookie
  if (!setCookie) throw new Error('local-web login did not set a session cookie')
  const value = setCookie.split(';')[0]
  if (!value.startsWith(`${SESSION_COOKIE}=`)) {
    throw new Error(`unexpected session cookie: ${value}`)
  }
  return value
}

/** POST a chat message (or a keyboard callback) as the signed-in browser would. */
export async function sendChat(
  base: string,
  cookie: string,
  payload: { text?: string; callback?: string },
): Promise<void> {
  const res = await requestJson(base, '/api/chat', { body: payload, cookie })
  if (res.status !== 200)
    throw new Error(`local-web /api/chat failed: HTTP ${res.status} ${res.body}`)
}

/**
 * Open the SSE stream and resolve with the first non-empty `reply` event's text.
 * Auto-confirms any interactive prompt the agent sends mid-turn (e.g. a model-
 * download approval arrives as a `keyboard` event) by POSTing back the first
 * button's callback — the local-web analogue of a user tapping "Confirm" — so a
 * turn that needs a download still runs to completion. `draftUpdate`/`update`
 * events are ignored; we only settle on the final reply.
 */
export function waitForReply(
  base: string,
  cookie: string,
  timeoutMs: number,
): { done: Promise<string>; close: () => void } {
  const url = new URL('/api/events', base)
  let settle: (v: string) => void
  let fail: (e: Error) => void
  const done = new Promise<string>((res, rej) => {
    settle = res
    fail = rej
  })

  const req = http.get(url, { headers: { Cookie: cookie, Accept: 'text/event-stream' } }, (res) => {
    if (res.statusCode !== 200) {
      fail(new Error(`/api/events returned HTTP ${res.statusCode}`))
      return
    }
    res.setEncoding('utf-8')
    let buffer = ''
    res.on('data', (chunk: string) => {
      buffer += chunk
      // SSE frames are separated by a blank line; each `data:` line is JSON.
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          let event: LocalWebEvent
          try {
            event = JSON.parse(line.slice(5).trim())
          } catch {
            continue
          }
          if (event.action === 'reply' && (event.text ?? '').trim()) {
            settle((event.text ?? '').trim())
            return
          }
          if (event.action === 'keyboard' && event.buttons?.length) {
            const first = event.buttons.flat()[0]
            const cb = first?.callbackData ?? first?.callback
            if (cb) void sendChat(base, cookie, { callback: cb }).catch(() => {})
          }
        }
      }
    })
    res.on('error', (e) => fail(e as Error))
  })
  req.on('error', (e) => fail(e as Error))

  const timer = setTimeout(
    () => fail(new Error(`Timed out after ${timeoutMs}ms waiting for a local-web reply`)),
    timeoutMs,
  )
  const close = () => {
    clearTimeout(timer)
    req.destroy()
  }
  void done.finally(close)

  return { done, close }
}
