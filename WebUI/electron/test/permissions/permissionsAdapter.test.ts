import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { PermissionsPromptPayload } from '@/types/permissionsIpc'
import { createCancellation } from '@/assets/js/errors/appError'

const isActive = vi.fn(() => false)
const downloadModels = vi.fn(async () => {})
const canAskChannelQuestion = vi.fn(() => false)
const askDownloadQuestion = vi.fn()
const showDownloadDialog = vi.fn()
const dismissDialog = vi.fn()
const isAgentSessionTurn = vi.fn((_key: string | undefined) => false)
const whenSessionInView = vi.fn(async (_key: string | undefined) => {})
const showWarningDialog = vi.fn()
const respondMock = vi.fn(async (_payload: unknown) => {})
const onPromptMock = vi.fn<(callback: (payload: PermissionsPromptPayload) => void) => () => void>()

vi.mock('@/assets/js/store/dialogs', () => ({
  useDialogStore: () => ({ showDownloadDialog, showWarningDialog }),
}))

vi.mock('@/assets/js/permissions/remoteTurnPort', () => ({
  remoteTurnPort: () => ({
    isActive,
    downloadModels,
    canAskChannelQuestion,
    askDownloadQuestion,
  }),
}))

vi.mock('@/assets/js/permissions/sessionPromptPort', () => ({
  whenSessionInView,
  isAgentSessionTurn,
  sessionLabel: (key: string) => `"${key} title"`,
}))

vi.stubGlobal('window', {
  electronAPI: {
    permissions: {
      onPrompt: onPromptMock,
      respond: respondMock,
    },
  },
})

const { startPermissionsAdapter, resetPermissionsAdapterForTest } =
  await import('@/assets/js/permissions/permissionsAdapter')

let handler: ((payload: PermissionsPromptPayload) => void) | undefined

beforeEach(() => {
  setActivePinia(createPinia())
  resetPermissionsAdapterForTest()
  vi.clearAllMocks()
  isActive.mockReturnValue(false)
  canAskChannelQuestion.mockReturnValue(false)
  isAgentSessionTurn.mockReturnValue(false)
  whenSessionInView.mockImplementation(async () => {})
  showDownloadDialog.mockImplementation(() => ({ dismiss: dismissDialog }))
  onPromptMock.mockImplementation((callback) => {
    handler = callback
    return () => {}
  })
  startPermissionsAdapter()
})

afterEach(() => {
  resetPermissionsAdapterForTest()
  handler = undefined
})

describe('permissions prompt adapter', () => {
  it('reports whether a remote turn is active', async () => {
    isActive.mockReturnValue(true)
    handler?.({ requestId: 'r1', kind: 'is-remote' })
    await vi.waitFor(() => expect(respondMock).toHaveBeenCalled())
    expect(respondMock).toHaveBeenCalledWith({ requestId: 'r1', result: true })
  })

  it('prompts through the desktop download modal when no remote turn is active', async () => {
    const models = [{ repo_id: 'test/model' }] as DownloadModelParam[]
    const pending = new Promise<void>((resolve) => {
      respondMock.mockImplementation(async () => resolve())
    })
    handler?.({ requestId: 'r2', kind: 'download', models, skipConfirmation: false })
    await vi.waitFor(() => expect(showDownloadDialog).toHaveBeenCalledTimes(1))
    const [list, onSuccess] = showDownloadDialog.mock.calls[0]
    expect(list).toBe(models)
    onSuccess()
    await pending
    expect(downloadModels).not.toHaveBeenCalled()
    expect(respondMock).toHaveBeenCalledWith({ requestId: 'r2', result: true })
  })

  it('routes a remote turn to the registered port, including skipConfirmation', async () => {
    isActive.mockReturnValue(true)
    const models = [{ repo_id: 'test/model' }] as DownloadModelParam[]
    const pending = new Promise<void>((resolve) => {
      respondMock.mockImplementation(async () => resolve())
    })
    handler?.({ requestId: 'r3', kind: 'download', models, skipConfirmation: true })
    await pending
    expect(downloadModels).toHaveBeenCalledWith(models, { skipConfirmation: true })
    expect(showDownloadDialog).not.toHaveBeenCalled()
  })

  it('forwards a declined download as the request error', async () => {
    showDownloadDialog.mockImplementation((_list, _ok, fail) => fail(new Error('cancelled')))
    handler?.({
      requestId: 'r4',
      kind: 'download',
      models: [{ repo_id: 'x' }],
      skipConfirmation: false,
    })
    await vi.waitFor(() =>
      expect(respondMock).toHaveBeenCalledWith({
        requestId: 'r4',
        error: 'cancelled',
        cancelled: false,
      }),
    )
  })

  it('reports an AppError by message and marks a cancellation as one', async () => {
    showDownloadDialog.mockImplementation((_list, _ok, fail) =>
      fail(createCancellation({ technicalMessage: 'remote model download declined' })),
    )
    handler?.({
      requestId: 'r6',
      kind: 'download',
      models: [{ repo_id: 'x' }],
      skipConfirmation: false,
    })
    await vi.waitFor(() =>
      expect(respondMock).toHaveBeenCalledWith({
        requestId: 'r6',
        error: 'remote model download declined',
        cancelled: true,
      }),
    )
  })

  it('returns confirmed/remember from the VRAM warning dialog', async () => {
    const pending = new Promise<void>((resolve) => {
      respondMock.mockImplementation(async () => resolve())
    })
    handler?.({
      requestId: 'r5',
      kind: 'vram-warning',
      presetName: 'LTX-Video',
      message: 'needs lots of VRAM',
    })
    await vi.waitFor(() => expect(showWarningDialog).toHaveBeenCalledTimes(1))
    const [, confirmFn] = showWarningDialog.mock.calls[0]
    confirmFn(true)
    await pending
    expect(respondMock).toHaveBeenCalledWith({
      requestId: 'r5',
      result: { confirmed: true, remember: true },
    })
  })
})

type FakeQuestion = {
  answer: Promise<boolean>
  tap: (answer: boolean) => void
  download: ReturnType<typeof vi.fn>
  retire: ReturnType<typeof vi.fn>
}

function fakeQuestion(): FakeQuestion {
  let tap: (answer: boolean) => void = () => {}
  const answer = new Promise<boolean>((resolve) => {
    tap = resolve
  })
  return { answer, tap, download: vi.fn(async () => {}), retire: vi.fn() }
}

const MODELS = [{ repo_id: 'org/model' }] as DownloadModelParam[]
const SESSION = 'aipg-agent-1'

function agentDownload(requestId: string, overrides: Partial<PermissionsPromptPayload> = {}) {
  const responded = new Promise<unknown>((resolve) => {
    respondMock.mockImplementation(async (payload: unknown) => {
      if ((payload as { progress?: boolean }).progress) return
      resolve(payload)
    })
  })
  handler?.({
    requestId,
    kind: 'download',
    models: MODELS,
    skipConfirmation: false,
    conversationKey: SESSION,
    ...overrides,
  } as PermissionsPromptPayload)
  return responded
}

describe('an Agent Mode download asked as a Channel Question', () => {
  let question: FakeQuestion

  beforeEach(() => {
    isAgentSessionTurn.mockImplementation((key) => key === SESSION)
    canAskChannelQuestion.mockReturnValue(true)
    question = fakeQuestion()
    askDownloadQuestion.mockReturnValue(question)
  })

  it('asks the question with the session label and still shows the desktop modal', async () => {
    void agentDownload('q1')
    await vi.waitFor(() => expect(showDownloadDialog).toHaveBeenCalledTimes(1))
    expect(askDownloadQuestion).toHaveBeenCalledWith(MODELS, {
      label: `"${SESSION} title"`,
      conversationKey: SESSION,
    })
    expect(whenSessionInView).toHaveBeenCalledWith(SESSION)
  })

  it('a channel Confirm closes the modal, runs the headless download and resolves', async () => {
    const responded = agentDownload('q2')
    await vi.waitFor(() => expect(showDownloadDialog).toHaveBeenCalled())
    question.tap(true)
    expect(await responded).toEqual({ requestId: 'q2', result: true })
    expect(dismissDialog).toHaveBeenCalled()
    expect(question.download).toHaveBeenCalledTimes(1)
  })

  it('a channel Confirm before the session is on screen never shows the modal later', async () => {
    let show: () => void = () => {}
    whenSessionInView.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          show = resolve
        }),
    )
    const responded = agentDownload('q3')
    question.tap(true)
    expect(await responded).toEqual({ requestId: 'q3', result: true })
    show()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(showDownloadDialog).not.toHaveBeenCalled()
  })

  it('a channel Cancel declines the way the modal cancel does', async () => {
    const responded = agentDownload('q4')
    await vi.waitFor(() => expect(showDownloadDialog).toHaveBeenCalled())
    question.tap(false)
    expect(await responded).toMatchObject({ requestId: 'q4', cancelled: true })
    expect(dismissDialog).toHaveBeenCalled()
    expect(question.download).not.toHaveBeenCalled()
  })

  it('a desktop Confirm retires the channel buttons as answered in the app', async () => {
    const responded = agentDownload('q5')
    await vi.waitFor(() => expect(showDownloadDialog).toHaveBeenCalled())
    const [, onSuccess, , options] = showDownloadDialog.mock.calls[0]
    options.onConfirm()
    expect(question.retire).toHaveBeenCalledWith('answered-in-app')
    onSuccess()
    expect(await responded).toEqual({ requestId: 'q5', result: true })
    expect(question.download).not.toHaveBeenCalled()
  })

  it('a desktop Cancel retires the channel buttons and declines', async () => {
    const responded = agentDownload('q6')
    await vi.waitFor(() => expect(showDownloadDialog).toHaveBeenCalled())
    const [, , onFail] = showDownloadDialog.mock.calls[0]
    onFail(createCancellation({ technicalMessage: 'Download cancelled by user' }))
    expect(await responded).toMatchObject({ requestId: 'q6', cancelled: true })
    expect(question.retire).toHaveBeenCalledWith('answered-in-app')
  })

  it('retires the question when the prompt is dropped before it was shown', async () => {
    whenSessionInView.mockRejectedValue(createCancellation({ technicalMessage: 'turn ended' }))
    const responded = agentDownload('q7')
    expect(await responded).toMatchObject({ requestId: 'q7', cancelled: true })
    expect(question.retire).toHaveBeenCalledWith('closed')
  })

  it('leaves a question the channel cannot answer to the desktop modal', async () => {
    question.answer = new Promise<boolean>(() => {})
    const responded = agentDownload('q8')
    await vi.waitFor(() => expect(showDownloadDialog).toHaveBeenCalled())
    showDownloadDialog.mock.calls[0][1]()
    expect(await responded).toEqual({ requestId: 'q8', result: true })
  })

  it('is asked even when the remote-turn pre-grant would skip the in-turn question', async () => {
    isActive.mockReturnValue(true)
    const responded = agentDownload('q9', { skipConfirmation: true })
    await vi.waitFor(() => expect(askDownloadQuestion).toHaveBeenCalled())
    expect(downloadModels).not.toHaveBeenCalled()
    question.tap(true)
    expect(await responded).toEqual({ requestId: 'q9', result: true })
  })

  it('is not asked when the Home Agent cannot take it (off, no channel, auto-notify off)', async () => {
    canAskChannelQuestion.mockReturnValue(false)
    void agentDownload('q10')
    await vi.waitFor(() => expect(showDownloadDialog).toHaveBeenCalled())
    expect(askDownloadQuestion).not.toHaveBeenCalled()
  })

  it('is not asked for a desktop Chat or panel download', async () => {
    void agentDownload('q11', { conversationKey: 'chat-123' })
    await vi.waitFor(() => expect(showDownloadDialog).toHaveBeenCalled())
    void agentDownload('q12', { conversationKey: undefined })
    await vi.waitFor(() => expect(showDownloadDialog).toHaveBeenCalledTimes(2))
    expect(askDownloadQuestion).not.toHaveBeenCalled()
  })
})
