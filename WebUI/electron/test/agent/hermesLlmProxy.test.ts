import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startHermesLlmProxy, type HermesLlmProxy } from '../../agent/hermes/hermesLlmProxy'

// Hermes is given one fixed base URL for a whole app run; the proxy must follow AIPG's LLM server
// when it moves port and rewrite every body to the model that server actually loaded.

type Fake = { url: string; bodies: Record<string, unknown>[]; close: () => Promise<void> }

async function fakeServer(reply: string): Promise<Fake> {
  const bodies: Record<string, unknown>[] = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (raw) bodies.push(JSON.parse(raw))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ reply, path: req.url }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

const KEY = 'test-key-0123456789abcdef'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

async function proxy(): Promise<HermesLlmProxy> {
  const started = await startHermesLlmProxy(KEY)
  cleanup.push(started.close)
  return started
}

function complete(p: HermesLlmProxy, key = KEY) {
  return fetch(`${p.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'aipg-local', temperature: 0.2, messages: [] }),
  })
}

describe('Hermes LLM proxy', () => {
  it('rejects a request without the key', async () => {
    const p = await proxy()
    expect((await complete(p, 'wrong-key-0123456789abc')).status).toBe(401)
  })

  it('answers 503 while no model is loaded', async () => {
    const p = await proxy()
    expect((await complete(p)).status).toBe(503)
  })

  it('lists the synthetic model with the turn context window', async () => {
    const p = await proxy()
    p.setTarget({ baseUrl: () => undefined, model: 'real.gguf', contextWindow: 131072 })
    const res = await fetch(`${p.url}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } })
    const body = (await res.json()) as { data: { id: string; context_length?: number }[] }
    expect(body.data[0]).toMatchObject({ id: 'aipg-local', context_length: 131072 })
  })

  it('follows the live server when it moves and rewrites model and sampling', async () => {
    const first = await fakeServer('first')
    const second = await fakeServer('second')
    cleanup.push(first.close, second.close)
    let live = first.url
    const p = await proxy()
    p.setTarget({
      baseUrl: () => live,
      model: 'LFM2.5-350M-Q4_K_M.gguf',
      samplingParams: { top_k: 20 },
    })

    const a = (await (await complete(p)).json()) as { reply: string; path: string }
    expect(a).toEqual({ reply: 'first', path: '/v1/chat/completions' })
    live = second.url
    const b = (await (await complete(p)).json()) as { reply: string }
    expect(b.reply).toBe('second')

    expect(first.bodies[0]).toMatchObject({
      model: 'LFM2.5-350M-Q4_K_M.gguf',
      top_k: 20,
      temperature: 0.2,
    })
    expect(second.bodies).toHaveLength(1)
  })
})
