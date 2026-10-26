import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Two Download Questions at once (Chat and an on-screen agent session) are shown one
// after the other; neither replaces the other.

vi.mock('@/lib/sanitize', () => ({ sanitizeMarkdown: (text: string) => text }))
vi.mock('@/assets/js/markdownParser', () => ({ parse: (text: string) => text }))

const { useDialogStore } = await import('@/assets/js/store/dialogs')

const model = (name: string) =>
  ({ repo_id: `org/${name}`, type: 'llm', backend: 'llama_cpp' }) as DownloadModelParam

beforeEach(() => setActivePinia(createPinia()))

describe('the download dialog queue', () => {
  it('shows a second request only after the first is answered, each settling its own', () => {
    const dialogs = useDialogStore()
    const first = { success: vi.fn(), fail: vi.fn() }
    const second = { success: vi.fn(), fail: vi.fn() }
    dialogs.showDownloadDialog([model('a')], first.success, first.fail, { mode: 'ask' })
    dialogs.showDownloadDialog([model('b')], second.success, second.fail, { mode: 'ask' })
    expect(dialogs.downloadList).toEqual([model('a')])

    dialogs.downloadConfirmed([model('a')])
    expect(first.success).toHaveBeenCalledWith([model('a')])
    expect(dialogs.downloadList).toEqual([model('b')])
    expect(dialogs.downloadDialogVisible).toBe(true)

    dialogs.downloadFailed('declined')
    dialogs.closeDownloadDialog()
    expect(second.fail).toHaveBeenCalledWith('declined')
    expect(first.fail).not.toHaveBeenCalled()
    expect(dialogs.downloadDialogVisible).toBe(false)
  })

  it('withdraws a queued request without ever showing it', () => {
    const dialogs = useDialogStore()
    const shown = { success: vi.fn(), fail: vi.fn() }
    const queued = { success: vi.fn(), fail: vi.fn() }
    dialogs.showDownloadDialog([model('a')], shown.success, shown.fail, { mode: 'ask' })
    const request = dialogs.showDownloadDialog([model('b')], queued.success, queued.fail, {
      mode: 'ask',
    })
    request.dismiss()
    dialogs.downloadConfirmed([model('a')])
    expect(dialogs.downloadDialogVisible).toBe(false)
    expect(queued.success).not.toHaveBeenCalled()
    expect(queued.fail).not.toHaveBeenCalled()
  })

  it('dismissing the shown request moves on to the next one only', () => {
    const dialogs = useDialogStore()
    const shown = { success: vi.fn(), fail: vi.fn() }
    const next = { success: vi.fn(), fail: vi.fn() }
    const request = dialogs.showDownloadDialog([model('a')], shown.success, shown.fail)
    dialogs.showDownloadDialog([model('b')], next.success, next.fail)
    request.dismiss()
    expect(dialogs.downloadList).toEqual([model('b')])
    expect(shown.fail).not.toHaveBeenCalled()
    expect(next.fail).not.toHaveBeenCalled()
  })
})
