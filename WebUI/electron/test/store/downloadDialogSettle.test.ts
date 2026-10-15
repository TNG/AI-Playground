import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// How the download dialog settles the request that opened it: once, and with the
// outcome the user finally saw — a retry that succeeds after an error is a success.

vi.mock('@/lib/sanitize', () => ({ sanitizeMarkdown: (text: string) => text }))
vi.mock('@/assets/js/markdownParser', () => ({ parse: (text: string) => text }))

const { useDialogStore } = await import('@/assets/js/store/dialogs')

const resumable = { type: 'error', error: 'The download failed. It can be resumed.' }

const MODELS = [{ repo_id: 'Stored-27B', type: 'ggufLLM', backend: 'llama_cpp' }] as never

beforeEach(() => setActivePinia(createPinia()))

function open() {
  const dialogs = useDialogStore()
  const success = vi.fn()
  const fail = vi.fn()
  dialogs.showDownloadDialog(MODELS, success, fail)
  return { dialogs, success, fail }
}

describe('the download dialog settling its request', () => {
  it('reports success when a retry succeeds after a resumable error', () => {
    const { dialogs, success, fail } = open()

    dialogs.downloadFailedResumable(resumable)
    dialogs.downloadCompleted()

    expect(success).toHaveBeenCalledTimes(1)
    expect(fail).not.toHaveBeenCalled()
    expect(dialogs.downloadDialogVisible).toBe(false)
  })

  it('reports the error once the user closes the dialog instead of retrying', () => {
    const { dialogs, success, fail } = open()

    dialogs.downloadFailedResumable(resumable)
    expect(fail).not.toHaveBeenCalled()
    dialogs.closeDownloadDialog()

    expect(fail).toHaveBeenCalledTimes(1)
    expect(fail.mock.calls[0][0]).toEqual(resumable)
    expect(success).not.toHaveBeenCalled()
  })

  it('reports a final error at once', () => {
    const { dialogs, fail } = open()

    dialogs.downloadFailed('Not enough disk space')

    expect(fail).toHaveBeenCalledTimes(1)
    dialogs.closeDownloadDialog()
    expect(fail).toHaveBeenCalledTimes(1)
  })

  it('settles only once', () => {
    const { dialogs, success, fail } = open()

    dialogs.downloadCompleted()
    dialogs.downloadFailed('late')
    dialogs.closeDownloadDialog()

    expect(success).toHaveBeenCalledTimes(1)
    expect(fail).not.toHaveBeenCalled()
  })

  it('does not settle a newer request with an older one’s pending error', () => {
    const first = open()
    first.dialogs.downloadFailedResumable(resumable)
    const second = open()

    second.dialogs.closeDownloadDialog()

    expect(first.fail).toHaveBeenCalledTimes(1)
    expect(second.fail).not.toHaveBeenCalled()
  })
})
