import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A Trial Run working in its Agent's own folder, against real temp dirs: what it writes there
// outlives the Trial Run, while its scratch folder still goes with it.

const paths = vi.hoisted(() => ({ trials: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  net: { fetch: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}))

vi.mock('../../persist/userDataPaths.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../persist/userDataPaths.ts')>()),
  getAgentTrialsDir: () => paths.trials,
  getChannelMessageMapFile: () => path.join(paths.trials, '..', 'channel-messages.json'),
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { discardTrialRun, setTrialRunDeps, trialRunHarnessFor, wipeTrialRuns } =
  await import('../../agent/trialRuns')
const { trialMediaOf } = await import('../../agent/piSessionLifecycle')
const { attachmentsFolderFor } = await import('../../session/sessionAttachments')
const { saveGeneratedMediaToWorkspace, setAppMediaPathResolver } =
  await import('../../agent/piCustomTools')

let tmpRoot = ''
let site = ''
let appMedia = ''

beforeEach(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trial-override-')))
  paths.trials = path.join(tmpRoot, 'agent-trials')
  site = path.join(tmpRoot, 'site')
  appMedia = path.join(tmpRoot, 'media')
  await fs.mkdir(site)
  await fs.mkdir(appMedia)
  setTrialRunDeps({ deleteHarnessSession: async () => {} })
  setAppMediaPathResolver((url) => path.join(appMedia, path.basename(new URL(url).pathname)))
})

afterEach(async () => {
  setAppMediaPathResolver(null)
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

const exists = (target: string) =>
  fs.stat(target).then(
    () => true,
    () => false,
  )

async function generate(workspaceDir: string, agentId: string, name: string) {
  await fs.writeFile(path.join(appMedia, name), 'png')
  const url = `aipg-media://media/${name}`
  return (await saveGeneratedMediaToWorkspace(
    { images: [{ id: name, type: 'image', imageUrl: url }] },
    workspaceDir,
    trialMediaOf(agentId, workspaceDir),
  )) as { images: { imageUrl: string }[]; savedFiles: string[] }
}

describe("a Trial Run working in its Agent's own folder", () => {
  it("saves its media at that folder's root under a free name, shown from scratch", async () => {
    const trial = await trialRunHarnessFor('agent-1')
    await fs.writeFile(path.join(site, 'cat.png'), 'mine')

    const result = await generate(site, 'agent-1', 'cat.png')

    expect(result.savedFiles).toEqual(['cat-1.png'])
    expect(await fs.readFile(path.join(site, 'cat-1.png'), 'utf8')).toBe('png')
    expect(await fs.readFile(path.join(site, 'cat.png'), 'utf8')).toBe('mine')
    expect(await exists(path.join(site, 'generated'))).toBe(false)
    expect(await exists(path.join(trial.workspaceDir, 'cat.png'))).toBe(true)
    expect(result.images[0].imageUrl).toBe('aipg-media://trials/agent-1/files/cat.png')
  })

  it('keeps its attachments in its scratch folder, never in that folder', async () => {
    const trial = await trialRunHarnessFor('agent-1')

    const folder = attachmentsFolderFor({ workspaceDir: site, trialAgentId: 'agent-1' })

    expect(folder).toEqual({
      dir: path.join(path.dirname(trial.workspaceDir), 'attachments'),
      reference: '/attachments',
    })
  })

  it('leaves its files there when a later Trial Run, discard or quit clears it', async () => {
    const first = await trialRunHarnessFor('agent-1')
    await fs.writeFile(path.join(site, 'notes.md'), 'kept')
    await generate(site, 'agent-1', 'cat.png')

    await trialRunHarnessFor('agent-1')
    expect(await exists(path.join(first.workspaceDir, 'cat.png'))).toBe(false)
    await discardTrialRun('agent-1')
    await trialRunHarnessFor('agent-1')
    await wipeTrialRuns()

    expect(await fs.readFile(path.join(site, 'notes.md'), 'utf8')).toBe('kept')
    expect(await fs.readFile(path.join(site, 'cat.png'), 'utf8')).toBe('png')
    expect(await exists(paths.trials)).toBe(false)
  })
})

describe('a Trial Run without a Workspace override', () => {
  it('saves its media in its scratch folder, which goes with it', async () => {
    const trial = await trialRunHarnessFor('agent-1')

    const result = await generate(trial.workspaceDir, 'agent-1', 'cat.png')

    expect(result.images[0].imageUrl).toBe('aipg-media://trials/agent-1/files/cat.png')
    expect(await exists(path.join(trial.workspaceDir, 'cat.png'))).toBe(true)
    await discardTrialRun('agent-1')
    expect(await exists(trial.workspaceDir)).toBe(false)
  })
})
