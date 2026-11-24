import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  addRemotePeer,
  currentDriver,
  deliverPush,
  noteDriver,
  resetRendererSinksForTest,
} from '../../../kernel/rendererSinks'

function windowSender() {
  const send = vi.fn()
  return { send, sender: { send, isDestroyed: () => false } as unknown as WebContents }
}

function peer(id: string) {
  const push = vi.fn()
  return { push, remove: addRemotePeer({ id, push }) }
}

beforeEach(() => resetRendererSinksForTest())

describe('renderer sinks', () => {
  it('sends straight to the window while no remote renderer is connected', () => {
    const { send, sender } = windowSender()
    deliverPush(sender, 'permissions:prompt', { requestId: 'r1' })
    expect(send).toHaveBeenCalledWith('permissions:prompt', { requestId: 'r1' })
  })

  it('broadcasts prompts to the window and every peer', () => {
    const { send, sender } = windowSender()
    const a = peer('a')
    const b = peer('b')
    deliverPush(sender, 'permissions:prompt', { requestId: 'r1' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(a.push).toHaveBeenCalledWith('permissions:prompt', { requestId: 'r1' })
    expect(b.push).toHaveBeenCalledWith('permissions:prompt', { requestId: 'r1' })
  })

  it('keeps local pushes on the window', () => {
    const { send, sender } = windowSender()
    const a = peer('a')
    deliverPush(sender, 'lifecycle:askClose', { requestId: 'c1' } as never)
    expect(send).toHaveBeenCalledTimes(1)
    expect(a.push).not.toHaveBeenCalled()
  })

  it('runs work-executing pushes only on the renderer that drives the turn', () => {
    const { send, sender } = windowSender()
    const a = peer('a')
    noteDriver('a')
    deliverPush(sender, 'agentMode:executeTool', { requestId: 't1' } as never)
    expect(a.push).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()

    noteDriver('window')
    deliverPush(sender, 'chat:ask', { requestId: 'q1' } as never)
    expect(send).toHaveBeenCalledTimes(1)
    expect(a.push).toHaveBeenCalledTimes(1)
  })

  it('hands the driver back to the window when the driving peer disconnects', () => {
    const { send, sender } = windowSender()
    const a = peer('a')
    noteDriver('a')
    a.remove()
    expect(currentDriver()).toBe('window')
    deliverPush(sender, 'artifact:request', { requestId: 'm1' } as never)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
