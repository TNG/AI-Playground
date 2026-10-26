import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { PermissionsPromptPayload } from '@/types/permissionsIpc'
import type { ModelDownloadCallbacks } from '@/lib/modelDownloader'
import { createCancellation } from '@/assets/js/errors/appError'
import {
  modelDownloads,
  registerModelDownloader,
  resetModelDownloadsForTest,
} from '@/assets/js/models/modelDownloadQueue'

const isActive = vi.fn(() => false)
const downloadModels = vi.fn(async (_models: unknown, _options?: unknown) => {})
const canAskChannelQuestion = vi.fn(() => false)
const askDownloadQuestion = vi.fn()
const showWarningDialog = vi.fn()
const isAgentSessionTurn = vi.fn((_key: string | undefined) => false)
const whenSessionInView = vi.fn(async (_key: string | undefined) => {})
const whenSessionTurnEnds = vi.fn((_key: string) => new Promise<void>(() => {}))
const respondMock = vi.fn(async (_payload: unknown) => {})
const onPromptMock = vi.fn<(callback: (payload: PermissionsPromptPayload) => void) => () => void>()

/** What the download dialog was asked to show, and how the test answers it. */
type DialogRequest = {
  list: DownloadModelParam[]
  options: {
    mode?: 'ask' | 'progress'
    alreadyDownloading?: DownloadModelParam[]
    waiter?: string
    joined?: boolean
    onConfirm?: (accepted: DownloadModelParam[]) => void
  }
  confirm: () => void
  decline: () => void
  dismissed: boolean
}
const dialogs: DialogRequest[] = []
const showDownloadDialog = vi.fn(
  (
    list: DownloadModelParam[],
    success: (accepted?: DownloadModelParam[]) => void,
    fail: (reason?: unknown) => void,
    options: DialogRequest['options'] = {},
  ) => {
    const request: DialogRequest = {
      list,
      options,
      dismissed: false,
      confirm: () => {
        if (options.mode === 'ask') return success(list)
        // A panel run's dialog queues the download itself, then reports the yes.
        modelDownloads().start(list, [options.waiter!], 'panel')
        options.onConfirm?.(list)
        void modelDownloads()
          .settled(options.waiter!)
          .then((outcome) => (outcome.status === 'done' ? success() : fail(outcome)))
      },
      decline: () => fail(createCancellation({ technicalMessage: 'Download cancelled by user' })),
    }
    dialogs.push(request)
    return { dismiss: () => (request.dismissed = true) }
  },
)

vi.mock('@/assets/js/store/dialogs', () => ({
  useDialogStore: () => ({ showDownloadDialog, showWarningDialog }),
}))

vi.mock('@/assets/js/permissions/remoteTurnPort', () => ({
  remoteTurnPort: () => ({ isActive, downloadModels, canAskChannelQuestion, askDownloadQuestion }),
}))

vi.mock('@/assets/js/permissions/sessionPromptPort', () => ({
  whenSessionInView,
  whenSessionTurnEnds,
  isAgentSessionTurn,
  sessionLabel: (key: string) => `"${key} title"`,
}))

vi.stubGlobal('window', {
  electronAPI: { permissions: { onPrompt: onPromptMock, respond: respondMock } },
})

const { startPermissionsAdapter, resetPermissionsAdapterForTest } =
  await import('@/assets/js/permissions/permissionsAdapter')

/** The ai-backend's single downloader; each call is one Model Download the test finishes. */
type Run = {
  list: DownloadModelParam[]
  signal: AbortSignal
  callbacks: ModelDownloadCallbacks
  finish: () => void
  fail: (error: Error) => void
}
let runs: Run[] = []
const stop = vi.fn(async () => {})

let handler: ((payload: PermissionsPromptPayload) => void) | undefined

const model = (name: string) =>
  ({ repo_id: `org/${name}`, type: 'llm', backend: 'llama_cpp' }) as DownloadModelParam
const X = model('x')
const Y = model('y')
const SESSION = 'aipg-agent-1'
const OTHER = 'aipg-agent-2'
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  setActivePinia(createPinia())
  resetPermissionsAdapterForTest()
  resetModelDownloadsForTest()
  vi.clearAllMocks()
  dialogs.length = 0
  runs = []
  registerModelDownloader({
    download: (list, options) =>
      new Promise<void>((resolve, reject) => {
        runs.push({
          list,
          signal: options.signal,
          callbacks: options,
          finish: resolve,
          fail: reject,
        })
        options.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    stop,
  })
  isActive.mockReturnValue(false)
  canAskChannelQuestion.mockReturnValue(false)
  isAgentSessionTurn.mockImplementation((key) => key === SESSION || key === OTHER)
  whenSessionInView.mockImplementation(async () => {})
  whenSessionTurnEnds.mockImplementation(() => new Promise<void>(() => {}))
  finals.clear()
  respondMock.mockImplementation(async (payload: unknown) => {
    const response = payload as Record<string, unknown>
    if (response.progress || response.answered) return
    finals.get(response.requestId as string)?.(response)
  })
  onPromptMock.mockImplementation((callback) => {
    handler = callback
    return () => {}
  })
  startPermissionsAdapter()
})

afterEach(() => {
  resetPermissionsAdapterForTest()
  registerModelDownloader(null)
  handler = undefined
})

const finals = new Map<string, (response: Record<string, unknown>) => void>()

/** Sends a download prompt; resolves with its final response (not pings or "answered"). */
function download(
  requestId: string,
  models: DownloadModelParam[],
  conversationKey?: string,
  overrides: Partial<PermissionsPromptPayload> = {},
) {
  const result = new Promise<Record<string, unknown>>((resolve) => finals.set(requestId, resolve))
  handler?.({
    requestId,
    kind: 'download',
    models,
    skipConfirmation: false,
    ...(conversationKey ? { conversationKey } : {}),
    ...overrides,
  } as PermissionsPromptPayload)
  return result
}

function answeredFor(requestId: string): boolean {
  return respondMock.mock.calls.some(
    ([payload]) =>
      (payload as { requestId: string; answered?: boolean }).requestId === requestId &&
      (payload as { answered?: boolean }).answered === true,
  )
}

type FakeQuestion = {
  answer: Promise<boolean>
  tap: (answer: boolean) => void
  follow: ReturnType<typeof vi.fn>
  retire: ReturnType<typeof vi.fn>
}

function fakeQuestion(): FakeQuestion {
  let tap: (answer: boolean) => void = () => {}
  const answer = new Promise<boolean>((resolve) => (tap = resolve))
  return { answer, tap, follow: vi.fn(), retire: vi.fn() }
}

describe('permissions prompt adapter', () => {
  it('reports a remote turn, but never for an Agent Mode session', async () => {
    isActive.mockReturnValue(true)
    handler?.({ requestId: 'r1', kind: 'is-remote' })
    handler?.({ requestId: 'r2', kind: 'is-remote', conversationKey: SESSION })
    await vi.waitFor(() => expect(respondMock).toHaveBeenCalledTimes(2))
    expect(respondMock).toHaveBeenCalledWith({ requestId: 'r1', result: true })
    expect(respondMock).toHaveBeenCalledWith({ requestId: 'r2', result: false })
  })

  it('shows a panel run’s download in the dialog, which downloads through the queue', async () => {
    const done = download('p1', [X])
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    expect(dialogs[0].options).toMatchObject({ mode: 'progress', joined: false })
    dialogs[0].confirm()
    expect(runs).toHaveLength(1)
    expect(answeredFor('p1')).toBe(true)
    runs[0].finish()
    expect(await done).toEqual({ requestId: 'p1', result: true })
  })

  it('closes a Chat dialog on Confirm and waits on the Model Download in the conversation', async () => {
    const done = download('c1', [X], 'chat-1')
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    expect(dialogs[0].options.mode).toBe('ask')
    dialogs[0].confirm()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(answeredFor('c1')).toBe(true)
    expect(modelDownloads().snapshot('chat-1')).toMatchObject({ status: 'downloading' })
    runs[0].finish()
    expect(await done).toEqual({ requestId: 'c1', result: true })
    expect(modelDownloads().snapshot('chat-1')).toBeNull()
    expect(askDownloadQuestion).not.toHaveBeenCalled()
  })

  it('routes a Home Agent remote turn to its port, including skipConfirmation', async () => {
    isActive.mockReturnValue(true)
    const done = download('h1', [X], 'home-1', { skipConfirmation: true })
    expect(await done).toEqual({ requestId: 'h1', result: true })
    expect(downloadModels).toHaveBeenCalledWith(
      [X],
      expect.objectContaining({ skipConfirmation: true }),
    )
    expect(dialogs).toHaveLength(0)
  })

  it('forwards a declined download as a cancellation', async () => {
    const done = download('d1', [X], 'chat-1')
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    dialogs[0].decline()
    expect(await done).toMatchObject({ requestId: 'd1', cancelled: true })
    expect(runs).toHaveLength(0)
  })

  it('returns confirmed/remember from the VRAM warning dialog', async () => {
    const done = new Promise<void>((resolve) =>
      respondMock.mockImplementation(async () => resolve()),
    )
    handler?.({ requestId: 'v1', kind: 'vram-warning', presetName: 'LTX', message: 'big' })
    await vi.waitFor(() => expect(showWarningDialog).toHaveBeenCalledTimes(1))
    showWarningDialog.mock.calls[0][1](true)
    await done
    expect(respondMock).toHaveBeenCalledWith({
      requestId: 'v1',
      result: { confirmed: true, remember: true },
    })
  })
})

describe('an Agent Mode download asked as a Channel Question', () => {
  let question: FakeQuestion

  beforeEach(() => {
    canAskChannelQuestion.mockReturnValue(true)
    question = fakeQuestion()
    askDownloadQuestion.mockReturnValue(question)
  })

  it('asks the question with the session label and still shows the held dialog', async () => {
    void download('q1', [X], SESSION)
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    expect(askDownloadQuestion).toHaveBeenCalledWith([X], {
      label: `"${SESSION} title"`,
      conversationKey: SESSION,
    })
    expect(whenSessionInView).toHaveBeenCalledWith(SESSION)
    expect(dialogs[0].options.mode).toBe('ask')
  })

  it('a channel Confirm closes the dialog and edits the question into the download', async () => {
    const done = download('q2', [X], SESSION)
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    question.tap(true)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(dialogs[0].dismissed).toBe(true)
    expect(question.follow).toHaveBeenCalledWith(expect.any(String), { answeredInApp: false })
    runs[0].finish()
    expect(await done).toEqual({ requestId: 'q2', result: true })
  })

  it('a channel Confirm before the session is on screen never shows the dialog later', async () => {
    let show: () => void = () => {}
    whenSessionInView.mockImplementation(() => new Promise<void>((resolve) => (show = resolve)))
    const done = download('q3', [X], SESSION)
    question.tap(true)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    runs[0].finish()
    expect(await done).toEqual({ requestId: 'q3', result: true })
    show()
    await flush()
    expect(dialogs).toHaveLength(0)
  })

  it('a channel Cancel declines the way the dialog’s cancel does', async () => {
    const done = download('q4', [X], SESSION)
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    question.tap(false)
    expect(await done).toMatchObject({ requestId: 'q4', cancelled: true })
    expect(dialogs[0].dismissed).toBe(true)
    expect(runs).toHaveLength(0)
  })

  it('a desktop Confirm keeps the channel message as answered in the app, then its progress', async () => {
    const done = download('q5', [X], SESSION)
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    dialogs[0].confirm()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(question.follow).toHaveBeenCalledWith(expect.any(String), { answeredInApp: true })
    expect(question.retire).not.toHaveBeenCalled()
    runs[0].finish()
    expect(await done).toEqual({ requestId: 'q5', result: true })
  })

  it('a desktop Cancel retires the channel buttons as declined in the app', async () => {
    const done = download('q6', [X], SESSION)
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    dialogs[0].decline()
    expect(await done).toMatchObject({ requestId: 'q6', cancelled: true })
    expect(question.retire).toHaveBeenCalledWith('declined-in-app')
  })

  it('retires the question when the prompt is dropped before it was shown', async () => {
    whenSessionInView.mockRejectedValue(createCancellation({ technicalMessage: 'turn ended' }))
    const done = download('q7', [X], SESSION)
    expect(await done).toMatchObject({ requestId: 'q7', cancelled: true })
    expect(question.retire).toHaveBeenCalledWith('closed')
  })

  it('is asked even when the remote-turn pre-grant would skip the in-turn question', async () => {
    isActive.mockReturnValue(true)
    const done = download('q9', [X], SESSION, { skipConfirmation: true })
    await vi.waitFor(() => expect(askDownloadQuestion).toHaveBeenCalled())
    question.tap(true)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    runs[0].finish()
    expect(await done).toEqual({ requestId: 'q9', result: true })
    expect(downloadModels).not.toHaveBeenCalled()
  })

  it('with automatic Notifications off, asks only in the app even while a remote turn runs', async () => {
    canAskChannelQuestion.mockReturnValue(false)
    isActive.mockReturnValue(true)
    void download('q10', [X], SESSION)
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    expect(askDownloadQuestion).not.toHaveBeenCalled()
    expect(downloadModels).not.toHaveBeenCalled()
  })

  it('is not asked for a desktop Chat or panel download', async () => {
    void download('q11', [X], 'chat-123')
    void download('q12', [Y])
    await vi.waitFor(() => expect(dialogs).toHaveLength(2))
    expect(askDownloadQuestion).not.toHaveBeenCalled()
  })
})

describe('sharing one Model Download queue', () => {
  it('runs two confirmed downloads one after the other, and both succeed', async () => {
    const first = download('s1', [X], 'chat-1')
    const second = download('s2', [Y], 'chat-2')
    await vi.waitFor(() => expect(dialogs).toHaveLength(2))
    dialogs[0].confirm()
    dialogs[1].confirm()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(modelDownloads().snapshot('chat-2')).toMatchObject({ status: 'queued' })
    runs[0].finish()
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    expect(runs[1].list).toEqual([Y])
    runs[1].finish()
    expect(await first).toMatchObject({ result: true })
    expect(await second).toMatchObject({ result: true })
  })

  it('a turn needing a model already downloading asks nothing and waits on it', async () => {
    const first = download('s3', [X], 'chat-1')
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    dialogs[0].confirm()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    canAskChannelQuestion.mockReturnValue(true)
    const second = download('s4', [X], SESSION)
    await vi.waitFor(() => expect(answeredFor('s4')).toBe(true))
    expect(dialogs).toHaveLength(1)
    expect(askDownloadQuestion).not.toHaveBeenCalled()
    expect(modelDownloads().snapshot(SESSION)).toMatchObject({ status: 'downloading' })
    runs[0].finish()
    expect(await first).toMatchObject({ result: true })
    expect(await second).toMatchObject({ result: true })
    expect(runs).toHaveLength(1)
  })

  it('asks only about the models no Model Download covers, naming the rest', async () => {
    void download('s5', [X], 'chat-1')
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    dialogs[0].confirm()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    void download('s6', [X, Y], 'chat-2')
    await vi.waitFor(() => expect(dialogs).toHaveLength(2))
    expect(dialogs[1].list).toEqual([Y])
    expect(dialogs[1].options.alreadyDownloading).toEqual([X])
  })

  it('a yes closes the other open question it covers, and both wait on one download', async () => {
    canAskChannelQuestion.mockReturnValue(true)
    const questions = [fakeQuestion(), fakeQuestion()]
    askDownloadQuestion.mockReturnValueOnce(questions[0]).mockReturnValueOnce(questions[1])
    const first = download('s7', [X], SESSION)
    const second = download('s8', [X], OTHER)
    await vi.waitFor(() => expect(dialogs).toHaveLength(2))
    dialogs[0].confirm()
    await vi.waitFor(() => expect(dialogs[1].dismissed).toBe(true))
    expect(questions[1].retire).toHaveBeenCalledWith({
      alreadyDownloadingFor: `"${SESSION} title"`,
    })
    expect(modelDownloads().snapshot(OTHER)).not.toBeNull()
    runs[0].finish()
    expect(await first).toMatchObject({ result: true })
    expect(await second).toMatchObject({ result: true })
    expect(runs).toHaveLength(1)
  })

  it('leaves a partly covered question open, and its yes only adds the rest', async () => {
    void download('s9', [X], 'chat-1')
    void download('s10', [X, Y], 'chat-2')
    await vi.waitFor(() => expect(dialogs).toHaveLength(2))
    dialogs[0].confirm()
    await flush()
    expect(dialogs[1].dismissed).toBe(false)
    dialogs[1].confirm()
    await flush()
    runs[0].finish()
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    expect(runs[1].list).toEqual([Y])
  })

  it('a no on one question leaves another question for the same model open', async () => {
    const first = download('s11', [X], 'chat-1')
    void download('s12', [X], 'chat-2')
    await vi.waitFor(() => expect(dialogs).toHaveLength(2))
    dialogs[0].decline()
    expect(await first).toMatchObject({ cancelled: true })
    expect(dialogs[1].dismissed).toBe(false)
  })

  it('reports a failed Model Download to every turn waiting on it', async () => {
    const first = download('s13', [X], 'chat-1')
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    dialogs[0].confirm()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    const second = download('s14', [X], 'chat-2')
    await vi.waitFor(() => expect(answeredFor('s14')).toBe(true))
    runs[0].fail(new Error('disk full'))
    expect(await first).toMatchObject({ error: 'disk full', cancelled: false })
    expect(await second).toMatchObject({ error: 'disk full', cancelled: false })
  })
})

describe('cancelling and stopping', () => {
  async function twoWaiting() {
    const first = download('t1', [X], SESSION)
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    dialogs[0].confirm()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    const second = download('t2', [X], OTHER)
    await vi.waitFor(() => expect(answeredFor('t2')).toBe(true))
    return { first, second }
  }

  it('Cancel on the card declines every turn waiting on the Model Download', async () => {
    const { first, second } = await twoWaiting()
    const [id] = modelDownloads().snapshot(SESSION)!.downloadIds
    modelDownloads().cancel(id)
    expect(await first).toMatchObject({ cancelled: true })
    expect(await second).toMatchObject({ cancelled: true })
    expect(runs[0].signal.aborted).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('stopping one of two waiting turns leaves the download running for the other', async () => {
    const { first, second } = await twoWaiting()
    handler?.({ requestId: 't1', kind: 'drop' } as PermissionsPromptPayload)
    expect(await first).toMatchObject({ cancelled: true })
    expect(runs[0].signal.aborted).toBe(false)
    runs[0].finish()
    expect(await second).toEqual({ requestId: 't2', result: true })
  })

  it('stopping the only waiting turn cancels the Model Download', async () => {
    const done = download('t3', [X], SESSION)
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    dialogs[0].confirm()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    handler?.({ requestId: 't3', kind: 'drop' } as PermissionsPromptPayload)
    expect(await done).toMatchObject({ cancelled: true })
    expect(runs[0].signal.aborted).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('stopping a turn with an unanswered question withdraws its dialog and retires the question', async () => {
    canAskChannelQuestion.mockReturnValue(true)
    const question = fakeQuestion()
    askDownloadQuestion.mockReturnValue(question)
    let endTurn: () => void = () => {}
    whenSessionTurnEnds.mockImplementation(
      () => new Promise<void>((resolve) => (endTurn = resolve)),
    )
    const done = download('t4', [X], SESSION)
    await vi.waitFor(() => expect(dialogs).toHaveLength(1))
    endTurn()
    expect(await done).toMatchObject({ cancelled: true })
    expect(dialogs[0].dismissed).toBe(true)
    expect(question.retire).toHaveBeenCalledWith('closed')
    expect(runs).toHaveLength(0)
  })
})
