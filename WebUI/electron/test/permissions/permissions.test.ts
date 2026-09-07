import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const isRemoteTurnActive = vi.fn(() => false)
const handleRemoteModelDownload = vi.fn(async () => {})

const showDownloadDialog = vi.fn()
const showWarningDialog = vi.fn()

vi.mock('@/assets/js/store/homeAgent', () => ({
  useHomeAgent: () => ({ isRemoteTurnActive, handleRemoteModelDownload }),
}))
vi.mock('@/assets/js/store/dialogs', () => ({
  useDialogStore: () => ({ showDownloadDialog, showWarningDialog }),
}))
// The grants store is real (it is the thing under review); only its persisted
// storage backing is stubbed — node has no localStorage.
vi.mock('@/assets/js/demoAwareStorage', () => ({
  demoAwareStorage: { getItem: () => null, setItem: () => {} },
}))

// Imported late on purpose: a dynamic import runs in source order, so the
// hoisted factories only execute after the mock consts are initialized.
const { notify, requestDownload, requestVramWarning, REMOTE_DOWNLOAD_GRANT } =
  await import('@/assets/js/permissions/permissions')
const { usePermissionGrants, vramWarningGrantKey } =
  await import('@/assets/js/store/permissionGrants')

function fakeLocalStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  const keys = () => [...store.keys()]
  return {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    key: (index: number) => keys()[index] ?? null,
    get length() {
      return store.size
    },
    remaining: keys,
  }
}

describe('permissions (consent layer)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    isRemoteTurnActive.mockReturnValue(false)
    vi.unstubAllGlobals()
  })

  describe('requestDownload', () => {
    it('prompts through the desktop download modal when no remote turn is active', async () => {
      const models = [{ repo_id: 'test/model' }] as DownloadModelParam[]
      const pending = requestDownload(models)
      expect(isRemoteTurnActive).toHaveBeenCalledTimes(1)
      expect(showDownloadDialog).toHaveBeenCalledTimes(1)
      const [list, onSuccess] = showDownloadDialog.mock.calls[0]
      expect(list).toBe(models)
      onSuccess()
      await expect(pending).resolves.toBeUndefined()
      expect(handleRemoteModelDownload).not.toHaveBeenCalled()
    })

    it('rejects with the modal when the download is declined', async () => {
      const pending = requestDownload([{ repo_id: 'test/model' }] as DownloadModelParam[])
      const [, , onFail] = showDownloadDialog.mock.calls[0]
      onFail(new Error('cancelled'))
      await expect(pending).rejects.toThrow('cancelled')
    })

    it('routes a remote Home Agent turn to the in-channel confirmation', async () => {
      isRemoteTurnActive.mockReturnValue(true)
      const models = [{ repo_id: 'test/model' }] as DownloadModelParam[]
      await requestDownload(models)
      expect(handleRemoteModelDownload).toHaveBeenCalledWith(models, { skipConfirmation: false })
      expect(showDownloadDialog).not.toHaveBeenCalled()
    })

    it('skips the in-channel question when the remote-download pre-grant exists', async () => {
      isRemoteTurnActive.mockReturnValue(true)
      usePermissionGrants().grant(REMOTE_DOWNLOAD_GRANT, 'pre-grant')
      const models = [{ repo_id: 'test/model' }] as DownloadModelParam[]
      await requestDownload(models)
      expect(handleRemoteModelDownload).toHaveBeenCalledWith(models, { skipConfirmation: true })
    })
  })

  describe('requestVramWarning', () => {
    it('resolves without prompting when the warning was remembered', async () => {
      const grants = usePermissionGrants()
      grants.grant(vramWarningGrantKey('LTX-Video'), 'remember')
      await expect(
        requestVramWarning({ presetName: 'LTX-Video', message: 'needs lots of VRAM' }),
      ).resolves.toBe(true)
      expect(showWarningDialog).not.toHaveBeenCalled()
    })

    it('prompts, and a plain confirm grants without remembering', async () => {
      const grants = usePermissionGrants()
      const pending = requestVramWarning({ presetName: 'LTX-Video', message: 'needs lots of VRAM' })
      const [message, confirmFn, options] = showWarningDialog.mock.calls[0]
      expect(message).toBe('needs lots of VRAM')
      expect(options.dontShowAgainKey).toBe('LTX-Video')
      confirmFn(false)
      await expect(pending).resolves.toBe(true)
      expect(grants.has(vramWarningGrantKey('LTX-Video'))).toBe(false)
    })

    it('records a reviewable remember grant on confirm-with-do-not-show-again', async () => {
      const grants = usePermissionGrants()
      const pending = requestVramWarning({
        presetName: 'Wan2.1-VACE',
        message: 'needs lots of VRAM',
      })
      const [, confirmFn] = showWarningDialog.mock.calls[0]
      confirmFn(true)
      await expect(pending).resolves.toBe(true)
      const granted = grants.list.find((g) => g.key === vramWarningGrantKey('Wan2.1-VACE'))
      expect(granted).toMatchObject({ origin: 'remember' })
      grants.revoke(vramWarningGrantKey('Wan2.1-VACE'))
      expect(grants.has(vramWarningGrantKey('Wan2.1-VACE'))).toBe(false)
    })

    it('resolves false when the user cancels', async () => {
      const pending = requestVramWarning({ presetName: 'LTX-Video', message: 'needs lots of VRAM' })
      const [, , options] = showWarningDialog.mock.calls[0]
      options.onCancel()
      await expect(pending).resolves.toBe(false)
      expect(usePermissionGrants().list).toHaveLength(0)
    })
  })

  describe('notify', () => {
    it('shows the guidance notice and runs the confirm action', () => {
      const onConfirm = vi.fn()
      notify('install me', onConfirm)
      const [message, confirmFn] = showWarningDialog.mock.calls[0]
      expect(message).toBe('install me')
      expect(showWarningDialog.mock.calls[0][2]).toBeUndefined()
      confirmFn()
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })
  })

  describe('the grant list', () => {
    it('starts empty', () => {
      expect(usePermissionGrants().list).toHaveLength(0)
    })

    it('imports the legacy localStorage memory-alert suppressions once, as remember grants', () => {
      const storage = fakeLocalStorage({
        'memoryAlertSuppress_LTX-Video': '1',
        'memoryAlertSuppress_Wan2.1-VACE': '1',
        memoryAlertSuppress_Stale: '0',
        unrelated: '1',
      })
      vi.stubGlobal('localStorage', storage)
      setActivePinia(createPinia())
      const grants = usePermissionGrants()

      expect(grants.has(vramWarningGrantKey('LTX-Video'))).toBe(true)
      expect(grants.has(vramWarningGrantKey('Wan2.1-VACE'))).toBe(true)
      expect(grants.list.map((g) => g.origin)).toEqual(['remember', 'remember'])
      // The legacy keys are consumed — including the non-'1' stale one — while
      // unrelated storage entries are left alone.
      expect(storage.remaining()).toEqual(['unrelated'])

      // And a fresh store on the same storage finds nothing left to import.
      setActivePinia(createPinia())
      expect(usePermissionGrants().list).toHaveLength(0)
    })
  })
})
