import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { ChannelKind, KeyboardButton } from '@/assets/js/store/channels/types'
import type { ChatAskPayload } from '@/types/chatRequests'
import type { ChannelMedia, ChannelSendOutcome } from '../../agent/notifier'
import { thumbnailAnswer, type FakeThumbnail } from './fakeThumbnail'
import { sessionHolding } from './sessionHolding'

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
  getSessionsDir: () => path.join(tempRoot, 'sessions'),
}))

const BACKEND = 'http://fake-llm.test/v1'
const SUMMARY = 'Top story: the bridge reopened.'

type RequestBody = {
  messages?: Array<{ role: string; content?: unknown }>
  tools?: Array<{ function?: { name?: string } }>
}

let requests: RequestBody[] = []
let notifyArgs: Record<string, unknown> = { message: SUMMARY }

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
              function: { name: 'notify_user', arguments: JSON.stringify(notifyArgs) },
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
  media?: ChannelMedia
  buttons?: KeyboardButton[][]
  answerTitle?: string
}> = []
let channelResult: ChannelSendOutcome = { success: true, ref: '42' }
let channelResultFor: Partial<Record<ChannelKind, ChannelSendOutcome>> = {}
/** Refs handed out one per send before falling back to `channelResult`. */
let refs: string[] = []
let refusedFiles: string[] = []
let thumbnail: FakeThumbnail = { base64: 'anBlZw==' }

function route(channels: ChannelKind[], realShellSessions: string[] = []): void {
  notifier.setNotificationConfig({
    channels,
    sessionOnScreen: null,
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
      answerInThread: 'Reply in thread to answer.',
      answerByReply: '↩️ Reply to this message to answer.',
      queueDroppedOnQuit: 'Dropped {count}.',
      agentStarted: 'Started {name} in {title}.',
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
  })
  const bridge = await import('../../artifact/rendererBridge')
  const chatAsk = await import('../../chat/chatAsk')
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        const ask = payload as ChatAskPayload
        if (channel === 'chat:ask' && ask.kind === 'render-3d-thumbnail') {
          queueMicrotask(() => chatAsk.handleChatAnswer(thumbnailAnswer(ask.requestId, thumbnail)))
          return
        }
        if (channel !== 'artifact:request') return
        const { requestId } = payload as { requestId: string }
        queueMicrotask(() => bridge.handleMediaResponse({ requestId, result: { models: [] } }))
      },
    },
  }
  bus.setKernelEventWindow(fakeWindow as never)
  manager.setAgentModeMainWindow(fakeWindow as never)
  notifier.setNotificationChannel({
    typing: async () => ({ success: true }),
    send: async (kind, message) => {
      sent.push({ kind, ...message })
      if (refusedFiles.includes(message.media?.filename ?? ''))
        return { success: false, error: 'too large' }
      const forKind = channelResultFor[kind]
      if (forKind) return forKind
      const ref = refs.shift()
      return ref ? { success: true, ref } : channelResult
    },
  })
})

afterAll(async () => {
  await manager.shutdownAgentMode()
})

let workspace: string

beforeEach(() => {
  requests = []
  notifyArgs = { message: SUMMARY }
  sent = []
  channelResult = { success: true, ref: '42' }
  channelResultFor = {}
  refs = []
  refusedFiles = []
  thumbnail = { base64: 'anBlZw==' }
  route(['telegram'])
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

/** Runs a turn of `sessionId`, held by a Reachable Session unless `held` is false. */
async function runTurn(
  sessionId: string,
  capabilities = ['notify'],
  { held = true }: { held?: boolean } = {},
): Promise<void> {
  const { sessionOfHarnessSession } = await import('../../session/sessionHarness')
  if (held && !(await sessionOfHarnessSession(sessionId))) await sessionHolding(sessionId)
  await manager.startAgentTurn(
    crypto.randomUUID(),
    'send me the news',
    configFor(sessionId, capabilities),
  )
}

describe('notify_user', () => {
  it('sends the message to the Channel and tells the model it was delivered', async () => {
    await runTurn('aipg-agent-notify-ok')
    expect(sent).toEqual([
      {
        kind: 'telegram',
        text: `🤖 Agent · "An agent run"\n${SUMMARY}\n↩️ Reply to this message to answer.`,
      },
    ])
    expect(toolResultText()).toBe('delivered')
  }, 30000)

  it('gives a LAN chat Notification the Answer button, naming the session it answers', async () => {
    route(['local-web'])
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
    route(['telegram'], ['aipg-agent-notify-shell'])
    await runTurn('aipg-agent-notify-shell')
    expect(sent).toEqual([
      {
        kind: 'telegram',
        text: `🤖 Agent · "An agent run"\n${SUMMARY}\nAnswer on your computer`,
      },
    ])
  }, 30000)

  it('tells a Slack user to reply in the thread instead of showing a button', async () => {
    route(['slack'])
    await runTurn('aipg-agent-notify-slack')
    expect(sent).toEqual([
      {
        kind: 'slack',
        text: `🤖 Agent · "An agent run"\n${SUMMARY}\nReply in thread to answer.`,
      },
    ])
  }, 30000)

  it('points a Slack user at the computer for a session that uses the real system shell', async () => {
    route(['slack'], ['aipg-agent-notify-slack-shell'])
    await runTurn('aipg-agent-notify-slack-shell')
    expect(sent).toEqual([
      {
        kind: 'slack',
        text: `🤖 Agent · "An agent run"\n${SUMMARY}\nAnswer on your computer`,
      },
    ])
  }, 30000)

  it('records the sent message as its Session’s, so a reply to it reaches the session', async () => {
    const sessionRef = await sessionHolding('aipg-agent-notify-answerable')
    await runTurn('aipg-agent-notify-answerable')
    expect(await messageMap.channelMessageOwner('telegram', '42')).toEqual({
      sessionRef,
      harnessSessionId: 'aipg-agent-notify-answerable',
    })
  }, 30000)

  it('sends nothing for a Session that is not reachable and returns the reason', async () => {
    await sessionHolding('aipg-agent-notify-unreachable', { reachable: false })
    await runTurn('aipg-agent-notify-unreachable')
    expect(sent).toEqual([])
    expect(toolResultText()).toContain('not delivered: the Session is not reachable from Channels')
  }, 30000)

  it('sends nothing for a Harness Session no Session holds, such as a Trial Run’s', async () => {
    await runTurn('aipg-agent-notify-trial-run', ['notify'], { held: false })
    expect(sent).toEqual([])
    expect(toolResultText()).toContain('not delivered: the Session is not reachable from Channels')
  }, 30000)

  it('sends nothing while the Channels toggle is off or no Channel is set up', async () => {
    route([])
    await runTurn('aipg-agent-notify-off')
    expect(sent).toEqual([])
    expect(toolResultText()).toContain('not delivered: no Channel is on')
  }, 30000)

  it('sends to every Channel and is delivered when any of them took it', async () => {
    route(['telegram', 'slack'])
    channelResultFor = { telegram: { success: false, error: 'Telegram not configured' } }
    await runTurn('aipg-agent-notify-every')
    expect(sent.map((s) => s.kind)).toEqual(['telegram', 'slack'])
    expect(toolResultText()).toBe('delivered')
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

describe('notify_user attachments', () => {
  const caption = `🤖 Agent · "An agent run"\n${SUMMARY}\n↩️ Reply to this message to answer.`

  function attach(relativePath: string, bytes: Buffer | string = 'media bytes'): void {
    const file = path.join(workspace, relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
  }

  it('sends an attached image as a photo captioned with the Notification text', async () => {
    attach('generated/cover.png', 'png bytes')
    notifyArgs = { message: SUMMARY, attachments: ['generated/cover.png'] }
    await runTurn('aipg-agent-notify-photo')
    expect(sent).toEqual([
      {
        kind: 'telegram',
        text: caption,
        media: {
          kind: 'photo',
          base64: Buffer.from('png bytes').toString('base64'),
          filename: 'cover.png',
        },
      },
    ])
    expect(toolResultText()).toBe('delivered')
  }, 30000)

  it('sends an attached clip as a video captioned with the Notification text', async () => {
    attach('generated/clip.webm', 'webm bytes')
    notifyArgs = { message: SUMMARY, attachments: ['generated/clip.webm'] }
    await runTurn('aipg-agent-notify-video')
    expect(sent).toEqual([
      {
        kind: 'telegram',
        text: caption,
        media: {
          kind: 'video',
          base64: Buffer.from('webm bytes').toString('base64'),
          filename: 'clip.webm',
        },
      },
    ])
  }, 30000)

  it('sends an attached speech clip as a voice message captioned with the Notification text', async () => {
    attach('generated/summary.wav', 'wav bytes')
    notifyArgs = { message: SUMMARY, attachments: ['generated/summary.wav'] }
    await runTurn('aipg-agent-notify-voice')
    expect(sent).toEqual([
      {
        kind: 'telegram',
        text: caption,
        media: {
          kind: 'voice',
          base64: Buffer.from('wav bytes').toString('base64'),
          filename: 'summary.wav',
        },
      },
    ])
    expect(toolResultText()).toBe('delivered')
  }, 30000)

  it('records the sent attachment so a reply to it reaches the session', async () => {
    attach('shot.jpg')
    notifyArgs = { message: SUMMARY, attachments: ['shot.jpg'] }
    channelResult = { success: true, ref: '77' }
    const sessionRef = await sessionHolding('aipg-agent-notify-photo-answerable')
    await runTurn('aipg-agent-notify-photo-answerable')
    expect(await messageMap.channelMessageOwner('telegram', '77')).toEqual({
      sessionRef,
      harnessSessionId: 'aipg-agent-notify-photo-answerable',
    })
  }, 30000)

  it('sends nothing for an unsupported file and names it, why, and what is allowed', async () => {
    attach('generated/model.obj')
    notifyArgs = { message: SUMMARY, attachments: ['generated/model.obj'] }
    await runTurn('aipg-agent-notify-obj')
    expect(sent).toEqual([])
    const result = toolResultText()
    expect(result).toContain('generated/model.obj')
    expect(result).toContain('unsupported file type')
    expect(result).toContain('png, jpg, jpeg, webp')
    expect(result).toContain('mp4, webm')
    expect(result).toContain('glb')
  }, 30000)

  it('sends an attached 3D model as its screenshot captioned with the text, then the file', async () => {
    attach('generated/ship.glb', 'glb bytes')
    notifyArgs = { message: SUMMARY, attachments: ['generated/ship.glb'] }
    await runTurn('aipg-agent-notify-glb')
    expect(sent).toEqual([
      {
        kind: 'telegram',
        text: caption,
        media: { kind: 'photo', base64: 'anBlZw==', filename: 'ship.jpg' },
      },
      {
        kind: 'telegram',
        text: '',
        media: {
          kind: 'document',
          base64: Buffer.from('glb bytes').toString('base64'),
          filename: 'ship.glb',
        },
      },
    ])
    expect(toolResultText()).toBe('delivered')
  }, 30000)

  it('sends a 3D model among other attachments in the order the agent listed them', async () => {
    attach('generated/cover.png')
    attach('generated/ship.glb')
    attach('generated/clip.mp4')
    notifyArgs = {
      message: SUMMARY,
      attachments: ['generated/cover.png', 'generated/ship.glb', 'generated/clip.mp4'],
    }
    await runTurn('aipg-agent-notify-glb-mixed')
    expect(sent.map(({ text, media }) => [text, media?.kind, media?.filename])).toEqual([
      [caption, 'photo', 'cover.png'],
      ['', 'photo', 'ship.jpg'],
      ['', 'document', 'ship.glb'],
      ['', 'video', 'clip.mp4'],
    ])
  }, 30000)

  it('sends the text alone first when a 3D model without a screenshot comes first', async () => {
    attach('generated/ship.glb')
    thumbnail = { error: 'model load timed out' }
    notifyArgs = { message: SUMMARY, attachments: ['generated/ship.glb'] }
    await runTurn('aipg-agent-notify-glb-unrendered')
    expect(sent.map(({ text, media }) => [text, media?.kind, media?.filename])).toEqual([
      [caption, undefined, undefined],
      ['', 'document', 'ship.glb'],
    ])
    expect(toolResultText()).toBe('delivered')
  }, 30000)

  it('delivers the text and screenshot of a 3D model too large for the channel and says the file was not sent', async () => {
    const file = path.join(workspace, 'generated', 'huge.glb')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
    fs.truncateSync(file, 50 * 1024 * 1024 + 1)
    refusedFiles = ['huge.glb']
    notifyArgs = { message: SUMMARY, attachments: ['generated/huge.glb'] }
    await runTurn('aipg-agent-notify-glb-huge')
    expect(sent.map(({ text, media }) => [text, media?.kind, media?.filename])).toEqual([
      [caption, 'photo', 'huge.jpg'],
      ['', 'document', 'huge.glb'],
    ])
    expect(toolResultText()).toBe('delivered (3D file not sent: huge.glb: too large)')
  }, 30000)

  it('names every 3D file the channel refused in one Notification', async () => {
    attach('generated/ship.glb')
    attach('generated/rover.glb')
    refusedFiles = ['ship.glb', 'rover.glb']
    notifyArgs = { message: SUMMARY, attachments: ['generated/ship.glb', 'generated/rover.glb'] }
    await runTurn('aipg-agent-notify-glb-refused')
    expect(sent.map(({ text, media }) => [text, media?.kind, media?.filename])).toEqual([
      [caption, 'photo', 'ship.jpg'],
      ['', 'document', 'ship.glb'],
      ['', 'photo', 'rover.jpg'],
      ['', 'document', 'rover.glb'],
    ])
    expect(toolResultText()).toBe(
      'delivered (3D file not sent: ship.glb: too large; rover.glb: too large)',
    )
  }, 30000)

  it('sends nothing for a missing file and names it', async () => {
    notifyArgs = { message: SUMMARY, attachments: ['generated/nowhere.png'] }
    await runTurn('aipg-agent-notify-missing')
    expect(sent).toEqual([])
    expect(toolResultText()).toContain('generated/nowhere.png: file not found')
  }, 30000)

  it('sends nothing for a file outside the session workspace', async () => {
    fs.writeFileSync(path.join(tempRoot, 'outside.png'), 'secret')
    const outside = path.relative(workspace, path.join(tempRoot, 'outside.png'))
    notifyArgs = { message: SUMMARY, attachments: [outside] }
    await runTurn('aipg-agent-notify-outside')
    expect(sent).toEqual([])
    expect(toolResultText()).toContain(`${outside}: outside the workspace`)
  }, 30000)

  it('sends nothing for a file over the channel size limit', async () => {
    const file = path.join(workspace, 'huge.mp4')
    fs.writeFileSync(file, '')
    fs.truncateSync(file, 50 * 1024 * 1024 + 1)
    notifyArgs = { message: SUMMARY, attachments: ['huge.mp4'] }
    await runTurn('aipg-agent-notify-huge')
    expect(sent).toEqual([])
    expect(toolResultText()).toContain('huge.mp4: larger than the 50 MB telegram allows')
  }, 30000)

  it('tells the model which extensions it can attach and that generated files need attaching', async () => {
    await runTurn('aipg-agent-notify-describe')
    const tool = (
      requests[0].tools as Array<{ function?: { name?: string; description?: string } }>
    ).find((entry) => entry.function?.name === 'notify_user')
    const description = JSON.stringify(tool)
    expect(description).toContain('png, jpg, jpeg, webp')
    expect(description).toContain('mp4, webm')
    expect(description).toContain('wav, mp3, ogg')
    expect(description).toContain('3D model: glb')
    expect(description).toMatch(/picture of it plus the file/i)
    expect(description).toMatch(/not sent unless/i)
  }, 30000)

  it('captions the first of several attachments and sends the rest after it, in order', async () => {
    attach('generated/cover.png', 'png bytes')
    attach('generated/clip.mp4', 'mp4 bytes')
    attach('generated/back.jpg', 'jpg bytes')
    notifyArgs = {
      message: SUMMARY,
      attachments: ['generated/cover.png', 'generated/clip.mp4', 'generated/back.jpg'],
    }
    await runTurn('aipg-agent-notify-several')
    expect(sent.map(({ text, media }) => [text, media?.kind, media?.filename])).toEqual([
      [caption, 'photo', 'cover.png'],
      ['', 'video', 'clip.mp4'],
      ['', 'photo', 'back.jpg'],
    ])
    expect(toolResultText()).toBe('delivered')
  }, 30000)

  it('sends text too long for a Telegram caption first, then every attachment uncaptioned', async () => {
    attach('generated/cover.png', 'png bytes')
    attach('generated/clip.mp4', 'mp4 bytes')
    const long = 'x'.repeat(1100)
    notifyArgs = { message: long, attachments: ['generated/cover.png', 'generated/clip.mp4'] }
    await runTurn('aipg-agent-notify-long')
    expect(sent.map(({ text, media }) => [text, media?.filename])).toEqual([
      [`🤖 Agent · "An agent run"\n${long}\n↩️ Reply to this message to answer.`, undefined],
      ['', 'cover.png'],
      ['', 'clip.mp4'],
    ])
  }, 30000)

  it('records every message of the Notification so a reply to any of them reaches the session', async () => {
    attach('a.png')
    attach('b.webm')
    notifyArgs = { message: SUMMARY, attachments: ['a.png', 'b.webm'] }
    refs = ['81', '82']
    const sessionRef = await sessionHolding('aipg-agent-notify-several-answerable')
    await runTurn('aipg-agent-notify-several-answerable')
    for (const ref of ['81', '82']) {
      expect(await messageMap.channelMessageOwner('telegram', ref)).toEqual({
        sessionRef,
        harnessSessionId: 'aipg-agent-notify-several-answerable',
      })
    }
  }, 30000)

  it('sends none of several attachments when one of them cannot be sent', async () => {
    attach('generated/cover.png')
    notifyArgs = { message: SUMMARY, attachments: ['generated/cover.png', 'generated/gone.mp4'] }
    await runTurn('aipg-agent-notify-several-missing')
    expect(sent).toEqual([])
    expect(toolResultText()).toContain('generated/gone.mp4: file not found')
  }, 30000)

  it('keeps the Answer button on the captioned attachment on LAN chat', async () => {
    route(['local-web'])
    attach('a.png')
    attach('b.png')
    notifyArgs = { message: SUMMARY, attachments: ['a.png', 'b.png'] }
    await runTurn('aipg-agent-notify-lan-media')
    expect(sent.map(({ text, media, buttons }) => [text, media?.filename, buttons])).toEqual([
      [
        `🤖 Agent · "An agent run"\n${SUMMARY}`,
        'a.png',
        [[{ text: '💬 Answer', callbackData: 'answer' }]],
      ],
      ['', 'b.png', undefined],
    ])
  }, 30000)
})
