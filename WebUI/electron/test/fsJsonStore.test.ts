import { describe, expect, it } from 'vitest'
import { makeWriteChains } from '../fsJsonStore'

describe('makeWriteChains', () => {
  it('prunes a settled key so the map does not grow without bound', async () => {
    const chains = makeWriteChains()
    await chains.serialize('a', async () => 'ok')
    expect(chains.pendingCountForTest()).toBe(0)
  })

  it('keeps a key while a later write is still in flight, then prunes', async () => {
    const chains = makeWriteChains()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = chains.serialize('a', async () => held)
    expect(chains.pendingCountForTest()).toBe(1)
    const second = chains.serialize('a', async () => 'done')
    expect(chains.pendingCountForTest()).toBe(1)
    release()
    await first
    await second
    expect(chains.pendingCountForTest()).toBe(0)
  })
})
