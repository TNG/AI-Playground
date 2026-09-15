import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { PermissionsPromptPayload } from '@/types/permissionsIpc'

const isActive = vi.fn(() => false)
const downloadModels = vi.fn(async () => {})
const showDownloadDialog = vi.fn()
const showWarningDialog = vi.fn()
const respondMock = vi.fn(async () => {})
const onPromptMock = vi.fn<(callback: (payload: PermissionsPromptPayload) => void) => () => void>()

vi.mock('@/assets/js/store/dialogs', () => ({
  useDialogStore: () => ({ showDownloadDialog, showWarningDialog }),
}))

vi.mock('@/assets/js/permissions/remoteTurnPort', () => ({
  remoteTurnPort: () => ({ isActive, downloadModels }),
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
      expect(respondMock).toHaveBeenCalledWith({ requestId: 'r4', error: 'cancelled' }),
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
