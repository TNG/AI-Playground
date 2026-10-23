import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { ChatAskPayload } from '@/types/chatRequests'
import type { NotificationConfig } from '@/types/notificationsIpc'
import type { PermissionsPromptPayload } from '@/types/permissionsIpc'

// Automatic Notifications for a Paused Session, seen at the Channel: a real Pi
// session against a fake backend calls a speech tool and waits on the window, the
// test raises the prompts that pause it, and a fake channel records what is sent.

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-auto-notify-')))
const sessionsDir = path.join(tempRoot, 'agent-sessions')

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot, isPackaged: false, getAppPath: () => tempRoot },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
}))

vi.mock('../../persist/userDataPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../persist/userDataPaths')>()),
  getAgentSessionsDir: () => sessionsDir,
}))

const BACKEND = 'http://fake-llm.test/v1'

function frame(chunk: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
}

function completion(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

/** The first step calls the speech tool; the step after its result just answers. */
function reply(body: { messages?: Array<{ role: string }> }): Response {
  const callsTool = !body.messages?.some((message) => message.role === 'tool')
  const chunks = callsTool
    ? [
        completion({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'synthesizeTextToSpeech', arguments: '{"text":"hi"}' },
            },
          ],
        }),
        completion({}, 'tool_calls'),
      ]
    : [completion({ role: 'assistant', content: 'done' }), completion({}, 'stop')]
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(frame(chunk))
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init)
    if (!request.url.startsWith(BACKEND)) return realFetch(input, init)
    const text = await request.text()
    return reply(text ? JSON.parse(text) : {})
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

const SESSION = 'aipg-agent-news'

const CONFIG: NotificationConfig = {
  homeAgentEnabled: true,
  notificationChannel: 'telegram',
  autoNotify: true,
  sessionInView: null,
  templates: {
    paused: '⏸ "{title}" is waiting for you: {reason}. Open AI Playground to continue.',
    pauseReason: '{kind} ({summary})',
    pauseKinds: {
      download: 'a model download',
      'vram-warning': 'a VRAM warning',
      confirmation: 'a confirmation',
      question: 'a question',
    },
    untitled: 'An agent run',
  },
}

let sent: Array<{ kind: ChannelKind; text: string }> = []
let asks: ChatAskPayload[] = []
let prompts: PermissionsPromptPayload[] = []
let windowShown = true

let manager: typeof import('../../agent/piAgentManager')
let notifier: typeof import('../../agent/notifier')
let chatAsk: typeof import('../../chat/chatAsk')
let promptAdapter: typeof import('../../permissions/promptAdapter')
let permissions: typeof import('../../permissions/permissionsService')
let userWait: typeof import('../../kernel/userWait')
let sessionFiles: typeof import('../../persist/agentSessionFiles')

beforeAll(async () => {
  manager = await import('../../agent/piAgentManager')
  notifier = await import('../../agent/notifier')
  chatAsk = await import('../../chat/chatAsk')
  promptAdapter = await import('../../permissions/promptAdapter')
  permissions = await import('../../permissions/permissionsService')
  userWait = await import('../../kernel/userWait')
  sessionFiles = await import('../../persist/agentSessionFiles')
  const bus = await import('../../kernel/kernelBus')
  const bridge = await import('../../artifact/rendererBridge')
  const readiness = await import('../../chat/chatReadiness')
  readiness.setChatReadinessDeps({
    getService: () => ({ ensureBackendReadiness: async () => {}, baseUrl: null }),
    awaitChatWindow: async () => {},
    stopOvmsImageServer: async () => {},
    notifyHomeAgentUpstreamReady: () => {},
  })
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        if (channel === 'chat:ask') asks.push(payload as ChatAskPayload)
        else if (channel === 'artifact:request') {
          const { requestId } = payload as { requestId: string }
          queueMicrotask(() => bridge.handleMediaResponse({ requestId, result: { models: [] } }))
        } else if (channel === 'permissions:prompt') {
          prompts.push(payload as PermissionsPromptPayload)
        }
      },
    },
  }
  bus.setKernelEventWindow(fakeWindow as never)
  manager.setAgentModeMainWindow(fakeWindow as never)
  notifier.setNotificationChannelReply(async (kind, text) => {
    sent.push({ kind, text })
    return { success: true }
  })
  notifier.setNotificationWindowShown(() => windowShown)
  notifier.startAutoNotifications()
  await sessionFiles.saveAgentSession({
    id: SESSION,
    workspaceDir: tempRoot,
    title: 'Morning news',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  })
})

afterAll(async () => {
  await manager.shutdownAgentMode()
})

beforeEach(() => {
  sent = []
  asks = []
  prompts = []
  windowShown = true
  notifier.setNotificationConfig(CONFIG)
})

function configFor(sessionId: string): AgentModeTurnConfig {
  return {
    sessionId,
    workspaceDir: fs.mkdtempSync(path.join(tempRoot, 'ws-')),
    modelConfig: { source: 'local', model: 'model-a', baseUrl: BACKEND, contextWindow: 8192 },
    readiness: { serviceName: 'llamacpp-backend', llmModelName: 'model-a' },
    toolSpecs: [
      {
        name: 'synthesizeTextToSpeech',
        description: 'Speak text into an audio file.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ],
    capabilities: ['media'],
  }
}

/** Runs a turn of `sessionId` up to its tool call, hands it to `whileWaiting`, then lets it end. */
async function withWaitingTurn(sessionId: string, whileWaiting: () => Promise<void>) {
  const run = manager.startAgentTurn(crypto.randomUUID(), 'say hi', configFor(sessionId))
  await vi.waitFor(() => expect(asks).toHaveLength(1))
  await whileWaiting()
  chatAsk.handleChatAnswer({
    requestId: asks[0].requestId,
    result: { audioBase64: '', mediaType: 'audio/wav', voice: 'test', engine: 'kokoro' },
  })
  expect(await run).toEqual({ success: true })
}

async function nextPrompt(kind: PermissionsPromptPayload['kind']) {
  await vi.waitFor(() => expect(prompts.some((p) => p.kind === kind)).toBe(true))
  return prompts.find((p) => p.kind === kind)!
}

/** The window, answering the turn's speech request, needs a voice model downloaded. */
async function pauseForDownload(): Promise<void> {
  const consent = permissions.requestDownloadConsent([{ repo_id: 'org/kokoro-voice.gguf' }])
  const remote = await nextPrompt('is-remote')
  promptAdapter.handlePermissionsPromptResponse({ requestId: remote.requestId, result: false })
  const download = await nextPrompt('download')
  await settle()
  promptAdapter.handlePermissionsPromptResponse({ requestId: download.requestId, result: true })
  await consent
}

/** Lets the Notifier read the session record and hand the text to the channel. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

function pauseFor(sessionId: string, kind: 'confirmation' | 'question', summary: string) {
  userWait.setAwaitingUser(sessionId, true, { kind, summary })
}

const DOWNLOAD_TEXT =
  '⏸ "Morning news" is waiting for you: a model download (kokoro-voice). ' +
  'Open AI Playground to continue.'

describe('a Background Session pausing for the user', () => {
  it('sends one Notification naming the session and the model', async () => {
    await withWaitingTurn(SESSION, pauseForDownload)
    expect(sent).toEqual([{ kind: 'telegram', text: DOWNLOAD_TEXT }])
  }, 30000)

  it('notifies every pause kind, once per transition into paused', async () => {
    await withWaitingTurn(SESSION, async () => {
      const vram = permissions.requestVramWarningConsent({ presetName: 'Flux', message: 'Big' })
      const warning = await nextPrompt('vram-warning')
      await settle()
      promptAdapter.handlePermissionsPromptResponse({
        requestId: warning.requestId,
        result: { confirmed: true, remember: false },
      })
      await vram

      pauseFor(SESSION, 'confirmation', 'Continue in Game Agent?')
      // Asked again while still paused: the same pause, not a new one.
      pauseFor(SESSION, 'question', 'Which colour?')
      await settle()
      userWait.setAwaitingUser(SESSION, false)
      userWait.setAwaitingUser(SESSION, false)

      pauseFor(SESSION, 'question', 'Which colour?')
      await settle()
      userWait.setAwaitingUser(SESSION, false)
    })
    expect(sent.map((s) => s.text)).toEqual([
      '⏸ "Morning news" is waiting for you: a VRAM warning (Flux). Open AI Playground to continue.',
      '⏸ "Morning news" is waiting for you: a confirmation (Continue in Game Agent?). ' +
        'Open AI Playground to continue.',
      '⏸ "Morning news" is waiting for you: a question (Which colour?). ' +
        'Open AI Playground to continue.',
    ])
  }, 30000)

  it('labels a session with no record yet as an agent run', async () => {
    await withWaitingTurn('aipg-agent-fresh', async () => {
      pauseFor('aipg-agent-fresh', 'question', 'Which colour?')
      await settle()
      userWait.setAwaitingUser('aipg-agent-fresh', false)
    })
    expect(sent.map((s) => s.text)).toEqual([
      '⏸ "An agent run" is waiting for you: a question (Which colour?). ' +
        'Open AI Playground to continue.',
    ])
  }, 30000)

  it('stays quiet for the session open on screen', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionInView: SESSION })
    await withWaitingTurn(SESSION, pauseForDownload)
    expect(sent).toEqual([])
  }, 30000)

  it('notifies for the open session while the window is hidden or minimized', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionInView: SESSION })
    windowShown = false
    await withWaitingTurn(SESSION, pauseForDownload)
    expect(sent).toEqual([{ kind: 'telegram', text: DOWNLOAD_TEXT }])
  }, 30000)

  it.each([
    ['automatic Notifications are off', { autoNotify: false }],
    ['Home Agent is off', { homeAgentEnabled: false }],
    ['no Notification Channel is set up', { notificationChannel: null }],
  ])(
    'sends nothing when %s',
    async (_case, override) => {
      notifier.setNotificationConfig({ ...CONFIG, ...override })
      await withWaitingTurn(SESSION, pauseForDownload)
      expect(sent).toEqual([])
    },
    30000,
  )
})
