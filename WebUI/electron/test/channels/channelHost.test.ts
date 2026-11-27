import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChannelHost } from '../../channels/channelHost'
import { createChannelState, type ChannelStore } from '../../channels/channelState'
import { createWindowPort } from '../../channels/windowPort'
import { setChannelTransport } from '@/assets/js/store/channels/channelTransport'
import { answerRouterCopy } from '@/lib/answerRouterWording'
import type { ChannelPortAsk, ChannelPortState } from '@/types/channelHostIpc'
import type { ChannelInboundMessage } from '@/types/channelIpc'

const portState = (): ChannelPortState => ({
  existing: [],
  reachable: [],
  activity: {},
  trialRuns: {},
  labels: { sessions: {}, harness: {}, trialRuns: {} },
  harness: {},
  agentNames: {},
  typedQuestionKinds: [],
  copy: answerRouterCopy(),
})

const store: ChannelStore = {
  loadConfig: () => ({ password: 'pw', sessionId: 'local' }),
  saveConfig: () => ({ success: true }),
  clearConfig: () => {},
  loadPrefs: () => ({ verified: true, enabled: true }),
  savePrefs: () => ({ success: true }),
  inject: async () => ({ status: 'ok' }),
}

async function setup(inbox: ChannelInboundMessage[]) {
  const sent: { kind: string; action: string; payload: Record<string, unknown> }[] = []
  setChannelTransport(async (kind, action, payload) => {
    sent.push({ kind, action, payload })
    return { success: true }
  })
  const asks: ChannelPortAsk[] = []
  const windowPort = createWindowPort({
    post: (ask) => {
      asks.push(ask)
      return true
    },
    lookup: async () => null,
    recordStartPromptRequest: async () => {},
    log: () => {},
  })
  const state = createChannelState({
    store,
    readMaster: async () => true,
    writeMaster: async () => {},
    log: () => {},
  })
  await state.init()
  state.setAvailable(true)
  const poll = vi.fn(async (kind: string) => (kind === 'local-web' ? inbox.splice(0) : []))
  const writePointers = vi.fn(async () => {})
  const host = createChannelHost({
    poll,
    state,
    windowPort,
    readPointers: async () => ({ telegram: 's-old' }),
    writePointers,
    publishQueues: () => {},
    log: () => {},
    pollIntervalMs: 10,
  })
  return { host, windowPort, asks, poll, sent, writePointers }
}

describe('channelHost', () => {
  afterEach(() => vi.useRealTimers())

  it('reads nothing off a Channel until the window mirrors its Sessions', async () => {
    const { host, windowPort, asks, poll } = await setup([{ text: '/help', chat_id: 'browser-1' }])
    await host.start()

    await vi.waitFor(() => expect(asks[0]?.call).toEqual({ op: 'subscribe' }))
    expect(poll).not.toHaveBeenCalled()

    windowPort.answer({ requestId: asks[0].requestId, result: null, state: portState() })
    await vi.waitFor(() => expect(poll).toHaveBeenCalledWith('local-web'))
    host.stop()
  })

  it('routes a Channel’s message and answers on that Channel', async () => {
    const { host, windowPort, sent } = await setup([{ text: '/help', chat_id: 'browser-1' }])
    windowPort.mirror(portState())

    await host.pollOnce('local-web')

    expect(sent).toEqual([
      {
        kind: 'local-web',
        action: 'post',
        payload: { text: expect.stringContaining('/sessions') },
      },
    ])
  })

  it('keeps each Channel’s Channel Session, a pointer set before the file was read included', async () => {
    const { host, writePointers } = await setup([])
    host.setChannelSession('local-web', 's-new')
    await host.start()
    host.setChannelSession('slack', null)

    expect(writePointers).toHaveBeenLastCalledWith({ telegram: 's-old', 'local-web': 's-new' })
    host.stop()
  })
})
