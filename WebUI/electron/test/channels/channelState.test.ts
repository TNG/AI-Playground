import { describe, expect, it, vi } from 'vitest'
import { createChannelState, type ChannelStore } from '../../channels/channelState'
import type { ChannelKind } from '@/assets/js/store/channels/types'

function memoryStore(initial: Partial<Record<ChannelKind, Record<string, string>>> = {}) {
  const configs = new Map(Object.entries(initial)) as Map<ChannelKind, Record<string, string>>
  const prefs = new Map<ChannelKind, { verified: boolean; enabled: boolean }>()
  const inject = vi.fn<ChannelStore['inject']>(async () => ({ status: 'ok' }))
  const store: ChannelStore = {
    loadConfig: (kind) => configs.get(kind) ?? null,
    saveConfig: (kind, config) => {
      configs.set(kind, { ...config })
      return { success: true }
    },
    clearConfig: (kind) => {
      configs.delete(kind)
      prefs.delete(kind)
    },
    loadPrefs: (kind) => prefs.get(kind) ?? null,
    savePrefs: (kind, next) => {
      const previous = prefs.get(kind) ?? { verified: false, enabled: false }
      prefs.set(kind, { ...previous, ...next })
      return { success: true }
    },
    inject,
  }
  return { store, prefs, inject }
}

function setup(store: ChannelStore, master: boolean | null = null) {
  let stored = master
  const host = createChannelState({
    store,
    readMaster: async () => stored,
    writeMaster: async (on) => {
      stored = on
    },
    log: () => {},
  })
  return { host, master: () => stored }
}

describe('channelState', () => {
  it('runs a Channel only when the backend is up, the switch on, and it is enabled and verified', async () => {
    const { store, prefs } = memoryStore({ telegram: { token: 't', chatId: '42' } })
    prefs.set('telegram', { verified: true, enabled: true })
    const { host } = setup(store)
    await host.init()

    expect(host.activeKinds()).toEqual([])
    host.setAvailable(true)
    expect(host.activeKinds()).toEqual(['telegram'])
    expect(host.state().prefs.telegram.identity).toBe('42')

    await host.setMaster(false)
    expect(host.activeKinds()).toEqual([])
  })

  it('starts each configured bot once the backend comes up', async () => {
    const { store, inject } = memoryStore({
      telegram: { token: 't' },
      slack: { botToken: 'b' },
    })
    const { host } = setup(store)
    await host.init()

    host.setAvailable(true)
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(1))
    expect(inject).toHaveBeenCalledWith('telegram', { token: 't' })
  })

  it('needs new credentials tested again, keeping the Channel enabled', async () => {
    const { store, prefs } = memoryStore({ telegram: { token: 'old' } })
    prefs.set('telegram', { verified: true, enabled: true })
    const { host } = setup(store)
    await host.init()

    await host.saveConfig('telegram', { token: 'old' })
    expect(host.state().prefs.telegram.verified).toBe(true)

    await host.saveConfig('telegram', { token: 'new', chatId: '7' })
    expect(host.state().prefs.telegram).toEqual({ verified: false, enabled: true, identity: '7' })
    expect(prefs.get('telegram')).toEqual({ verified: false, enabled: true })
  })

  it('refuses to enable a Channel that was never verified', async () => {
    const { store } = memoryStore()
    const { host } = setup(store)
    await host.init()

    expect(host.setEnabled('slack', true).success).toBe(false)
    expect(host.setVerified('slack').success).toBe(true)
    expect(host.state().prefs.slack).toMatchObject({ verified: true, enabled: true })
  })

  it("takes the window's legacy switch and prefs only where the kernel has none", async () => {
    const { store, prefs } = memoryStore()
    prefs.set('slack', { verified: false, enabled: false })
    const { host, master } = setup(store)
    await host.init()

    await host.migrate({
      masterEnabled: false,
      prefs: {
        telegram: { verified: true, enabled: true, identity: '42' },
        slack: { verified: true, enabled: true, identity: 'U1' },
      },
    })

    expect(master()).toBe(false)
    expect(host.state().prefs.telegram).toEqual({ verified: true, enabled: true, identity: '42' })
    expect(host.state().prefs.slack.verified).toBe(false)

    await host.migrate({ masterEnabled: true, prefs: {} })
    expect(master()).toBe(false)
  })

  it('tells every listener the new state on each change', async () => {
    const { store } = memoryStore()
    const { host } = setup(store, true)
    const states: boolean[] = []
    host.onChange((state) => states.push(state.masterEnabled))
    await host.init()

    await host.setMaster(false)

    expect(states).toEqual([true, false])
  })
})
