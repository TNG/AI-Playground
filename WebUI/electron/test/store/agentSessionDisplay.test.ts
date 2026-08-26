import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import {
  collapseGamesPrefix,
  listPresetSessions,
  promoteSession,
  sessionDisplayTitle,
  snapshotSession,
  type AgentSessionRecord,
} from '@/assets/js/store/agentModeSessions'

// What a session card reads: the library prefix every game shares is collapsed
// into the path icon, and the card is named after the preset and the game rather
// than the prompt that started it.

const userTurn = (text: string): UIMessage => ({
  id: 'm1',
  role: 'user',
  parts: [{ type: 'text', text }],
})

function archived(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: 's1',
    workspaceDir: '/games/space-dodger',
    title: 'dodge asteroids',
    messages: [userTurn('dodge asteroids')],
    createdAt: 1_000,
    updatedAt: 2_000,
    presetName: 'Game Agent',
    ...overrides,
  }
}

describe('collapseGamesPrefix', () => {
  it('drops everything through the games folder', () => {
    expect(collapseGamesPrefix('/Users/me/AI-Playground/games/space-dodger')).toEqual({
      collapsed: true,
      rest: 'space-dodger',
    })
  })

  it('collapses a Windows path too', () => {
    expect(
      collapseGamesPrefix('C:\\Users\\me\\Documents\\AI-Playground\\games\\space-dodger'),
    ).toEqual({ collapsed: true, rest: 'space-dodger' })
  })

  it('keeps whatever follows the games folder', () => {
    expect(collapseGamesPrefix('/Users/me/AI-Playground/games/space-dodger/levels')).toEqual({
      collapsed: true,
      rest: 'space-dodger/levels',
    })
  })

  it('leaves a picked folder alone', () => {
    expect(collapseGamesPrefix('/Users/me/code/my-app')).toEqual({
      collapsed: false,
      rest: '/Users/me/code/my-app',
    })
  })

  it('leaves the games folder itself alone, having nothing to show for it', () => {
    expect(collapseGamesPrefix('/Users/me/AI-Playground/games')).toEqual({
      collapsed: false,
      rest: '/Users/me/AI-Playground/games',
    })
  })
})

describe('sessionDisplayTitle', () => {
  it('names the preset and the game', () => {
    expect(
      sessionDisplayTitle({
        title: 'a game where I dodge asteroids',
        presetLabel: 'Game Agent',
        gameName: 'Space Dodger',
      }),
    ).toEqual({ mode: 'Game Agent', name: 'Space Dodger' })
  })

  it('keeps the OEM-branded preset label it was handed', () => {
    expect(
      sessionDisplayTitle({ title: 'anything', presetLabel: 'Acer Quick Coder', gameName: 'Pong' }),
    ).toEqual({ mode: 'Acer Quick Coder', name: 'Pong' })
  })

  it('falls back to the first-prompt title when there is no game card', () => {
    expect(sessionDisplayTitle({ title: 'refactor the parser', presetLabel: 'Agent' })).toEqual({
      mode: 'Agent',
      name: 'refactor the parser',
    })
  })

  it('falls back to Agent for a session archived before presets', () => {
    expect(sessionDisplayTitle({ title: 'from before presets' })).toEqual({
      mode: 'Agent',
      name: 'from before presets',
    })
  })

  it('ignores a blank game name', () => {
    expect(
      sessionDisplayTitle({
        title: 'a game about crates',
        presetLabel: 'Game Agent',
        gameName: ' ',
      }),
    ).toEqual({ mode: 'Game Agent', name: 'a game about crates' })
  })
})

describe('snapshotSession', () => {
  it('does not move updatedAt when stop() re-archives the same transcript', () => {
    const existing = archived()
    const next = snapshotSession({
      id: existing.id,
      workspaceDir: existing.workspaceDir,
      messages: existing.messages,
      existing,
      capabilities: [],
      presetName: 'Game Agent',
    })
    expect(next?.updatedAt).toBe(2_000)
  })

  it('stamps updatedAt when the transcript grew', () => {
    const existing = archived()
    const next = snapshotSession({
      id: existing.id,
      workspaceDir: existing.workspaceDir,
      messages: [...existing.messages, userTurn('again')],
      existing,
      capabilities: [],
      presetName: 'Game Agent',
    })
    expect(next?.updatedAt).toBeGreaterThan(2_000)
  })
})

describe('promoteSession', () => {
  const promoted = () =>
    promoteSession(
      archived({ presetName: 'Quick Coder', capabilities: ['game-studio-quick'] }),
      'Game Agent',
      ['media', 'web-debug', 'game-studio'],
    )

  it('overwrites the fields a snapshot would otherwise freeze', () => {
    const next = promoted()
    expect(next.presetName).toBe('Game Agent')
    expect(next.capabilities).toEqual(['media', 'web-debug', 'game-studio'])
    // Everything that identifies the work is the point of moving rather than
    // copying: same conversation, same folder, same clock.
    expect(next.id).toBe('s1')
    expect(next.workspaceDir).toBe('/games/space-dodger')
    expect(next.messages).toHaveLength(1)
    expect(next.updatedAt).toBe(2_000)
  })

  it('survives the next archive of the same session', () => {
    const next = promoted()
    expect(
      snapshotSession({
        id: next.id,
        workspaceDir: next.workspaceDir,
        messages: [...next.messages, userTurn('now add sound')],
        existing: next,
        capabilities: ['media', 'web-debug', 'game-studio'],
        // What the store would pass if the switch had not been recorded.
        presetName: 'Quick Coder',
      }),
    ).toMatchObject({ presetName: 'Game Agent' })
  })

  it('stays in the games list it was already in', () => {
    const next = promoted()
    expect(listPresetSessions({ [next.id]: next }, 'Quick Coder').map((s) => s.id)).toEqual(['s1'])
    expect(listPresetSessions({ [next.id]: next }, 'Game Agent').map((s) => s.id)).toEqual(['s1'])
  })
})

describe('listPresetSessions', () => {
  const bag = {
    ga: archived({ id: 'ga', presetName: 'Game Agent' }),
    qc: archived({
      id: 'qc',
      presetName: 'Quick Coder',
      workspaceDir: '/games/pong',
    }),
    agent: archived({
      id: 'agent',
      presetName: 'Agent',
      workspaceDir: '/code/project',
      title: 'refactor',
    }),
  }

  it('lists Game Agent and Quick Coder sessions together', () => {
    expect(
      listPresetSessions(bag, 'Quick Coder')
        .map((s) => s.id)
        .sort(),
    ).toEqual(['ga', 'qc'])
    expect(
      listPresetSessions(bag, 'Game Agent')
        .map((s) => s.id)
        .sort(),
    ).toEqual(['ga', 'qc'])
  })

  it('keeps the folder-picking Agent on its own list', () => {
    expect(listPresetSessions(bag, 'Agent').map((s) => s.id)).toEqual(['agent'])
  })
})
