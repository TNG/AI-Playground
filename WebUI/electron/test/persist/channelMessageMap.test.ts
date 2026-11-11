import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnswerTarget } from '@/types/notificationsIpc'
import type { SessionTarget } from '../../../src/assets/js/store/channels/answerRouter'
import type { AgentAnswerOrigin } from '@/types/agentIpc'

const dirs = vi.hoisted(() => ({ root: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => path.join(dirs.root, 'sessions'),
  getSessionsDemoDir: () => path.join(dirs.root, 'sessions-demo'),
  getChannelMessageMapFile: () => path.join(dirs.root, 'channel-messages.json'),
  getChannelMessageMapDemoFile: () => path.join(dirs.root, 'channel-messages-demo.json'),
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../kernel/kernelBus', () => ({
  emitSessionChanged: vi.fn(),
  emitSessionGroupsChanged: vi.fn(),
}))

const messageMap = await import('../../persist/channelMessageMap')
const { createSession, resetSessionsForTest } = await import('../../session/sessions')
const { harnessSessionFor, harnessSessionOwners } = await import('../../session/sessionHarness')
const { createAnswerRouter } = await import('../../../src/assets/js/store/channels/answerRouter')
const { createChannelQuestionRegistry } =
  await import('../../../src/assets/js/store/channels/channelQuestions')
type ChannelAdapter = import('../../../src/assets/js/store/channels/adapter').ChannelAdapter

const mapFile = () => path.join(dirs.root, 'channel-messages.json')

async function writeLegacyMap(entries: { kind: string; ref: string; sessionId: string | null }[]) {
  await fs.writeFile(mapFile(), JSON.stringify({ schemaVersion: 1, entries }))
}

/** A Session holding an Assistant Harness Session, as one that has sent a Notification. */
async function sessionWithHarness(): Promise<AnswerTarget> {
  const { id } = await createSession()
  const { harnessSessionId } = await harnessSessionFor(id, 'Assistant')
  return { sessionRef: id, harnessSessionId }
}

beforeEach(async () => {
  dirs.root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-channel-messages-'))
  messageMap.resetChannelMessageMapForTest()
  resetSessionsForTest()
  messageMap.setChannelMessageMapDeps({ isDemoMode: () => false, harnessSessionOwners })
})

afterEach(async () => {
  await fs.rm(dirs.root, { recursive: true, force: true })
})

describe('the channel message map', () => {
  it('remembers a message as its Session’s and its Harness Session’s', async () => {
    const owner = await sessionWithHarness()
    await messageMap.recordChannelMessage('telegram', '42', owner)
    expect(await messageMap.channelMessageOwner('telegram', '42')).toEqual(owner)
    expect(await messageMap.channelMessageOwner('slack', '42')).toBeNull()
  })

  it('keeps a deleted Harness Session’s messages as tombstones', async () => {
    const owner = await sessionWithHarness()
    await messageMap.recordChannelMessage('telegram', '42', owner)
    await messageMap.forgetHarnessSessionMessages(owner.harnessSessionId)
    expect(await messageMap.channelMessageOwner('telegram', '42')).toEqual({
      deletedSession: true,
    })
  })

  it('migrates entries written before Sessions owned them, by their Harness Session’s Session', async () => {
    const owner = await sessionWithHarness()
    await writeLegacyMap([
      { kind: 'telegram', ref: '1', sessionId: owner.harnessSessionId },
      { kind: 'telegram', ref: '2', sessionId: 'aipg-agent-from-before-sessions' },
      { kind: 'slack', ref: '3', sessionId: null },
    ])
    expect(await messageMap.channelMessageOwner('telegram', '1')).toEqual(owner)
    expect(await messageMap.channelMessageOwner('telegram', '2')).toEqual({ deletedSession: true })
    expect(await messageMap.channelMessageOwner('slack', '3')).toEqual({ deletedSession: true })
  })

  it('starts over when the file is unreadable', async () => {
    await fs.writeFile(mapFile(), '{not json')
    expect(await messageMap.channelMessageOwner('telegram', '1')).toBeNull()
    const owner = await sessionWithHarness()
    await messageMap.recordChannelMessage('telegram', '1', owner)
    expect(await messageMap.channelMessageOwner('telegram', '1')).toEqual(owner)
  })

  it('routes an Answer to a migrated entry into the Harness Session that sent it', async () => {
    const owner = await sessionWithHarness()
    await writeLegacyMap([{ kind: 'telegram', ref: '1234', sessionId: owner.harnessSessionId }])
    const sent: { target: SessionTarget; message: string; origin: AgentAnswerOrigin }[] = []
    const router = createAnswerRouter({
      sessions: () => ({
        exists: async () => true,
        isReachable: async () => true,
        listReachable: async () => [],
        create: async () => 'session-new',
        transcript: async () => [],
        lookup: messageMap.channelMessageOwner,
        label: () => '"Asteroids clone"',
        usesRealShell: () => false,
        attach: async () => ({ ok: false, reason: 'error', message: 'no files here' }),
        send: async (target, message, origin) => {
          sent.push({ target, message, origin })
          return { ok: true, queuePosition: null }
        },
        listStartableAgents: async () => [],
        startAgent: async () => ({ ok: false, reason: 'no-task', message: '' }),
        activity: () => ({ kind: 'idle' }),
        stop: async () => ({ kind: 'idle' }),
        onSessionChange: () => () => {},
      }),
      questions: createChannelQuestionRegistry({ newId: () => 'q1', log: () => {} }),
      pointers: { get: () => null, set: () => {} },
      log: () => {},
    })
    const channel = {
      kind: 'telegram',
      formatMarkdown: (md: string) => md,
      post: async () => ({ success: true }),
      reply: async () => ({ success: true }),
    } as unknown as ChannelAdapter

    await router.route(channel, {
      text: 'try a smaller level',
      replyTo: '1234',
      replyTarget: '1300',
    })

    expect(sent).toEqual([
      {
        target: owner,
        message: 'try a smaller level',
        origin: { channel: 'telegram', replyTo: '1300' },
      },
    ])
  })
})
