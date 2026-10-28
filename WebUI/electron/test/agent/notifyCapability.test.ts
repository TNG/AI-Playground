import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { ChannelKind, KeyboardButton } from '@/assets/js/store/channels/types'
import type { NotificationRoute } from '@/types/notificationsIpc'
import type { ChannelMedia, ChannelSendOutcome } from '../../agent/notifier'

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
/** Refs handed out one per send before falling back to `channelResult`. */
let refs: string[] = []

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
      answerInThread: 'Reply in thread to answer.',
      answerByReply: '↩️ Reply to this message to answer.',
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
  notifier.setNotificationChannel({
    typing: async () => ({ success: true }),
    send: async (kind, message) => {
      sent.push({ kind, ...message })
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
  refs = []
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
        text: `🤖 Agent · "An agent run"\n${SUMMARY}\n↩️ Reply to this message to answer.`,
      },
    ])
    expect(toolResultText()).toBe('delivered')
  }, 30000)

  it('gives a LAN chat Notification the Answer button, naming the session it answers', async () => {
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

  it('tells a Slack user to reply in the thread instead of showing a button', async () => {
    route({ homeAgentEnabled: true, notificationChannel: 'slack' })
    await runTurn('aipg-agent-notify-slack')
    expect(sent).toEqual([
      {
        kind: 'slack',
        text: `🤖 Agent · "An agent run"\n${SUMMARY}\nReply in thread to answer.`,
      },
    ])
  }, 30000)

  it('points a Slack user at the computer for a session that uses the real system shell', async () => {
    route({ homeAgentEnabled: true, notificationChannel: 'slack' }, [
      'aipg-agent-notify-slack-shell',
    ])
    await runTurn('aipg-agent-notify-slack-shell')
    expect(sent).toEqual([
      {
        kind: 'slack',
        text: `🤖 Agent · "An agent run"\n${SUMMARY}\nAnswer on your computer`,
      },
    ])
  }, 30000)

  it('records the sent message so a reply to it reaches the session', async () => {
    await runTurn('aipg-agent-notify-answerable')
    expect(await messageMap.channelMessageOwner('telegram', '42')).toEqual({
      sessionId: 'aipg-agent-notify-answerable',
    })
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
    await runTurn('aipg-agent-notify-photo-answerable')
    expect(await messageMap.channelMessageOwner('telegram', '77')).toEqual({
      sessionId: 'aipg-agent-notify-photo-answerable',
    })
  }, 30000)

  it('sends nothing for an unsupported file and names it, why, and what is allowed', async () => {
    attach('generated/model.glb')
    notifyArgs = { message: SUMMARY, attachments: ['generated/model.glb'] }
    await runTurn('aipg-agent-notify-glb')
    expect(sent).toEqual([])
    const result = toolResultText()
    expect(result).toContain('generated/model.glb')
    expect(result).toContain('unsupported file type')
    expect(result).toContain('png, jpg, jpeg, webp')
    expect(result).toContain('mp4, webm')
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
    await runTurn('aipg-agent-notify-several-answerable')
    for (const ref of ['81', '82']) {
      expect(await messageMap.channelMessageOwner('telegram', ref)).toEqual({
        sessionId: 'aipg-agent-notify-several-answerable',
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
    route({ homeAgentEnabled: true, notificationChannel: 'local-web' })
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
