import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { ChannelKind, KeyboardButton } from '@/assets/js/store/channels/types'
import type { NotificationRoute } from '@/types/notificationsIpc'
import type { ChannelSendOutcome } from '../../agent/notifier'

// The `notify_user` tool as the model uses it: a real Pi session against a fake
// OpenAI-compatible backend (faked through `fetch`) and a fake Home Agent channel.

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-notify-')))

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot, isPackaged: false, getAppPath: () => tempRoot },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
}))

vi.mock('../../persist/userDataPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../persist/userDataPaths')>()),
  getAgentSessionsDir: () => path.join(tempRoot, 'agent-sessions'),
  getAgentTasksFile: () => path.join(tempRoot, 'agent-tasks.json'),
  getChannelMessageMapFile: () => path.join(tempRoot, 'channel-messages.json'),
}))

const BACKEND = 'http://fake-llm.test/v1'
const SUMMARY = 'Top story: the bridge reopened.'

type RequestBody = {
  messages?: Array<{ role: string; content?: unknown }>
  tools?: Array<{ function?: { name?: string } }>
}

let requests: RequestBody[] = []

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

function toolNames(body: RequestBody): string[] {
  return (body.tools ?? []).map((tool) => tool.function?.name ?? '')
}

function reply(body: RequestBody): Response {
  const callsTool =
    toolNames(body).includes('notify_user') && !body.messages?.some((m) => m.role === 'tool')
  const chunks = callsTool
    ? [
        completion({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'notify_user', arguments: JSON.stringify({ message: SUMMARY }) },
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
    const body = (text ? JSON.parse(text) : {}) as RequestBody
    requests.push(body)
    return reply(body)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

let sent: Array<{
  kind: ChannelKind
  text: string
  buttons?: KeyboardButton[][]
  answerTitle?: string
}> = []
let channelResult: ChannelSendOutcome = { success: true, ref: '42' }

function route(next: NotificationRoute, realShellSessions: string[] = []): void {
  notifier.setNotificationConfig({
    ...next,
    autoNotify: false,
    sessionInView: null,
    realShellSessions,
    templates: {
      header: '🤖 Agent · {title}',
      paused: '',
      pauseReason: '',
      pauseKinds: { download: '', 'vram-warning': '', confirmation: '', question: '' },
      failed: '',
      sessionLabel: '"{title}"',
      taskLabel: '',
      untitled: 'An agent run',
      answerButton: '💬 Answer',
      answerOnComputer: 'Answer on your computer',
    },
  })
}

let manager: typeof import('../../agent/piAgentManager')
let notifier: typeof import('../../agent/notifier')
let messageMap: typeof import('../../persist/channelMessageMap')

beforeAll(async () => {
  manager = await import('../../agent/piAgentManager')
  notifier = await import('../../agent/notifier')
  messageMap = await import('../../persist/channelMessageMap')
  const bus = await import('../../kernel/kernelBus')
  const readiness = await import('../../chat/chatReadiness')
  readiness.setChatReadinessDeps({
    getService: () => ({ ensureBackendReadiness: async () => {}, baseUrl: null }),
    awaitChatWindow: async () => {},
    stopOvmsImageServer: async () => {},
    notifyHomeAgentUpstreamReady: () => {},
  })
  const bridge = await import('../../artifact/rendererBridge')
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        if (channel !== 'artifact:request') return
        const { requestId } = payload as { requestId: string }
        queueMicrotask(() => bridge.handleMediaResponse({ requestId, result: { models: [] } }))
      },
    },
  }
  bus.setKernelEventWindow(fakeWindow as never)
  manager.setAgentModeMainWindow(fakeWindow as never)
  notifier.setNotificationChannelSend(async (kind, message) => {
    sent.push({ kind, ...message })
    return channelResult
  })
})

afterAll(async () => {
  await manager.shutdownAgentMode()
})

let workspace: string

beforeEach(() => {
  requests = []
  sent = []
  channelResult = { success: true, ref: '42' }
  route({ homeAgentEnabled: true, notificationChannel: 'telegram' })
  workspace = fs.mkdtempSync(path.join(tempRoot, 'ws-'))
})

function configFor(sessionId: string, capabilities: string[]): AgentModeTurnConfig {
  return {
    sessionId,
    workspaceDir: workspace,
    modelConfig: { source: 'local', model: 'model-a', baseUrl: BACKEND, contextWindow: 8192 },
    readiness: { serviceName: 'llamacpp-backend', llmModelName: 'model-a' },
    toolSpecs: [],
    capabilities,
  }
}

/** What the session told the model the tool returned. */
function toolResultText(): string {
  const tool = requests.flatMap((body) => body.messages ?? []).find((m) => m.role === 'tool')
  return typeof tool?.content === 'string' ? tool.content : JSON.stringify(tool?.content)
}

async function runTurn(sessionId: string, capabilities = ['notify']): Promise<void> {
  await manager.startAgentTurn(
    crypto.randomUUID(),
    'send me the news',
    configFor(sessionId, capabilities),
  )
}

describe('notify_user', () => {
  it('sends the message to the Notification Channel and tells the model it was delivered', async () => {
    await runTurn('aipg-agent-notify-ok')
    expect(sent).toEqual([
      {
        kind: 'telegram',
        text: `🤖 Agent · "An agent run"\n${SUMMARY}`,
        buttons: [[{ text: '💬 Answer', callbackData: 'answer' }]],
        answerTitle: '"An agent run"',
      },
    ])
    expect(toolResultText()).toBe('delivered')
  }, 30000)

  it('gives a LAN chat Notification the Answer button too, naming the session it answers', async () => {
    route({ homeAgentEnabled: true, notificationChannel: 'local-web' })
    await runTurn('aipg-agent-notify-lan')
    expect(sent).toEqual([
      {
        kind: 'local-web',
        text: `🤖 Agent · "An agent run"\n${SUMMARY}`,
        buttons: [[{ text: '💬 Answer', callbackData: 'answer' }]],
        answerTitle: '"An agent run"',
      },
    ])
  }, 30000)

  it('gives a session that uses the real system shell no Answer button, only a pointer to the computer', async () => {
    route({ homeAgentEnabled: true, notificationChannel: 'telegram' }, ['aipg-agent-notify-shell'])
    await runTurn('aipg-agent-notify-shell')
    expect(sent).toEqual([
      {
        kind: 'telegram',
        text: `🤖 Agent · "An agent run"\n${SUMMARY}\nAnswer on your computer`,
      },
    ])
  }, 30000)

  it('records the sent message so a reply to it reaches the session', async () => {
    await runTurn('aipg-agent-notify-answerable')
    expect(await messageMap.lookupChannelMessage('telegram', '42')).toBe(
      'aipg-agent-notify-answerable',
    )
  }, 30000)

  it('sends nothing with Home Agent off and returns the reason', async () => {
    route({ homeAgentEnabled: false, notificationChannel: 'telegram' })
    await runTurn('aipg-agent-notify-off')
    expect(sent).toEqual([])
    expect(toolResultText()).toContain('not delivered: Home Agent is off')
  }, 30000)

  it('sends nothing without a Notification Channel and returns the reason', async () => {
    route({ homeAgentEnabled: true, notificationChannel: null })
    await runTurn('aipg-agent-notify-none')
    expect(sent).toEqual([])
    expect(toolResultText()).toContain('not delivered: no Notification Channel set up')
  }, 30000)

  it('returns a channel send error as not delivered', async () => {
    channelResult = { success: false, error: 'Telegram not configured' }
    await runTurn('aipg-agent-notify-error')
    expect(sent).toHaveLength(1)
    expect(toolResultText()).toContain('not delivered: Telegram not configured')
  }, 30000)

  it('is absent from a session without the notify capability', async () => {
    await runTurn('aipg-agent-notify-unticked', [])
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((body) => !toolNames(body).includes('notify_user'))).toBe(true)
    expect(sent).toEqual([])
  }, 30000)
})
