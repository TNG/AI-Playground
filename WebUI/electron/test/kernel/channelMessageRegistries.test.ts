import { describe, expect, it, vi } from 'vitest'
import { buildAgentModeRegistry, type AgentModeDeps } from '../../kernel/registries/agentMode'
import { buildNotificationsRegistry } from '../../kernel/registries/notifications'

const event = {} as Electron.IpcMainInvokeEvent

function logger() {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
}

function deleteSessionWith(
  record: { success: boolean; error?: string },
  live: { success: boolean; error?: string },
  forget: () => Promise<void> = async () => {},
) {
  const forgetSessionMessages = vi.fn(forget)
  const appLogger = logger()
  const registry = buildAgentModeRegistry({
    deleteAgentSessionRecord: async () => record,
    deleteAgentSession: async () => live,
    forgetSessionMessages,
    appLogger,
  } as unknown as AgentModeDeps)
  const deleteSession = registry['agentMode:deleteSession'] as (
    e: Electron.IpcMainInvokeEvent,
    id: unknown,
  ) => Promise<{ success: boolean }>
  return { deleteSession, forgetSessionMessages, appLogger }
}

describe('deleting an agent session', () => {
  it('marks its channel messages as a deleted session’s once both halves are gone', async () => {
    const { deleteSession, forgetSessionMessages } = deleteSessionWith(
      { success: true },
      { success: true },
    )
    expect(await deleteSession(event, 's1')).toEqual({ success: true })
    expect(forgetSessionMessages).toHaveBeenCalledWith('s1')
  })

  it.each([
    ['its record', { success: false, error: 'disk full' }, { success: true }],
    ['its Pi session', { success: true }, { success: false, error: 'busy' }],
  ])('keeps its channel messages answerable when %s could not be deleted', async (_, r, l) => {
    const { deleteSession, forgetSessionMessages } = deleteSessionWith(r, l)
    expect((await deleteSession(event, 's1')).success).toBe(false)
    expect(forgetSessionMessages).not.toHaveBeenCalled()
  })

  it('logs a failure to forget its channel messages, and still reports the delete', async () => {
    const { deleteSession, appLogger } = deleteSessionWith(
      { success: true },
      { success: true },
      () => Promise.reject(new Error('locked')),
    )
    expect(await deleteSession(event, 's1')).toEqual({ success: true })
    expect(appLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('locked'),
      expect.any(String),
    )
  })
})

describe('looking up a channel message', () => {
  it('logs a failed lookup and answers that no agent sent it', async () => {
    const appLogger = logger()
    const registry = buildNotificationsRegistry({
      channelMessageOwner: async () => {
        throw new Error('corrupt map')
      },
      recordChannelMessage: async () => {},
      appLogger,
    } as unknown as Parameters<typeof buildNotificationsRegistry>[0])
    const lookup = registry['notifications:lookupMessage'] as (
      e: Electron.IpcMainInvokeEvent,
      kind: string,
      ref: string,
    ) => Promise<unknown>
    expect(await lookup(event, 'telegram', '12')).toBeNull()
    expect(appLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('corrupt map'),
      expect.any(String),
    )
  })
})
