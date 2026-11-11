import { describe, expect, it, vi } from 'vitest'
import {
  legacyRoutingKey,
  migrateHomeAgentThreads,
  type HomeAgentThreadMigrationDeps,
} from '@/lib/homeAgentThreadMigration'

// The window's half of moving Home Agent threads into Sessions: it alone kept the routing pointer.

function deps(overrides: Partial<Pick<HomeAgentThreadMigrationDeps, 'migrate'>> = {}) {
  return {
    setChannelSession: vi.fn<HomeAgentThreadMigrationDeps['setChannelSession']>(),
    storedHomeAgentState: () =>
      JSON.stringify({ masterEnabled: true, activeRemoteConversationKey: 'ha-2' }),
    defaultCapabilities: () => ['web', 'rag'],
    migrate: vi.fn(async () => ({ success: true as const, channelSession: 'session-2' })),
    report: vi.fn(),
    ...overrides,
  }
}

describe('the Home Agent routing pointer', () => {
  it('is read from the Home Agent store as it was persisted', () => {
    expect(legacyRoutingKey(JSON.stringify({ activeRemoteConversationKey: 'ha-1' }))).toBe('ha-1')
  })

  it('is absent when nothing, or nothing readable, was persisted', () => {
    expect(legacyRoutingKey(null)).toBeNull()
    expect(legacyRoutingKey('{not json')).toBeNull()
    expect(legacyRoutingKey(JSON.stringify({ activeRemoteConversationKey: null }))).toBeNull()
    expect(legacyRoutingKey(JSON.stringify({ activeRemoteConversationKey: 7 }))).toBeNull()
  })
})

describe('migrating Home Agent threads from the window', () => {
  it('hands main the routing pointer and the default capabilities', async () => {
    const d = deps()

    await migrateHomeAgentThreads(d)

    expect(d.migrate).toHaveBeenCalledWith({
      routingKey: 'ha-2',
      defaultCapabilities: ['web', 'rag'],
    })
  })

  it("points every Channel's live pointer at the Channel Session main set", async () => {
    const d = deps()

    await migrateHomeAgentThreads(d)

    expect(d.setChannelSession.mock.calls).toEqual([
      ['telegram', 'session-2'],
      ['slack', 'session-2'],
      ['discord', 'session-2'],
      ['local-web', 'session-2'],
    ])
  })

  it('leaves the pointers alone when main set none', async () => {
    const d = deps({
      migrate: vi.fn(async () => ({ success: true as const, channelSession: null })),
    })

    await migrateHomeAgentThreads(d)

    expect(d.setChannelSession).not.toHaveBeenCalled()
  })

  it('reports a failure through the error sink', async () => {
    const d = deps({
      migrate: vi.fn(async () => ({ success: false as const, error: 'disk full' })),
    })

    await migrateHomeAgentThreads(d)

    expect(d.report).toHaveBeenCalledWith(
      expect.objectContaining({ technicalMessage: 'disk full' }),
    )
    expect(d.setChannelSession).not.toHaveBeenCalled()
  })

  it('does not stop the boot when the call itself rejects', async () => {
    const d = deps({ migrate: vi.fn(async () => Promise.reject(new Error('no handler'))) })

    await migrateHomeAgentThreads(d)

    expect(d.report).toHaveBeenCalledWith(
      expect.objectContaining({ technicalMessage: 'Error: no handler' }),
    )
  })
})
