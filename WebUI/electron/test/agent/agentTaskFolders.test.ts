import { beforeEach, describe, expect, it, vi } from 'vitest'

const opened = vi.hoisted(() => [] as string[])

vi.mock('../../adapters/osFileActions', () => ({
  openDirectory: async (dir: string) => void opened.push(dir),
}))

vi.mock('../../persist/agentTaskFiles', () => ({
  readAgentTasks: async () => [
    {
      id: 'agent-1',
      name: 'Researcher',
      settingsTemplate: { mountedFolders: [{ hostPath: '/Users/me/Papers', access: 'read-only' }] },
    },
  ],
}))

const { openAgentTaskFolder } = await import('../../agent/agentTaskFolders')

beforeEach(() => {
  opened.length = 0
})

describe("opening a saved Agent's folder", () => {
  it('opens a folder the Agent lists', async () => {
    await openAgentTaskFolder('agent-1', '/Users/me/Papers')

    expect(opened).toEqual(['/Users/me/Papers'])
  })

  it('refuses any other folder, or an Agent that does not exist', async () => {
    await expect(openAgentTaskFolder('agent-1', '/Users/me')).rejects.toThrow(/not a folder/)
    await expect(openAgentTaskFolder('agent-9', '/Users/me/Papers')).rejects.toThrow(/not a folder/)

    expect(opened).toEqual([])
  })
})
