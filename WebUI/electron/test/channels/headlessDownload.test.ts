import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeDownloadMessages,
  runHeadlessDownload,
  trackModelDownload,
} from '../../../src/assets/js/store/channels/headlessDownload'
import { createChannelQuestionRegistry } from '../../../src/assets/js/store/channels/channelQuestions'
import { createModelDownloadQueue } from '../../../src/assets/js/models/modelDownloadQueue'
import type { ChannelAdapter } from '../../../src/assets/js/store/channels/adapter'
import type { KeyboardButton } from '../../../src/assets/js/store/channels/types'
import type {
  ModelDownloadCallbacks,
  ModelDownloadProgress,
} from '../../../src/lib/modelDownloader'

type Message = { id: number; text: string; buttons?: KeyboardButton[][] }

/** A channel that keeps what the user would see: one entry per message, edited in place. */
function fakeChannel() {
  const messages: Message[] = []
  let drafts = 0
  const adapter = {
    kind: 'local-web',
    formatMarkdown: (md: string) => md,
    formatRichSnippet: (html: string) => html,
    post: async (text: string) => {
      messages.push({ id: messages.length + 1, text })
      return { success: true, ref: { messageId: messages.length } }
    },
    keyboard: async (text: string, buttons: KeyboardButton[][]) => {
      messages.push({ id: messages.length + 1, text, buttons })
      return { success: true, ref: { messageId: messages.length } }
    },
    editKeyboardMessage: async (ref: { messageId?: number }, text: string) => {
      const message = messages.find((m) => m.id === ref.messageId)!
      message.text = text
      delete message.buttons
      return { success: true }
    },
    reply: async (text: string) => {
      messages.push({ id: messages.length + 1, text })
      return { success: true }
    },
    createDraftStream: () => {
      drafts++
      return { update: () => {}, finalize: async () => {}, cancel: () => {} }
    },
  } as unknown as ChannelAdapter
  return { adapter, messages, drafts: () => drafts }
}

/** The ai-backend's downloader, driven by the test. */
function fakeDownloader() {
  const runs: {
    list: DownloadModelParam[]
    callbacks: ModelDownloadCallbacks & { signal: AbortSignal }
    finish: () => void
    fail: (error: Error) => void
  }[] = []
  const downloader = {
    download: (
      list: DownloadModelParam[],
      callbacks: ModelDownloadCallbacks & { signal: AbortSignal },
    ) =>
      new Promise<void>((resolve, reject) => {
        runs.push({ list, callbacks, finish: resolve, fail: reject })
        callbacks.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    stop: vi.fn(async () => {}),
  }
  return { downloader, runs }
}

const MODEL = { repo_id: 'org/model-a', type: 'llm', backend: 'llama_cpp' } as DownloadModelParam
const progress = (percent: number): ModelDownloadProgress => ({
  repoId: 'org/model-a',
  percent,
  taskPercent: 0,
  completed: 0,
  total: 1,
  speed: '10 MB/s',
})
const text = {
  queued: '⏳ Queued.',
  starting: '⬇️ Starting…',
  progress: (p: { repoId: string; percent: number }) => `⬇️ ${p.repoId} ${p.percent}%`,
  complete: '✅ Downloaded.',
  failed: (error: string) => `⚠️ Failed: ${error}`,
  cancelled: '⏹ Cancelled in AI Playground.',
}
const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => vi.useRealTimers())

describe('a Home Agent chat turn’s download', () => {
  it('posts one message and edits it into throttled progress and the outcome, never a draft', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const ch = fakeChannel()
    const { downloader, runs } = fakeDownloader()
    const queue = createModelDownloadQueue({ downloader: () => downloader })
    const run = runHeadlessDownload(
      {
        adapter: ch.adapter,
        list: [MODEL],
        waiter: queue.waiter('home'),
        label: 'the Home Agent',
        text,
      },
      { queue, log: () => {} },
    )
    await flush()
    vi.setSystemTime(10_000)
    runs[0].callbacks.onProgress?.(progress(10))
    vi.setSystemTime(11_000)
    runs[0].callbacks.onProgress?.(progress(20))
    vi.setSystemTime(14_000)
    runs[0].callbacks.onProgress?.(progress(60))
    await flush()
    expect(ch.messages.map((m) => m.text)).toEqual(['⬇️ org/model-a 60%'])
    runs[0].finish()
    await run
    await flush()
    expect(ch.messages.map((m) => m.text)).toEqual(['✅ Downloaded.'])
    expect(ch.drafts()).toBe(0)
  })

  it('reports a failure in the same message and throws a silent download error', async () => {
    const ch = fakeChannel()
    const { downloader, runs } = fakeDownloader()
    const queue = createModelDownloadQueue({ downloader: () => downloader })
    const run = runHeadlessDownload(
      {
        adapter: ch.adapter,
        list: [MODEL],
        waiter: queue.waiter('home'),
        label: 'the Home Agent',
        text,
      },
      { queue, log: () => {} },
    )
    await flush()
    runs[0].fail(new Error('disk full'))
    await expect(run).rejects.toMatchObject({ code: 'model/download-failed', surface: 'silent' })
    await flush()
    expect(ch.messages.map((m) => m.text)).toEqual(['⚠️ Failed: disk full'])
  })

  it('leaves Home Agent replies sent meanwhile alone', async () => {
    const ch = fakeChannel()
    const { downloader, runs } = fakeDownloader()
    const queue = createModelDownloadQueue({ downloader: () => downloader })
    const run = runHeadlessDownload(
      {
        adapter: ch.adapter,
        list: [MODEL],
        waiter: queue.waiter('home'),
        label: 'the Home Agent',
        text,
      },
      { queue, log: () => {} },
    )
    await flush()
    await ch.adapter.reply('Here is your answer.')
    runs[0].finish()
    await run
    await flush()
    expect(ch.messages.map((m) => m.text)).toEqual(['✅ Downloaded.', 'Here is your answer.'])
  })

  it('posts nothing for a turn that only joined a Model Download already running', async () => {
    const ch = fakeChannel()
    const { downloader, runs } = fakeDownloader()
    const queue = createModelDownloadQueue({ downloader: () => downloader })
    queue.waiter('session').start([MODEL], 'Session')
    const home = queue.waiter('home')
    expect(home.attach([MODEL])).toEqual([])
    const run = runHeadlessDownload(
      { adapter: ch.adapter, list: [], waiter: home, label: 'the Home Agent', text },
      { queue, log: () => {} },
    )
    runs[0].finish()
    await run
    await flush()
    expect(ch.messages).toEqual([])
  })
})

describe('a Channel Question following its Model Download', () => {
  it('says a confirmed download is queued behind another, then starting, never just "Confirmed"', async () => {
    const ch = fakeChannel()
    const registry = createChannelQuestionRegistry({ log: () => {} })
    const question = registry.ask({ adapter: ch.adapter, summaryMarkdown: 'Download model-b?' })
    await flush()
    const { downloader, runs } = fakeDownloader()
    const queue = createModelDownloadQueue({ downloader: () => downloader })
    queue.waiter('other').start([MODEL], 'Other')
    registry.handleInbound(ch.adapter, { callback: ch.messages[0].buttons!.flat()[0].callbackData })
    const B = { ...MODEL, repo_id: 'org/model-b' } as DownloadModelParam
    const id = queue.waiter('session').start([B], 'Session')!
    trackModelDownload({ queue, downloadId: id, message: { edit: question.edit }, text })
    await flush()
    expect(ch.messages[0].text).toBe('Download model-b?\n\n⏳ Queued.')
    runs[0].finish()
    await flush()
    expect(ch.messages[0].text).toBe('Download model-b?\n\n⬇️ Starting…')
  })

  async function askedQuestion() {
    const ch = fakeChannel()
    const registry = createChannelQuestionRegistry({ log: () => {} })
    const question = registry.ask({ adapter: ch.adapter, summaryMarkdown: 'Download model-a?' })
    await flush()
    return { ch, registry, question }
  }

  it('turns the question into progress and then the outcome, in one message', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { ch, registry, question } = await askedQuestion()
    const { downloader, runs } = fakeDownloader()
    const queue = createModelDownloadQueue({ downloader: () => downloader })
    const tap = ch.messages[0].buttons!.flat()[0].callbackData
    registry.handleInbound(ch.adapter, { callback: tap })
    const id = queue.waiter('session').start([MODEL], 'Session')!
    trackModelDownload({ queue, downloadId: id, message: { edit: question.edit }, text })
    vi.setSystemTime(10_000)
    runs[0].callbacks.onProgress?.(progress(40))
    await flush()
    expect(ch.messages).toEqual([{ id: 1, text: 'Download model-a?\n\n⬇️ org/model-a 40%' }])
    runs[0].finish()
    await flush()
    expect(ch.messages).toEqual([{ id: 1, text: 'Download model-a?\n\n✅ Downloaded.' }])
  })

  it('keeps "answered in AI Playground" above the progress of a desktop yes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { ch, registry, question } = await askedQuestion()
    const { downloader, runs } = fakeDownloader()
    const queue = createModelDownloadQueue({ downloader: () => downloader })
    registry.retire(question.id, '✔ Answered in AI Playground.')
    const id = queue.waiter('session').start([MODEL], 'Session')!
    trackModelDownload({
      queue,
      downloadId: id,
      message: { edit: question.edit },
      text,
      prefix: '✔ Answered in AI Playground.',
    })
    vi.setSystemTime(10_000)
    runs[0].callbacks.onProgress?.(progress(5))
    await flush()
    expect(ch.messages[0].text).toBe(
      'Download model-a?\n\n✔ Answered in AI Playground.\n⬇️ org/model-a 5%',
    )
    queue.cancel(id)
    await flush()
    expect(ch.messages[0].text).toBe(
      'Download model-a?\n\n✔ Answered in AI Playground.\n⏹ Cancelled in AI Playground.',
    )
    expect(ch.messages).toHaveLength(1)
  })

  it('says AI Playground closed when the app quits mid-download, and nothing after', async () => {
    const { ch, question } = await askedQuestion()
    const { downloader } = fakeDownloader()
    const queue = createModelDownloadQueue({ downloader: () => downloader })
    const id = queue.waiter('session').start([MODEL], 'Session')!
    trackModelDownload({ queue, downloadId: id, message: { edit: question.edit }, text })
    closeDownloadMessages('⏹ Stopped — AI Playground closed.')
    queue.cancel(id)
    await flush()
    expect(ch.messages).toEqual([
      { id: 1, text: 'Download model-a?\n\n⏹ Stopped — AI Playground closed.' },
    ])
  })
})
