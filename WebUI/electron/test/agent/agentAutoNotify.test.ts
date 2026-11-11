import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { ChatAskPayload } from '@/types/chatRequests'
import type { NotificationConfig } from '@/types/notificationsIpc'
import type { PermissionsPromptPayload } from '@/types/permissionsIpc'
import { thumbnailAnswer, type FakeThumbnail } from './fakeThumbnail'
import { sessionHolding } from './sessionHolding'
import { sessionOfHarnessSession } from '../../session/sessionHarness'
import { plainTextOf } from '../../agent/channelText'

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
  getSessionsDir: () => path.join(tempRoot, 'sessions'),
  getAudioDir: () => path.join(tempRoot, 'audio'),
}))

const BACKEND = 'http://fake-llm.test/v1'

let modelRetired = false
/** What the model answers once its tool has run. */
let finalText = 'done'
/** When set, the step after the speech result sends this file with `notify_user`. */
let notifyAttachment: string | null = null
/** The clip the window hands back for the speech request. */
let clipBase64 = ''
/** What the model says before its tool call, which a Channel sees streaming. */
let narration = ''

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
function toolCall(name: string, args: unknown) {
  return [
    ...(narration ? [completion({ role: 'assistant', content: narration })] : []),
    completion({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `call-${name}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
    completion({}, 'tool_calls'),
  ]
}

function reply(body: { messages?: Array<{ role: string }> }): Response {
  if (modelRetired) {
    return new Response(JSON.stringify({ error: { message: 'model test-model was retired' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const toolResults = body.messages?.filter((message) => message.role === 'tool').length ?? 0
  const chunks =
    toolResults === 0
      ? toolCall('synthesizeTextToSpeech', { text: 'hi' })
      : toolResults === 1 && notifyAttachment
        ? toolCall('notify_user', { message: 'listen', attachments: [notifyAttachment] })
        : [completion({ role: 'assistant', content: finalText }), completion({}, 'stop')]
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
/** The Session holding SESSION. */
let newsSessionRef = ''

const CONFIG: NotificationConfig = {
  channels: ['telegram'],
  sessionOnScreen: null,
  realShellSessions: [],
  templates: {
    header: '🤖 Agent · {title}',
    paused: '⏸ Waiting for you: {reason}. Open AI Playground to continue.',
    pauseReason: '{kind} ({summary})',
    pauseKinds: {
      download: 'a model download',
      'vram-warning': 'a VRAM warning',
      confirmation: 'a confirmation',
      question: 'a question',
    },
    failed: '❌ Failed: {error}. Open AI Playground for details.',
    sessionLabel: '"{title}"',
    taskLabel: '"{task}" (step {step}/{steps})',
    untitled: 'An agent run',
    answerButton: '💬 Answer',
    answerOnComputer: 'Answer on your computer',
    answerInThread: 'Reply in thread to answer.',
    answerByReply: '↩️ Reply to this message to answer.',
    queueDroppedOnQuit: 'Dropped {count}.',
    agentStarted: '▶️ Started “{name}” in {title}.',
  },
}

type Sent = {
  kind: ChannelKind
  text: string
  replyTo?: string
  media?: string
  buttons?: unknown
  plain?: boolean
}
let sent: Sent[] = []
/** Each streamed draft edit, and the draft each final message settled. */
let drafts: Array<{ kind: ChannelKind; id: number; ref?: string; text: string }> = []
let settled: Array<{ kind: ChannelKind; text: string; draft?: number }> = []
let typing: Array<{ kind: ChannelKind; typing: 'start' | 'stop' }> = []
let asks: ChatAskPayload[] = []
let prompts: PermissionsPromptPayload[] = []
let windowShown = true
let refusedFiles: string[] = []
let failingKinds: ChannelKind[] = []
let thumbnail: FakeThumbnail = { base64: 'anBlZw==' }
let thumbnailAsks: string[] = []

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
  })
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        const ask = payload as ChatAskPayload
        if (channel === 'chat:ask' && ask.kind === 'render-3d-thumbnail') {
          thumbnailAsks.push(ask.modelBase64)
          queueMicrotask(() => chatAsk.handleChatAnswer(thumbnailAnswer(ask.requestId, thumbnail)))
        } else if (channel === 'chat:ask') asks.push(ask)
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
  notifier.setNotificationChannel({
    draft: async (kind, draft, text) => {
      drafts.push({ kind, id: draft.id, ref: draft.ref, text: plainTextOf(text) })
      return kind === 'slack' && !draft.ref
        ? { success: true, ref: `draft-${draft.id}`, chat: 'D1' }
        : { success: true }
    },
    typing: async (kind, state) => {
      typing.push({ kind, typing: state })
      return { success: true }
    },
    send: async (kind, message) => {
      const text = plainTextOf(message)
      if (message.draft) settled.push({ kind, text, draft: message.draft.id })
      sent.push({
        kind,
        text,
        replyTo: message.replyTo,
        media: message.media && `${message.media.kind}:${message.media.filename}`,
        buttons: message.buttons,
        plain: message.plain,
      })
      if (failingKinds.includes(kind)) return { success: false, error: `${kind} is down` }
      if (refusedFiles.includes(message.media?.filename ?? ''))
        return { success: false, error: 'too large' }
      return { success: true, ref: `msg-${sent.length}` }
    },
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
  newsSessionRef = await sessionHolding(SESSION)
})

afterAll(async () => {
  await manager.shutdownAgentMode()
})

beforeEach(() => {
  sent = []
  drafts = []
  settled = []
  narration = ''
  typing = []
  asks = []
  prompts = []
  windowShown = true
  modelRetired = false
  finalText = 'done'
  notifyAttachment = null
  clipBase64 = ''
  refusedFiles = []
  failingKinds = []
  thumbnail = { base64: 'anBlZw==' }
  thumbnailAsks = []
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
    result: { audioBase64: clipBase64, mediaType: 'audio/wav', voice: 'test', engine: 'kokoro' },
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

/** The last line of a Telegram Notification that is not itself a reply to an Answer. */
const REPLY_HINT = '\n↩️ Reply to this message to answer.'

const QUESTION_TEXT =
  '🤖 Agent · "Morning news"\n⏸ Waiting for you: a question (Which colour?). ' +
  'Open AI Playground to continue.'

describe('a Background Session pausing for the user', () => {
  it('sends one Notification naming the session and the question', async () => {
    await withWaitingTurn(SESSION, pauseForQuestion)
    expect(sent).toEqual([{ kind: 'telegram', text: QUESTION_TEXT + REPLY_HINT, plain: true }])
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
      '🤖 Agent · "Morning news"\n⏸ Waiting for you: a VRAM warning (Flux). Open AI Playground to continue.' +
        REPLY_HINT,
      '🤖 Agent · "Morning news"\n⏸ Waiting for you: a confirmation (Continue in Game Agent?). ' +
        'Open AI Playground to continue.' +
        REPLY_HINT,
      '🤖 Agent · "Morning news"\n⏸ Waiting for you: a question (Which colour?). ' +
        'Open AI Playground to continue.' +
        REPLY_HINT,
    ])
  }, 30000)

  it('labels a Session with no title and no Harness Session record as an agent run', async () => {
    await sessionHolding('aipg-agent-fresh')
    await withWaitingTurn('aipg-agent-fresh', async () => {
      pauseFor('aipg-agent-fresh', 'question', 'Which colour?')
      await settle()
      userWait.setAwaitingUser('aipg-agent-fresh', false)
    })
    expect(sent.map((s) => s.text)).toEqual([
      '🤖 Agent · "An agent run"\n⏸ Waiting for you: a question (Which colour?). ' +
        'Open AI Playground to continue.' +
        REPLY_HINT,
    ])
  }, 30000)

  it('names its Session, not the Harness Session', async () => {
    const sessions = await import('../../session/sessions')
    await sessions.renameSession(newsSessionRef, 'Breakfast briefing')
    try {
      await withWaitingTurn(SESSION, pauseForQuestion)
    } finally {
      await sessions.mutateSession(newsSessionRef, (file) => ({ ...file, title: '' }))
    }
    expect(sent.map((s) => s.text)).toEqual([
      '🤖 Agent · "Breakfast briefing"\n⏸ Waiting for you: a question (Which colour?). ' +
        'Open AI Playground to continue.' +
        REPLY_HINT,
    ])
  }, 30000)

  it('sends nothing for a Trial Run, whose Harness Session no Session holds', async () => {
    await withWaitingTurn('aipg-agent-trial', async () => {
      pauseFor('aipg-agent-trial', 'question', 'Which colour?')
      await settle()
      userWait.setAwaitingUser('aipg-agent-trial', false)
    })
    expect(sent).toEqual([])
  }, 30000)

  it('notifies every enabled, verified Channel, recording each message', async () => {
    notifier.setNotificationConfig({ ...CONFIG, channels: ['telegram', 'slack', 'local-web'] })
    await withWaitingTurn(SESSION, pauseForQuestion)
    expect(sent.map((s) => s.kind)).toEqual(['telegram', 'slack', 'local-web'])
    expect(sent[1].text).toBe(`${QUESTION_TEXT}\nReply in thread to answer.`)
    for (const [index, kind] of (['telegram', 'slack', 'local-web'] as const).entries()) {
      expect(await messageMap.channelMessageOwner(kind, `msg-${index + 1}`)).toEqual({
        sessionRef: newsSessionRef,
        harnessSessionId: SESSION,
      })
    }
  }, 30000)

  it('notifies another Channel when one fails to send', async () => {
    notifier.setNotificationConfig({ ...CONFIG, channels: ['telegram', 'slack'] })
    failingKinds = ['telegram']
    await withWaitingTurn(SESSION, pauseForQuestion)
    expect(sent.map((s) => s.kind)).toEqual(['telegram', 'slack'])
    expect(await messageMap.channelMessageOwner('slack', 'msg-2')).toEqual({
      sessionRef: newsSessionRef,
      harnessSessionId: SESSION,
    })
  }, 30000)

  it('stays quiet for the session open on screen', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionOnScreen: newsSessionRef })
    await withWaitingTurn(SESSION, pauseForQuestion)
    expect(sent).toEqual([])
  }, 30000)

  it('notifies for the open session while the window is hidden or minimized', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionOnScreen: newsSessionRef })
    windowShown = false
    await withWaitingTurn(SESSION, pauseForQuestion)
    expect(sent).toEqual([{ kind: 'telegram', text: QUESTION_TEXT + REPLY_HINT, plain: true }])
  }, 30000)

  it.each([['the Channels toggle is off', { channels: [] }]])(
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
    ...(activeRun
      ? { activeRuns: [{ sessionId: TASK_SESSION, sessionRef: 'session-1', ...activeRun }] }
      : {}),
  })
}

describe('a Task run', () => {
  beforeAll(async () => {
    const sessions = await import('../../session/sessions')
    await sessions.renameSession(await sessionHolding(TASK_SESSION), 'Weekday news')
  })

  it('is labelled by its Session, Task name and step when it pauses', async () => {
    await saveTaskRun({ stepIndex: 2, stepCount: 3 })
    await withWaitingTurn(TASK_SESSION, async () => {
      pauseFor(TASK_SESSION, 'question', 'Which source?')
      await settle()
      userWait.setAwaitingUser(TASK_SESSION, false)
    })
    expect(sent.map((s) => s.text)).toEqual([
      '🤖 Agent · "Weekday news" · "Daily digest" (step 2/3)\n⏸ Waiting for you: a question (Which source?). ' +
        'Open AI Playground to continue.' +
        REPLY_HINT,
    ])
  }, 30000)

  it('is labelled the same way when it fails', async () => {
    await saveTaskRun({ stepIndex: 3, stepCount: 3 })
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', configFor(TASK_SESSION))
    await settle()
    expect(sent.map((s) => s.text)).toEqual([
      '🤖 Agent · "Weekday news" · "Daily digest" (step 3/3)\n❌ Failed: 400: model test-model was retired. ' +
        'Open AI Playground for details.' +
        REPLY_HINT,
    ])
  }, 30000)

  it('falls back to the Task name when the step cannot be resolved', async () => {
    await saveTaskRun({ stepIndex: 0, stepCount: 0 })
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', configFor(TASK_SESSION))
    await settle()
    expect(sent.map((s) => s.text)).toEqual([
      '🤖 Agent · "Weekday news" · "Daily digest"\n❌ Failed: 400: model test-model was retired. Open AI Playground for details.' +
        REPLY_HINT,
    ])
  }, 30000)

  it('names only its Session once the run is over', async () => {
    await saveTaskRun()
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', configFor(TASK_SESSION))
    await settle()
    expect(sent.map((s) => s.text)).toEqual([
      '🤖 Agent · "Weekday news"\n❌ Failed: 400: model test-model was retired. ' +
        'Open AI Playground for details.' +
        REPLY_HINT,
    ])
  }, 30000)
})

describe('a Scheduled Run’s last Step', () => {
  const EVERY: ChannelKind[] = ['telegram', 'slack']
  const step = (stepIndex: number, notifiesResult?: boolean): AgentModeTurnConfig => ({
    ...configFor(TASK_SESSION),
    taskRun: { taskName: 'Daily digest', stepIndex, ...(notifiesResult ? { notifiesResult } : {}) },
  })

  beforeEach(async () => {
    await saveTaskRun({ stepIndex: 3, stepCount: 3 })
    notifier.setNotificationConfig({ ...CONFIG, channels: EVERY })
  })

  it('sends its result to every Channel, recorded as the Session’s', async () => {
    await withWaitingTurn(TASK_SESSION, async () => {}, step(3, true))
    await settle()
    const header = '🤖 Agent · "Weekday news" · "Daily digest" (step 3/3)'
    expect(sent).toEqual([
      { kind: 'telegram', text: `${header}\ndone${REPLY_HINT}` },
      { kind: 'slack', text: `${header}\ndone\nReply in thread to answer.` },
    ])
    expect(await messageMap.channelMessageOwner('slack', 'msg-2')).toMatchObject({
      harnessSessionId: TASK_SESSION,
    })
  }, 30000)

  it('sends the media it generated to every Channel too', async () => {
    const config = step(3, true)
    const generated = path.join(config.workspaceDir, 'generated')
    fs.mkdirSync(generated, { recursive: true })
    fs.writeFileSync(path.join(generated, 'chart.png'), 'bytes')
    const media = await import('../../agent/generatedMedia')
    await withWaitingTurn(
      TASK_SESSION,
      async () => media.noteGeneratedMedia(config.workspaceDir, ['generated/chart.png']),
      config,
    )
    await settle()
    expect(sent.filter((s) => s.media).map((s) => [s.kind, s.media])).toEqual([
      ['telegram', 'photo:chart.png'],
      ['slack', 'photo:chart.png'],
    ])
  }, 30000)

  it('sends nothing for an earlier Step or a run nobody scheduled', async () => {
    await withWaitingTurn(TASK_SESSION, async () => {}, step(2))
    asks = []
    await withWaitingTurn(TASK_SESSION, async () => {}, step(3))
    await settle()
    expect(sent).toEqual([])
  }, 30000)

  it('sends nothing while the Channels toggle is off', async () => {
    notifier.setNotificationConfig({ ...CONFIG, channels: [] })
    await withWaitingTurn(TASK_SESSION, async () => {}, step(3, true))
    await settle()
    expect(sent).toEqual([])
  }, 30000)
})

describe('an Agent Run started from a Channel', () => {
  const STARTED_BY = { channel: 'telegram' as const, replyTo: 'agents-12' }
  const step = (stepIndex: number, last = false): AgentModeTurnConfig => ({
    ...configFor(TASK_SESSION),
    answer: STARTED_BY,
    taskRun: { taskName: 'Daily digest', stepIndex, ...(last ? { notifiesResult: true } : {}) },
  })
  const header = '🤖 Agent · "Weekday news" · "Daily digest" (step 3/3)'

  beforeEach(async () => {
    await saveTaskRun({ stepIndex: 3, stepCount: 3 })
    notifier.setNotificationConfig({ ...CONFIG, channels: ['telegram', 'slack'] })
  })

  it('says it started, then reports only its result, to the starting Channel alone', async () => {
    await withWaitingTurn(TASK_SESSION, async () => {}, step(1))
    asks = []
    await withWaitingTurn(TASK_SESSION, async () => {}, step(2))
    asks = []
    finalText = 'Three headlines.'
    await withWaitingTurn(TASK_SESSION, async () => {}, step(3, true))
    await settle()
    expect(sent).toEqual([
      {
        kind: 'telegram',
        text: '▶️ Started “Daily digest” in "Weekday news".',
        replyTo: 'agents-12',
        plain: true,
      },
      { kind: 'telegram', text: `${header}\nThree headlines.`, replyTo: 'agents-12' },
    ])
  }, 30000)

  it('records its result, so a reply to it reaches the run’s Harness Session', async () => {
    await withWaitingTurn(TASK_SESSION, async () => {}, step(3, true))
    await settle()
    const result = sent.findIndex((s) => s.text.includes('\ndone'))
    expect(await messageMap.channelMessageOwner('telegram', `msg-${result + 1}`)).toMatchObject({
      harnessSessionId: TASK_SESSION,
    })
  }, 30000)

  it('sends what its earlier Steps generated with its result', async () => {
    const media = await import('../../agent/generatedMedia')
    const first = step(1)
    const generated = path.join(first.workspaceDir, 'generated')
    fs.mkdirSync(generated, { recursive: true })
    fs.writeFileSync(path.join(generated, 'chart.png'), 'bytes')
    await withWaitingTurn(
      TASK_SESSION,
      async () => media.noteGeneratedMedia(first.workspaceDir, ['generated/chart.png']),
      first,
    )
    await settle()
    expect(sent.filter((s) => s.media)).toEqual([])
    asks = []
    await withWaitingTurn(TASK_SESSION, async () => {}, step(3, true))
    await vi.waitFor(() =>
      expect(sent.filter((s) => s.media).map((s) => [s.kind, s.media])).toEqual([
        ['telegram', 'photo:chart.png'],
      ]),
    )
  }, 30000)

  it('notifies a failed Step on the starting Channel, although the Session is on screen', async () => {
    notifier.setNotificationConfig({
      ...CONFIG,
      channels: ['telegram', 'slack'],
      sessionOnScreen: await sessionOfHarnessSession(TASK_SESSION),
    })
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', step(2))
    await vi.waitFor(() =>
      expect(sent.map((s) => [s.kind, s.replyTo, s.text.includes('❌ Failed')])).toEqual([
        ['telegram', 'agents-12', true],
      ]),
    )
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
    expect(await messageMap.channelMessageOwner('telegram', 'msg-1')).toEqual({
      sessionRef: newsSessionRef,
      harnessSessionId: SESSION,
    })
    expect(await messageMap.channelMessageOwner('slack', 'msg-1')).toBeNull()
    expect(await messageMap.channelMessageOwner('telegram', 'msg-2')).toBeNull()
  }, 30000)

  it('is forgotten when its session is deleted, but still known as a deleted session’s', async () => {
    await failingTurn()
    await messageMap.forgetHarnessSessionMessages(SESSION)
    expect(await messageMap.channelMessageOwner('telegram', 'msg-1')).toEqual({
      deletedSession: true,
    })
    expect(await messageMap.channelMessageOwner('telegram', 'msg-2')).toBeNull()
  }, 30000)
})

describe('a Background Session whose turn fails', () => {
  const FAILED_TEXT =
    '🤖 Agent · "Morning news"\n❌ Failed: 400: model test-model was retired. Open AI Playground for details.'

  async function failingTurn(): Promise<void> {
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', configFor(SESSION))
    await settle()
  }

  it('sends one Notification with the error the app shows', async () => {
    await failingTurn()
    expect(sent).toEqual([{ kind: 'telegram', text: FAILED_TEXT + REPLY_HINT, plain: true }])
  }, 30000)

  it('stays quiet for the session open on screen', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionOnScreen: newsSessionRef })
    await failingTurn()
    expect(sent).toEqual([])
  }, 30000)

  it('notifies for the open session while the window is hidden or minimized', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionOnScreen: newsSessionRef })
    windowShown = false
    await failingTurn()
    expect(sent.map((m) => m.text)).toEqual([FAILED_TEXT + REPLY_HINT])
  }, 30000)

  it.each([['the Channels toggle is off', { channels: [] }]])(
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
    notifier.setNotificationConfig({ ...CONFIG, channels: [] })
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

describe('a Session that is not reachable', () => {
  let reachability: typeof import('../../session/sessionChannels')

  beforeAll(async () => {
    reachability = await import('../../session/sessionChannels')
  })

  afterEach(async () => {
    await reachability.setSessionReachable(newsSessionRef, true)
  })

  it('sends nothing when it pauses or fails off screen', async () => {
    await reachability.setSessionReachable(newsSessionRef, false)
    await withWaitingTurn(SESSION, pauseForQuestion)
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', configFor(SESSION))
    await settle()
    expect(sent).toEqual([])
  }, 30000)

  it('sends no reply to a turn started from a Channel once made unreachable', async () => {
    const answer = { channel: 'telegram' as const, replyTo: 'answer-78' }
    await withWaitingTurn(
      SESSION,
      () => reachability.setSessionReachable(newsSessionRef, false).then(() => {}),
      { ...configFor(SESSION), answer },
    )
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

  it('replies, pauses and fails on the asking Channel alone, with every Channel enabled', async () => {
    notifier.setNotificationConfig({ ...CONFIG, channels: ['slack', 'telegram', 'local-web'] })
    await withWaitingTurn(SESSION, pauseForQuestion, answerTurn())
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', answerTurn())
    await settle()
    expect(sent.map((s) => [s.kind, s.replyTo])).toEqual([
      ['telegram', 'answer-77'],
      ['telegram', 'answer-77'],
      ['telegram', 'answer-77'],
    ])
  }, 30000)

  it('sends nothing once the asking Channel is turned off', async () => {
    notifier.setNotificationConfig({ ...CONFIG, channels: ['slack'] })
    await withWaitingTurn(SESSION, pauseForQuestion, answerTurn())
    await settle()
    expect(sent).toEqual([])
  }, 30000)

  it('replies although the session is on screen', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionOnScreen: newsSessionRef })
    await withWaitingTurn(SESSION, async () => {}, answerTurn())
    await settle()
    expect(sent.map((s) => s.replyTo)).toEqual(['answer-77'])
  }, 30000)

  it('replies on the channel the Answer came from', async () => {
    notifier.setNotificationConfig({ ...CONFIG, channels: ['telegram', 'slack'] })
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
    expect(await messageMap.channelMessageOwner('slack', 'msg-1')).toEqual({
      sessionRef: newsSessionRef,
      harnessSessionId: SESSION,
    })
  }, 30000)

  it('notifies a pause under the Answer although the session is in view', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionOnScreen: newsSessionRef })
    await withWaitingTurn(SESSION, pauseForQuestion, answerTurn())
    await settle()
    expect(sent).toEqual([
      { kind: 'telegram', text: QUESTION_TEXT, replyTo: 'answer-77', plain: true },
      { kind: 'telegram', text: '🤖 Agent · "Morning news"\ndone', replyTo: 'answer-77' },
    ])
  }, 30000)

  it('notifies its failure under the Answer although the session is in view', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionOnScreen: newsSessionRef })
    modelRetired = true
    await manager.startAgentTurn(crypto.randomUUID(), 'hi', answerTurn())
    await settle()
    expect(sent).toEqual([
      {
        kind: 'telegram',
        text:
          '🤖 Agent · "Morning news"\n❌ Failed: 400: model test-model was retired. ' +
          'Open AI Playground for details.',
        replyTo: 'answer-77',
        plain: true,
      },
    ])
  }, 30000)

  it('sends no text when the turn wrote none, not an earlier turn’s reply', async () => {
    const config = configFor(SESSION)
    await withWaitingTurn(SESSION, async () => {}, config)
    await settle()
    expect(sent).toEqual([])
    finalText = ''
    expect(
      await manager.startAgentTurn(crypto.randomUUID(), 'and now?', { ...config, answer: ANSWER }),
    ).toEqual({ success: true })
    await settle()
    expect(sent).toEqual([])
  }, 30000)

  describe('streams its reply', () => {
    const header = '🤖 Agent · "Morning news"'

    it('into one draft naming its Session, which its final text settles', async () => {
      narration = 'Let me say it.'
      await withWaitingTurn(
        SESSION,
        async () => {
          await vi.waitFor(() => expect(drafts).toHaveLength(1))
        },
        answerTurn(),
      )
      await settle()
      expect(drafts).toEqual([
        { kind: 'telegram', id: expect.any(Number), text: `${header}\nLet me say it.` },
      ])
      expect(sent).toEqual([{ kind: 'telegram', text: `${header}\ndone`, replyTo: 'answer-77' }])
      expect(settled).toEqual([{ kind: 'telegram', text: `${header}\ndone`, draft: drafts[0].id }])
    }, 30000)

    it('as a Slack message recorded as the Session’s, so a reply to it is an Answer', async () => {
      narration = 'Let me say it.'
      notifier.setNotificationConfig({ ...CONFIG, channels: ['slack'] })
      await withWaitingTurn(
        SESSION,
        async () => {
          await vi.waitFor(async () =>
            expect(await messageMap.channelMessageOwner('slack', `draft-${drafts[0]?.id}`)).toEqual(
              { sessionRef: newsSessionRef, harnessSessionId: SESSION },
            ),
          )
        },
        { ...configFor(SESSION), answer: { channel: 'slack', replyTo: '1700000000.0001' } },
      )
      await settle()
      expect(settled).toEqual([{ kind: 'slack', text: `${header}\ndone`, draft: drafts[0].id }])
    }, 30000)

    it('and settles what it streamed before a failure reports it', async () => {
      narration = 'Let me say it.'
      await withWaitingTurn(
        SESSION,
        async () => {
          await vi.waitFor(() => expect(drafts).toHaveLength(1))
          modelRetired = true
        },
        answerTurn(),
      ).catch(() => {})
      await settle()
      expect(sent.map((s) => s.text)).toEqual([
        `${header}\nLet me say it.`,
        `${header}\n❌ Failed: 400: model test-model was retired. Open AI Playground for details.`,
      ])
      expect(settled.map((s) => s.draft)).toEqual([drafts[0].id])
    }, 30000)

    it('but not for a turn no Channel caused', async () => {
      narration = 'Let me say it.'
      await withWaitingTurn(SESSION, async () => {}, configFor(SESSION))
      await settle()
      expect(drafts).toEqual([])
    }, 30000)
  })

  it('records its reply, so replying to that is again an Answer to the session', async () => {
    await withWaitingTurn(SESSION, async () => {}, answerTurn())
    await settle()
    expect(await messageMap.channelMessageOwner('telegram', 'msg-1')).toEqual({
      sessionRef: newsSessionRef,
      harnessSessionId: SESSION,
    })
  }, 30000)

  describe('started by a voice message', () => {
    const header = '🤖 Agent · "Morning news"'
    const spokenAnswer = (): AgentModeTurnConfig => ({
      ...configFor(SESSION),
      answer: { ...ANSWER, voice: true },
    })

    it('speaks its reply after the text when the turn has the speech tool', async () => {
      await withWaitingTurn(SESSION, async () => {}, spokenAnswer())
      await vi.waitFor(() => expect(asks).toHaveLength(2))
      expect(asks[1]).toMatchObject({
        kind: 'channel-voice-reply',
        channel: 'telegram',
        text: 'done',
        replyTo: 'answer-77',
      })
      chatAsk.handleChatAnswer({
        requestId: asks[1].requestId,
        result: { audioBase64: 'UklGRg==', mediaType: 'audio/wav' },
      })
      await settle()
      expect(sent).toEqual([
        { kind: 'telegram', text: `${header}\ndone`, replyTo: 'answer-77' },
        { kind: 'telegram', text: header, replyTo: 'answer-77', media: 'voice:reply.wav' },
      ])
    }, 30000)

    it('is not spoken again when the turn already sent a voice clip', async () => {
      const config = spokenAnswer()
      const generated = path.join(config.workspaceDir, 'generated')
      fs.mkdirSync(generated, { recursive: true })
      fs.writeFileSync(path.join(generated, 'speech.wav'), 'RIFF')
      const media = await import('../../agent/generatedMedia')
      await withWaitingTurn(
        SESSION,
        async () => {
          media.noteGeneratedMedia(config.workspaceDir, ['generated/speech.wav'])
          await vi.waitFor(() => expect(sent).toHaveLength(1))
        },
        config,
      )
      await settle()
      expect(asks).toHaveLength(1)
      expect(sent).toEqual([
        { kind: 'telegram', text: header, replyTo: 'answer-77', media: 'voice:speech.wav' },
        { kind: 'telegram', text: `${header}\ndone`, replyTo: 'answer-77' },
      ])
    }, 30000)

    it('sends the text alone when no spoken reply could be made', async () => {
      await withWaitingTurn(SESSION, async () => {}, spokenAnswer())
      await vi.waitFor(() => expect(asks).toHaveLength(2))
      chatAsk.handleChatAnswer({ requestId: asks[1].requestId, result: null })
      await settle()
      expect(sent).toEqual([{ kind: 'telegram', text: `${header}\ndone`, replyTo: 'answer-77' }])
    }, 30000)

    it('is not spoken when the turn has no speech tool', async () => {
      const config = { ...spokenAnswer(), toolSpecs: [] }
      expect(await manager.startAgentTurn(crypto.randomUUID(), 'say hi', config)).toEqual({
        success: true,
      })
      await settle()
      expect(asks).toEqual([])
      expect(sent).toEqual([{ kind: 'telegram', text: `${header}\ndone`, replyTo: 'answer-77' }])
    }, 30000)

    it('is not spoken for a typed Answer', async () => {
      await withWaitingTurn(SESSION, async () => {}, answerTurn())
      await settle()
      expect(asks).toHaveLength(1)
    }, 30000)
  })

  it('leaves the next turn of the session to the normal Notification rules', async () => {
    notifier.setNotificationConfig({ ...CONFIG, sessionOnScreen: newsSessionRef })
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

  it('sends the media the turn generates under the Answer as soon as it is made', async () => {
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
        await vi.waitFor(() => expect(sent).toHaveLength(4))
      },
      config,
    )
    await settle()
    const header = '🤖 Agent · "Morning news"'
    expect(sent).toEqual([
      { kind: 'telegram', text: header, replyTo: 'answer-77', media: 'photo:cover.png' },
      { kind: 'telegram', text: header, replyTo: 'answer-77', media: 'video:intro.mp4' },
      { kind: 'telegram', text: header, replyTo: 'answer-77', media: 'photo:ship.jpg' },
      { kind: 'telegram', text: '', replyTo: 'answer-77', media: 'document:ship.glb' },
      { kind: 'telegram', text: `${header}\ndone`, replyTo: 'answer-77' },
    ])
    expect(thumbnailAsks).toEqual([Buffer.from('bytes').toString('base64')])
  }, 30000)

  it('sends a 3D model without its screenshot when the window cannot render one', async () => {
    const config = answerTurn()
    const generated = path.join(config.workspaceDir, 'generated')
    fs.mkdirSync(generated, { recursive: true })
    fs.writeFileSync(path.join(generated, 'ship.glb'), 'bytes')
    thumbnail = { error: 'model load timed out' }
    const { appLoggerInstance } = await import('../../observability/logger')
    const warn = vi.spyOn(appLoggerInstance, 'warn')
    const media = await import('../../agent/generatedMedia')
    await withWaitingTurn(
      SESSION,
      async () => media.noteGeneratedMedia(config.workspaceDir, ['generated/ship.glb']),
      config,
    )
    await settle()
    const header = '🤖 Agent · "Morning news"'
    expect(sent).toEqual([
      { kind: 'telegram', text: '', replyTo: 'answer-77', media: 'document:ship.glb' },
      { kind: 'telegram', text: `${header}\ndone`, replyTo: 'answer-77' },
    ])
    expect(warn).toHaveBeenCalledWith(
      '3D screenshot not rendered: model load timed out',
      'notifier',
    )
    warn.mockRestore()
  }, 30000)

  it('logs a 3D model the channel refused and sends nothing else for it', async () => {
    const config = answerTurn()
    const generated = path.join(config.workspaceDir, 'generated')
    fs.mkdirSync(generated, { recursive: true })
    for (const file of ['ship.glb', 'cover.png']) {
      fs.writeFileSync(path.join(generated, file), 'bytes')
    }
    refusedFiles = ['ship.glb']
    const { appLoggerInstance } = await import('../../observability/logger')
    const warn = vi.spyOn(appLoggerInstance, 'warn')
    const media = await import('../../agent/generatedMedia')
    await withWaitingTurn(
      SESSION,
      async () => {
        media.noteGeneratedMedia(config.workspaceDir, ['generated/ship.glb', 'generated/cover.png'])
      },
      config,
    )
    await settle()
    const header = '🤖 Agent · "Morning news"'
    expect(sent).toEqual([
      { kind: 'telegram', text: header, replyTo: 'answer-77', media: 'photo:ship.jpg' },
      { kind: 'telegram', text: '', replyTo: 'answer-77', media: 'document:ship.glb' },
      { kind: 'telegram', text: header, replyTo: 'answer-77', media: 'photo:cover.png' },
      { kind: 'telegram', text: `${header}\ndone`, replyTo: 'answer-77' },
    ])
    expect(warn).toHaveBeenCalledWith('answer media not delivered: too large', 'notifier')
    warn.mockRestore()
  }, 30000)

  it('sends the speech the turn generated as a voice message under the Answer', async () => {
    clipBase64 = Buffer.from('RIFF-wav').toString('base64')
    await withWaitingTurn(SESSION, async () => {}, answerTurn())
    await settle()
    const header = '🤖 Agent · "Morning news"'
    expect(sent).toEqual([
      { kind: 'telegram', text: header, replyTo: 'answer-77', media: 'voice:speech.wav' },
      { kind: 'telegram', text: `${header}\ndone`, replyTo: 'answer-77' },
    ])
  }, 30000)

  it('leaves out of notify_user what the turn already sent as it was made', async () => {
    clipBase64 = Buffer.from('RIFF-wav').toString('base64')
    notifyAttachment = 'generated/speech.wav'
    await withWaitingTurn(SESSION, async () => {}, {
      ...answerTurn(),
      capabilities: ['media', 'notify'],
    })
    await settle()
    const header = '🤖 Agent · "Morning news"'
    // The clip and the notify_user step race; neither carries the clip twice.
    expect(sent.slice(0, 2)).toEqual(
      expect.arrayContaining([
        { kind: 'telegram', text: header, replyTo: 'answer-77', media: 'voice:speech.wav' },
        { kind: 'telegram', text: `${header}\nlisten`, replyTo: 'answer-77' },
      ]),
    )
    expect(sent.slice(2)).toEqual([
      { kind: 'telegram', text: `${header}\ndone`, replyTo: 'answer-77' },
    ])
  }, 30000)

  it('leaves out of notify_user a 3D model the turn already sent as it was made', async () => {
    const config = { ...answerTurn(), capabilities: ['media', 'notify'] }
    const generated = path.join(config.workspaceDir, 'generated')
    fs.mkdirSync(generated, { recursive: true })
    fs.writeFileSync(path.join(generated, 'ship.glb'), 'bytes')
    notifyAttachment = 'generated/ship.glb'
    const media = await import('../../agent/generatedMedia')
    await withWaitingTurn(
      SESSION,
      async () => {
        media.noteGeneratedMedia(config.workspaceDir, ['generated/ship.glb'])
        await vi.waitFor(() => expect(sent).toHaveLength(2))
      },
      config,
    )
    await settle()
    const header = '🤖 Agent · "Morning news"'
    expect(sent).toEqual([
      { kind: 'telegram', text: header, replyTo: 'answer-77', media: 'photo:ship.jpg' },
      { kind: 'telegram', text: '', replyTo: 'answer-77', media: 'document:ship.glb' },
      { kind: 'telegram', text: `${header}\nlisten`, replyTo: 'answer-77' },
      { kind: 'telegram', text: `${header}\ndone`, replyTo: 'answer-77' },
    ])
  }, 30000)

  describe('shows typing', () => {
    const TELEGRAM_START = { kind: 'telegram', typing: 'start' }

    beforeEach(() => {
      notifier.setNotificationConfig({ ...CONFIG, channels: ['telegram', 'slack', 'local-web'] })
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('once its turn runs, repeated every 4 s, and not after it ends', async () => {
      await withWaitingTurn(
        SESSION,
        async () => {
          expect(typing).toEqual([TELEGRAM_START])
          vi.advanceTimersByTime(4000)
          vi.advanceTimersByTime(4000)
          expect(typing).toEqual([TELEGRAM_START, TELEGRAM_START, TELEGRAM_START])
        },
        answerTurn(),
      )
      await settle()
      typing = []
      vi.advanceTimersByTime(12000)
      expect(typing).toEqual([])
    }, 30000)

    it('not while its turn waits in the queue behind another', async () => {
      const other = manager.startAgentTurn(
        crypto.randomUUID(),
        'say hi',
        configFor('aipg-agent-other'),
      )
      await vi.waitFor(() => expect(asks).toHaveLength(1))
      const run = manager.startAgentTurn(crypto.randomUUID(), 'say hi', answerTurn())
      await settle()
      vi.advanceTimersByTime(8000)
      expect(typing).toEqual([])

      chatAsk.handleChatAnswer({
        requestId: asks[0].requestId,
        result: { audioBase64: '', mediaType: 'audio/wav', voice: 'test', engine: 'kokoro' },
      })
      expect(await other).toEqual({ success: true })
      await vi.waitFor(() => expect(asks).toHaveLength(2))
      expect(typing).toEqual([TELEGRAM_START])
      chatAsk.handleChatAnswer({
        requestId: asks[1].requestId,
        result: { audioBase64: '', mediaType: 'audio/wav', voice: 'test', engine: 'kokoro' },
      })
      expect(await run).toEqual({ success: true })
    }, 30000)

    it('stops while the turn is paused on the user and resumes after', async () => {
      await withWaitingTurn(
        SESSION,
        async () => {
          pauseFor(SESSION, 'question', 'Which colour?')
          await settle()
          typing = []
          vi.advanceTimersByTime(12000)
          expect(typing).toEqual([])
          userWait.setAwaitingUser(SESSION, false)
          expect(typing).toEqual([TELEGRAM_START])
          vi.advanceTimersByTime(4000)
          expect(typing).toEqual([TELEGRAM_START, TELEGRAM_START])
        },
        answerTurn(),
      )
    }, 30000)

    it('with an explicit stop on LAN chat, at a pause and at the end', async () => {
      const lan = { kind: 'local-web' }
      await withWaitingTurn(
        SESSION,
        async () => {
          pauseFor(SESSION, 'question', 'Which colour?')
          await settle()
          userWait.setAwaitingUser(SESSION, false)
        },
        { ...configFor(SESSION), answer: { channel: 'local-web', replyTo: '5' } },
      )
      await settle()
      expect(typing).toEqual([
        { ...lan, typing: 'start' },
        { ...lan, typing: 'stop' },
        { ...lan, typing: 'start' },
        { ...lan, typing: 'stop' },
      ])
    }, 30000)

    it('until a failed turn ends', async () => {
      modelRetired = true
      await manager.startAgentTurn(crypto.randomUUID(), 'hi', {
        ...configFor(SESSION),
        answer: { channel: 'local-web', replyTo: '5' },
      })
      await settle()
      expect(typing.at(-1)).toEqual({ kind: 'local-web', typing: 'stop' })
      typing = []
      vi.advanceTimersByTime(12000)
      expect(typing).toEqual([])
    }, 30000)

    it('until the user stops the turn', async () => {
      const run = manager.startAgentTurn(crypto.randomUUID(), 'say hi', {
        ...configFor(SESSION),
        answer: { channel: 'local-web', replyTo: '5' },
      })
      await vi.waitFor(() => expect(asks).toHaveLength(1))
      manager.cancelAgentTurn(SESSION)
      await run
      await settle()
      expect(typing.at(-1)).toEqual({ kind: 'local-web', typing: 'stop' })
      typing = []
      vi.advanceTimersByTime(12000)
      expect(typing).toEqual([])
    }, 30000)

    it('for one Answer turn at a time, leaking none across turns', async () => {
      await withWaitingTurn(SESSION, async () => {}, answerTurn())
      asks = []
      await withWaitingTurn(SESSION, async () => {}, answerTurn())
      await settle()
      typing = []
      vi.advanceTimersByTime(12000)
      expect(typing).toEqual([])
    }, 30000)

    it('never on Slack', async () => {
      await withWaitingTurn(
        SESSION,
        async () => {
          vi.advanceTimersByTime(8000)
        },
        { ...configFor(SESSION), answer: { channel: 'slack', replyTo: '1700000000.0001' } },
      )
      await settle()
      expect(typing).toEqual([])
    }, 30000)
  })
})
