import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

// A real Pi session against a fake server: the recorded `max_tokens` is what Pi
// actually sent once its context clamp ran, which no unit of ours can show.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-output-budget-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => tempRoot,
    isPackaged: false,
    getAppPath: () => tempRoot,
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
}))

type Recorded = Record<string, unknown>

const requests: Recorded[] = []
let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (part) => (body += part))
    req.on('end', () => {
      requests.push(body ? (JSON.parse(body) as Recorded) : {})
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const finish of [null, 'stop']) {
        const chunk = {
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-model',
          choices: [
            {
              index: 0,
              delta: finish ? {} : { role: 'assistant', content: 'ok' },
              finish_reason: finish,
            },
          ],
        }
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

async function maxTokensSent(withBudget: boolean): Promise<unknown> {
  const pi = await import('@earendil-works/pi-coding-agent')
  const { createOutputBudgetExtension } = await import('../../agent/piOutputBudget.ts')
  const { outputTokenBudget } = await import('../../agent/piCompaction.ts')
  const budget = outputTokenBudget(8192, 'local')
  const runtime = await pi.ModelRuntime.create({
    authPath: path.join(tempRoot, 'auth.json'),
    modelsPath: null,
  })
  runtime.registerProvider('aipg-local', {
    name: 'test backend',
    baseUrl,
    api: 'openai-completions',
    apiKey: 'unused',
    models: [
      {
        id: 'test-model',
        name: 'test-model',
        reasoning: false,
        input: ['text'],
        contextWindow: 8192,
        maxTokens: budget,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      },
    ],
  })
  await runtime.setRuntimeApiKey('aipg-local', 'unused')
  const workspace = fs.mkdtempSync(path.join(tempRoot, 'ws-'))
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: workspace,
    agentDir: path.join(tempRoot, 'agent'),
    noExtensions: true,
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    extensionFactories: withBudget ? [createOutputBudgetExtension(budget)] : [],
  })
  await resourceLoader.reload()
  const { session } = await pi.createAgentSession({
    cwd: workspace,
    agentDir: path.join(tempRoot, 'agent'),
    model: runtime.getModel('aipg-local', 'test-model')!,
    modelRuntime: runtime,
    settingsManager: pi.SettingsManager.inMemory(),
    resourceLoader,
    noTools: 'builtin',
  })
  const before = requests.length
  // ~5k estimated tokens: past Pi's clamp, short of the 6144-token auto-compact trigger.
  await session.prompt('lorem ipsum dolor sit amet '.repeat(750))
  expect(requests.length).toBe(before + 1)
  const sent = requests[before]
  return sent.max_tokens ?? sent.max_completion_tokens
}

describe('output budget on a small local window', () => {
  it('Pi alone cuts a 5k-token prompt on an 8k window to one output token', async () => {
    expect(await maxTokensSent(false)).toBe(1)
  }, 30000)

  it('the extension gives the step its budget back', async () => {
    const { outputTokenBudget } = await import('../../agent/piCompaction.ts')
    expect(await maxTokensSent(true)).toBe(outputTokenBudget(8192, 'local'))
  }, 30000)
})
