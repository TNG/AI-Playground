import { describe, expect, it, vi } from 'vitest'
import { createWindowPort } from '../../channels/windowPort'
import { answerRouterCopy } from '@/lib/answerRouterWording'
import type { ChannelAdapter } from '@/assets/js/store/channels/adapter'
import type { ChannelPortAsk, ChannelPortState } from '@/types/channelHostIpc'

function mirror(overrides: Partial<ChannelPortState> = {}): ChannelPortState {
  return {
    existing: ['s-1', 's-2'],
    reachable: ['s-1', 's-2'],
    activity: {},
    trialRuns: {},
    labels: { sessions: { 's-1': '"Trip"' }, harness: { 'h-1': '"Report"' }, trialRuns: {} },
    harness: { 'h-1': { realShell: false, assistantOf: 's-1' }, 'h-2': { realShell: true } },
    agentNames: { 'agent-1': 'Morning news' },
    typedQuestionKinds: [],
    copy: answerRouterCopy(),
    ...overrides,
  }
}

const adapter = { kind: 'telegram' } as ChannelAdapter

function setup() {
  const asks: ChannelPortAsk[] = []
  const port = createWindowPort({
    post: (ask) => {
      asks.push(ask)
      return true
    },
    lookup: async () => null,
    recordStartPromptRequest: async () => {},
    log: () => {},
  })
  return { port, asks }
}

describe('windowPort', () => {
  it('has no Sessions until the window sends its first mirror', async () => {
    const { port, asks } = setup()
    expect(port.port()).toBeNull()

    const subscribed = port.subscribe()
    expect(asks[0].call).toEqual({ op: 'subscribe' })
    port.answer({ requestId: asks[0].requestId, result: null, state: mirror() })
    await subscribed

    expect(port.ready()).toBe(true)
    expect(port.port()).not.toBeNull()
  })

  it('answers the router’s synchronous questions from the mirror', () => {
    const { port } = setup()
    port.mirror(mirror({ activity: { 's-1': { kind: 'turn' } } }))
    const sessions = port.port()!

    expect(sessions.activity('s-1')).toEqual({ kind: 'turn' })
    expect(sessions.activity('s-2')).toEqual({ kind: 'idle' })
    expect(sessions.label({ sessionRef: 's-1' })).toBe('"Trip"')
    expect(sessions.agentName('agent-1')).toBe('Morning news')
    expect(sessions.usesRealShell({ sessionRef: 's-1', harnessSessionId: 'h-2' })).toBe(true)
    expect(sessions.turnTarget({ sessionRef: 's-1', harnessSessionId: 'h-1' })).toBe('s-1')
    expect(sessions.turnTarget({ sessionRef: 's-1', harnessSessionId: 'h-2' })).toBe('h-2')
  })

  it('takes the mirror an answer carries before the call resolves', async () => {
    const { port, asks } = setup()
    port.mirror(mirror())
    const sessions = port.port()!

    const sent = sessions.send({ sessionRef: 's-1' }, 'hello', { channel: 'telegram' })
    port.answer({
      requestId: asks[0].requestId,
      result: { ok: true, queuePosition: null },
      state: mirror({ activity: { 's-1': { kind: 'turn' } } }),
    })

    await expect(sent).resolves.toEqual({ ok: true, queuePosition: null })
    expect(sessions.activity('s-1')).toEqual({ kind: 'turn' })
  })

  it('tells the router a Session settled, lost reachability or was deleted', () => {
    const { port } = setup()
    port.mirror(
      mirror({ activity: { 's-1': { kind: 'turn' }, 's-2': { kind: 'agent-run', name: 'X' } } }),
    )
    const changes: [string, string][] = []
    port.port()!.onSessionChange((sessionRef, change) => changes.push([sessionRef, change]))

    port.mirror(mirror({ existing: ['s-1'], reachable: [], activity: {} }))

    expect(changes).toEqual([
      ['s-1', 'unreachable'],
      ['s-2', 'deleted'],
      ['s-1', 'settled'],
      ['s-2', 'settled'],
    ])
  })

  it('tells the router a Trial Run was thrown away before any settle', () => {
    const { port } = setup()
    port.mirror(mirror({ trialRuns: { 't-1': { kind: 'turn' }, 't-2': { kind: 'turn' } } }))
    const changes: [string, string][] = []
    port.port()!.onTrialRunChange((id, change) => changes.push([id, change]))

    port.mirror(mirror({ trialRuns: { 't-2': { kind: 'idle' } } }))

    expect(changes).toEqual([
      ['t-1', 'thrown-away'],
      ['t-2', 'settled'],
    ])
  })

  it('claims a button tap for the window’s Channel Question and a typed yes/no only while one is open', () => {
    const { port, asks } = setup()
    port.mirror(mirror())
    const { handleInbound } = port.questions

    expect(handleInbound(adapter, { callback: 'confirm:abc:yes' })).toBe(true)
    expect(handleInbound(adapter, { callback: 'answer:1' })).toBe(false)
    expect(handleInbound(adapter, { text: 'yes' })).toBe(false)

    port.mirror(mirror({ typedQuestionKinds: ['telegram'] }))
    expect(handleInbound(adapter, { text: 'yes' })).toBe(true)
    expect(handleInbound(adapter, { text: 'tell me more' })).toBe(false)

    expect(asks.map((ask) => ask.call.op)).toEqual([
      'questionInbound',
      'questionInbound',
      'questionInbound',
    ])
  })

  it('waits for a speech model download through a second call', async () => {
    const { port, asks } = setup()
    port.mirror(mirror())

    const prepared = port.speech.prepare(adapter)
    port.answer({ requestId: asks[0].requestId, result: { downloadToken: 'tok' } })
    const preparation = await prepared
    expect('downloading' in preparation).toBe(true)
    expect(asks[1].call).toEqual({ op: 'speechDownload', token: 'tok' })

    port.answer({ requestId: asks[1].requestId, result: true })
    await expect((preparation as { downloading: Promise<boolean> }).downloading).resolves.toBe(true)
  })

  it('fails every call in flight and forgets the mirror when the window is replaced', async () => {
    const { port } = setup()
    port.mirror(mirror())
    const created = port.port()!.create()

    port.reset('The app window was replaced')

    await expect(created).rejects.toThrow('The app window was replaced')
    expect(port.port()).toBeNull()
  })

  it('fails a call at once when there is no window to post it to', async () => {
    const log = vi.fn()
    const port = createWindowPort({
      post: () => false,
      lookup: async () => null,
      recordStartPromptRequest: async () => {},
      log,
    })
    port.mirror(mirror())

    await expect(port.port()!.listReachable()).rejects.toThrow('No app window')
  })
})
