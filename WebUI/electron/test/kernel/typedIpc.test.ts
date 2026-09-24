import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { ConversationSaveRequest } from '@/types/conversationIpc'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))

const { typedHandle, typedOn, ipcErrorText } = await import('../../kernel/typedIpc')
const { ipcMain } = await import('electron')

const handle = vi.mocked(ipcMain.handle)
const on = vi.mocked(ipcMain.on)

beforeEach(() => {
  handle.mockClear()
  on.mockClear()
})

describe('typed IPC registration', () => {
  it('typedHandle registers under the exact channel name, forwards arguments, resolves the value', async () => {
    const request: ConversationSaveRequest = {
      id: 'thread-1',
      meta: null,
      ragHashes: [],
      messages: [],
      lastMainKey: null,
    }
    const event = {} as IpcMainInvokeEvent
    const handler = vi.fn(
      async (_event: IpcMainInvokeEvent, _request: ConversationSaveRequest) =>
        ({ success: true }) as const,
    )
    typedHandle('conversations:save', handler)
    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle.mock.calls[0][0]).toBe('conversations:save')
    const registered = handle.mock.calls[0][1]
    const result = await registered(event, request)
    expect(result).toEqual({ success: true })
    expect(handler).toHaveBeenCalledWith(event, request)
  })

  it('typedOn registers the listener under the exact channel name via ipcMain.on', () => {
    const listener = vi.fn()
    // No send rows in the manifest yet — the first arrive with a later strangler batch.
    const untypedOn = typedOn as unknown as (
      channel: string,
      listener: (...args: unknown[]) => void,
    ) => void
    untypedOn('lifecycle:busy', listener)
    expect(on).toHaveBeenCalledTimes(1)
    expect(on.mock.calls[0][0]).toBe('lifecycle:busy')
    expect(on.mock.calls[0][1]).toBe(listener)
  })

  it('ipcErrorText reads Error messages and stringifies anything else', () => {
    expect(ipcErrorText(new Error('disk full'))).toBe('disk full')
    expect(ipcErrorText('rate limited')).toBe('rate limited')
    expect(ipcErrorText(42)).toBe('42')
    expect(ipcErrorText(undefined)).toBe('undefined')
    expect(ipcErrorText(null)).toBe('null')
  })
})
