import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { ChatAskPayload } from '@/types/chatRequests'
import type { NotificationConfig } from '@/types/notificationsIpc'
import type { PermissionsPromptPayload } from '@/types/permissionsIpc'

// Automatic Notifications for a Background Session, seen at the Channel: a real Pi
// session against a fake backend calls a speech tool and waits on the window, the
// test raises the prompts that pause it or makes the model call fail, and a fake
// channel records what is sent.

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-auto-notify-')))
const sessionsDir = path.join(tempRoot, 'agent-sessions')
const tasksFile = path.join(tempRoot, 'agent-tasks.json')
const messageMapFile = path.join(tempRoot, 'channel-messages.json')

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot, isPackaged: false, getAppPath: () => tempRoot },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
}))

vi.mock('../../persist/userDataPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../persist/userDataPaths')>()),
  getAgentSessionsDir: () => sessionsDir,
  getAgentTasksFile: () => tasksFile,
  getChannelMessageMapFile: () => messageMapFile,
}))

const BACKEND = 'http://fake-llm.test/v1'

let modelRetired = false

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
  if (modelRetired) {
    return new Response(JSON.stringify({ error: { message: 'model test-model was retired' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
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
  realShellSessions: [],
  templates: {
    header: '🤖 Agent · {title}',
    paused: '⏸ {title} is waiting for you: {reason}. Open AI Playground to continue.',
    pauseReason: '{kind} ({summary})',
    pauseKinds: {
      download: 'a model download',
      'vram-warning': 'a VRAM warning',
      confirmation: 'a confirmation',
      question: 'a question',
    },
    failed: '❌ {title} failed: {error}. Open AI Playground for details.',
    sessionLabel: '"{title}"',
    taskLabel: '"{task}" (step {step}/{steps})',
    untitled: 'An agent run',
    answerButton: '💬 Answer',
    answerOnComputer: 'Answer on your computer',
  },
}

type Sent = { kind: ChannelKind; text: string; replyTo?: string; media?: string }
let sent: Sent[] = []
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
let taskFiles: typeof import('../../persist/agentTaskFiles')
let messageMap: typeof import('../../persist/channelMessageMap')

beforeAll(async () => {
  manager = await import('../../agent/piAgentManager')
  notifier = await import('../../agent/notifier')
  chatAsk = await import('../../chat/chatAsk')
  promptAdapter = await import('../../permissions/promptAdapter')
  permissions = await import('../../permissions/permissionsService')
  userWait = await import('../../kernel/userWait')
  sessionFiles = await import('../../persist/agentSessionFiles')
  taskFiles = await import('../../persist/agentTaskFiles')
  messageMap = await import('../../persist/channelMessageMap')
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
  notifier.setNotificationChannelSend(async (kind, message) => {
    sent.push({
      kind,
      text: message.text,
      replyTo: message.replyTo,
      media: message.media && `${message.media.kind}:${message.media.filename}`,
    })
    return { success: true, ref: `msg-${sent.length}` }
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
  modelRetired = false
  fs.rmSync(tasksFile, { force: true })
  fs.rmSync(messageMapFile, { force: true })
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
async function withWaitingTurn(
  sessionId: string,
  whileWaiting: () => Promise<void>,
  config: AgentModeTurnConfig = configFor(sessionId),
) {
  const run = manager.startAgentTurn(crypto.randomUUID(), 'say hi', config)
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

async function pauseForQuestion(): Promise<void> {
  pauseFor(SESSION, 'question', 'Which colour?')
  await settle()
  userWait.setAwaitingUser(SESSION, false)
}

const QUESTION_TEXT =
  '🤖 Agent · "Morning news"\n⏸ "Morning news" is waiting for you: a question (Which colour?). ' +
  'Open AI Playground to continue.'

describe('a Background Session pausing for the user', () => {
  it('sends one Notification naming the session and the question', async () => {
    await withWaitingTurn(SESSION, pauseForQuestion)
    expect(sent).toEqual([{ kind: 'telegram', text: QUESTION_TEXT }])
  }, 30000)

  it('sends no Notification for a download pause, which the window asks as a Channel Question', async () => {
    await withWaitingTurn(SESSION, pauseForDownload)
    expect(sent).toEqual([])
  }, 30000)

  it('sends nothing while the turn waits on its Model Download after the answer', async () => {
    await withWaitingTurn(SESSION, async () => {
      const consent = permissions.requestDownloadConsent([{ repo_id: 'org/kokoro-voice.gguf' }])
      const remote = await nextPrompt('is-remote')
      promptAdapter.handlePermissionsPromptResponse({ requestId: remote.requestId, result: false })
      const download = await nextPrompt('download')
      expect(userWait.isWaitingOnUser(SESSION)).toBe(true)
      promptAdapter.handlePermissionsPromptResponse({
        requestId: download.requestId,
        answered: true,
      })
      expect(userWait.isWaitingOnUser(SESSION)).toBe(false)
      await settle()
      promptAdapter.handlePermissionsPromptResponse({ requestId: download.requestId, result: true })
      await consent
    })
    expect(sent).toEqual([])
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
      '🤖 Agent · "Morning news"\n⏸ "Morning news" is waiting for you: a VRAM warning (Flux). Open AI Playground to continue.',
      '🤖 Agent · "Morning news"\n⏸ "Morning news" is waiting for you: a confirmation (Continue in Game Agent?). ' +
        'Open AI Playground to continue.',
      '🤖 Agent · "Morning news"\n⏸ "Morning news" is waiting for you: a question (Which colour?). ' +
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
      '🤖 Agent · "An agent run"\n⏸ "An agent run" is waiting for you: a question (Which colour?). ' +
        'Open AI Playground to continue.',
    ])
  }, 30000)

  it('stays quiet for the session open on screen', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionInView: SESSION })
    await withWaitingTurn(SESSION, pauseForQuestion)
    expect(sent).toEqual([])
  }, 30000)

  it('notifies for the open session while the window is hidden or minimized', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionInView: SESSION })
    windowShown = false
    await withWaitingTurn(SESSION, pauseForQuestion)
    expect(sent).toEqual([{ kind: 'telegram', text: QUESTION_TEXT }])
  }, 30000)

  it.each([
    ['automatic Notifications are off', { autoNotify: false }],
    ['Home Agent is off', { homeAgentEnabled: false }],
    ['no Notification Channel is set up', { notificationChannel: null }],
  ])(
    'sends nothing when %s',
    async (_case, override) => {
      notifier.setNotificationConfig({ ...CONFIG, ...override })
      await withWaitingTurn(SESSION, pauseForQuestion)
      expect(sent).toEqual([])
    },
    30000,
  )
})

const TASK_SESSION = 'aipg-agent-task-run'

/** Saves a "Daily digest" Task whose run is in flight in `TASK_SESSION`. */
async function saveTaskRun(activeRun?: { stepIndex: number; stepCount: number }) {
  await sessionFiles.saveAgentSession({
    id: TASK_SESSION,
    workspaceDir: tempRoot,
    title: 'Fetch the headlines',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  })
  await taskFiles.saveAgentTask({
    id: 'task-digest',
    name: 'Daily digest',
    workspaceDir: tempRoot,
    settingsTemplate: { capabilities: ['media'] },
    steps: ['one', 'two', 'three'].map((prompt) => ({ id: prompt, prompt })),
    createdAt: 1,
    updatedAt: 1,
    ...(activeRun ? { activeRun: { sessionId: TASK_SESSION, ...activeRun } } : {}),
  })
}

describe('a Task run', () => {
  it('is labelled by its Task name and step when it pauses', async () => {
    await saveTaskRun({ stepIndex: 2, stepCount: 3 })
    await withWaitingTurn(TASK_SESSION, async () => {
      pauseFor(TASK_SESSION, 'question', 'Which source?')
      await settle()
      userWait.setAwaitingUser(TASK_SESSION, false)
    })
    expect(sent.map((s) => s.text)).toEqual([
      '🤖 Agent · "Daily digest" (step 2/3)\n⏸ "Daily digest" (step 2/3) is waiting for you: a question (Which source?). ' +
        'Open AI Playground to continue.',
    ])
  }, 30000)

  it('is labelled the same way when it fails', async () => {
    await saveTaskRun({ stepIndex: 3, stepCount: 3 })
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', configFor(TASK_SESSION))
    await settle()
    expect(sent.map((s) => s.text)).toEqual([
      '🤖 Agent · "Daily digest" (step 3/3)\n❌ "Daily digest" (step 3/3) failed: 400: model test-model was retired. ' +
        'Open AI Playground for details.',
    ])
  }, 30000)

  it('falls back to the Task name when the step cannot be resolved', async () => {
    await saveTaskRun({ stepIndex: 0, stepCount: 0 })
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', configFor(TASK_SESSION))
    await settle()
    expect(sent.map((s) => s.text)).toEqual([
      '🤖 Agent · "Daily digest"\n❌ "Daily digest" failed: 400: model test-model was retired. Open AI Playground for details.',
    ])
  }, 30000)

  it('keeps the session title once the run is over', async () => {
    await saveTaskRun()
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', configFor(TASK_SESSION))
    await settle()
    expect(sent.map((s) => s.text)).toEqual([
      '🤖 Agent · "Fetch the headlines"\n❌ "Fetch the headlines" failed: 400: model test-model was retired. ' +
        'Open AI Playground for details.',
    ])
  }, 30000)
})

describe('a sent Notification', () => {
  async function failingTurn(): Promise<void> {
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', configFor(SESSION))
    await settle()
  }

  it('is recorded under its channel and message, so a reply to it finds the session', async () => {
    await failingTurn()
    expect(sent).toHaveLength(1)
    expect(await messageMap.lookupChannelMessage('telegram', 'msg-1')).toBe(SESSION)
    expect(await messageMap.lookupChannelMessage('slack', 'msg-1')).toBeNull()
    expect(await messageMap.lookupChannelMessage('telegram', 'msg-2')).toBeNull()
  }, 30000)

  it('is forgotten when its session is deleted, but still known as a deleted session’s', async () => {
    await failingTurn()
    await messageMap.forgetSessionMessages(SESSION)
    expect(await messageMap.lookupChannelMessage('telegram', 'msg-1')).toBeNull()
    expect(await messageMap.channelMessageOwner('telegram', 'msg-1')).toEqual({
      deletedSession: true,
    })
    expect(await messageMap.channelMessageOwner('telegram', 'msg-2')).toBeNull()
  }, 30000)
})

describe('a Background Session whose turn fails', () => {
  const FAILED_TEXT =
    '🤖 Agent · "Morning news"\n❌ "Morning news" failed: 400: model test-model was retired. Open AI Playground for details.'

  async function failingTurn(): Promise<void> {
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', configFor(SESSION))
    await settle()
  }

  it('sends one Notification with the error the app shows', async () => {
    await failingTurn()
    expect(sent).toEqual([{ kind: 'telegram', text: FAILED_TEXT }])
  }, 30000)

  it('stays quiet for the session open on screen', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionInView: SESSION })
    await failingTurn()
    expect(sent).toEqual([])
  }, 30000)

  it('notifies for the open session while the window is hidden or minimized', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionInView: SESSION })
    windowShown = false
    await failingTurn()
    expect(sent.map((m) => m.text)).toEqual([FAILED_TEXT])
  }, 30000)

  it.each([
    ['automatic Notifications are off', { autoNotify: false }],
    ['Home Agent is off', { homeAgentEnabled: false }],
    ['no Notification Channel is set up', { notificationChannel: null }],
  ])(
    'sends nothing when %s',
    async (_case, override) => {
      notifier.setNotificationConfig({ ...CONFIG, ...override })
      await failingTurn()
      expect(sent).toEqual([])
    },
    30000,
  )

  it('sends nothing when the turn succeeds', async () => {
    await withWaitingTurn(SESSION, async () => {})
    await settle()
    expect(sent).toEqual([])
  }, 30000)

  it('sends nothing when the user stops the turn and its held prompt is dropped', async () => {
    const run = manager.startAgentTurn(crypto.randomUUID(), 'say hi', configFor(SESSION))
    await vi.waitFor(() => expect(asks).toHaveLength(1))
    // The pause itself would notify; only what follows the stop is under test.
    notifier.setNotificationConfig({ ...CONFIG, autoNotify: false })
    const consent = permissions.requestDownloadConsent([{ repo_id: 'voice' }]).catch(() => {})
    const remote = await nextPrompt('is-remote')
    promptAdapter.handlePermissionsPromptResponse({ requestId: remote.requestId, result: false })
    const download = await nextPrompt('download')
    notifier.setNotificationConfig(CONFIG)

    manager.cancelAgentTurn(SESSION)
    await run
    promptAdapter.handlePermissionsPromptResponse({
      requestId: download.requestId,
      error: 'The turn that asked has ended.',
      cancelled: true,
    })
    await consent
    await settle()
    expect(sent).toEqual([])
  }, 30000)

  it('sends nothing when the app shuts down mid-turn', async () => {
    const run = manager.startAgentTurn(crypto.randomUUID(), 'say hi', configFor(SESSION))
    await vi.waitFor(() => expect(asks).toHaveLength(1))
    await manager.shutdownAgentMode()
    await run
    await settle()
    expect(sent).toEqual([])
  }, 30000)
})

describe('the turn an Answer started', () => {
  const ANSWER = { channel: 'telegram' as const, replyTo: 'answer-77' }
  const answerTurn = (): AgentModeTurnConfig => ({ ...configFor(SESSION), answer: ANSWER })

  it('replies under the Answer with the agent header and its final text', async () => {
    await withWaitingTurn(SESSION, async () => {}, answerTurn())
    await settle()
    expect(sent).toEqual([
      { kind: 'telegram', text: '🤖 Agent · "Morning news"\ndone', replyTo: 'answer-77' },
    ])
  }, 30000)

  it('replies even with automatic Notifications off and the session in view', async () => {
    notifier.setNotificationConfig({ ...CONFIG, autoNotify: false, sessionInView: SESSION })
    await withWaitingTurn(SESSION, async () => {}, answerTurn())
    await settle()
    expect(sent.map((s) => s.replyTo)).toEqual(['answer-77'])
  }, 30000)

  it('replies on the channel the Answer came from', async () => {
    await withWaitingTurn(SESSION, async () => {}, {
      ...configFor(SESSION),
      answer: { channel: 'slack', replyTo: '1700000000.0001' },
    })
    await settle()
    expect(sent).toEqual([
      {
        kind: 'slack',
        text: '🤖 Agent · "Morning news"\ndone',
        replyTo: '1700000000.0001',
      },
    ])
  }, 30000)

  it('notifies a pause under the Answer although the session is in view', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionInView: SESSION })
    await withWaitingTurn(SESSION, pauseForQuestion, answerTurn())
    await settle()
    expect(sent).toEqual([
      { kind: 'telegram', text: QUESTION_TEXT, replyTo: 'answer-77' },
      { kind: 'telegram', text: '🤖 Agent · "Morning news"\ndone', replyTo: 'answer-77' },
    ])
  }, 30000)

  it('notifies its failure under the Answer although the session is in view', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionInView: SESSION })
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', answerTurn())
    await settle()
    expect(sent).toEqual([
      {
        kind: 'telegram',
        text:
          '🤖 Agent · "Morning news"\n❌ "Morning news" failed: 400: model test-model was retired. ' +
          'Open AI Playground for details.',
        replyTo: 'answer-77',
      },
    ])
  }, 30000)

  it('records its reply, so replying to that is again an Answer to the session', async () => {
    await withWaitingTurn(SESSION, async () => {}, answerTurn())
    await settle()
    expect(await messageMap.lookupChannelMessage('telegram', 'msg-1')).toBe(SESSION)
  }, 30000)

  it('leaves the next turn of the session to the normal Notification rules', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionInView: SESSION })
    await withWaitingTurn(SESSION, async () => {}, answerTurn())
    await settle()
    sent = []
    asks = []
    await withWaitingTurn(SESSION, pauseForQuestion)
    await settle()
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', configFor(SESSION))
    await settle()
    expect(sent).toEqual([])
  }, 30000)

  it('sends the media the turn generated under the Answer too', async () => {
    const config = answerTurn()
    const generated = path.join(config.workspaceDir, 'generated')
    fs.mkdirSync(generated, { recursive: true })
    for (const file of ['cover.png', 'intro.mp4', 'ship.glb']) {
      fs.writeFileSync(path.join(generated, file), 'bytes')
    }
    const media = await import('../../agent/generatedMedia')
    await withWaitingTurn(
      SESSION,
      async () => {
        media.noteGeneratedMedia(config.workspaceDir, [
          'generated/cover.png',
          'generated/intro.mp4',
          'generated/ship.glb',
        ])
      },
      config,
    )
    await settle()
    const header = '🤖 Agent · "Morning news"'
    expect(sent).toEqual([
      { kind: 'telegram', text: `${header}\ndone`, replyTo: 'answer-77' },
      { kind: 'telegram', text: header, replyTo: 'answer-77', media: 'photo:cover.png' },
      { kind: 'telegram', text: header, replyTo: 'answer-77', media: 'video:intro.mp4' },
    ])
  }, 30000)
})
