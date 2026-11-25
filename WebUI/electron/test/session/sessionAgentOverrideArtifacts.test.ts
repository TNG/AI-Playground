import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// An Agent Run whose Agent always works in its own folder: its Artifacts land in that folder and
// the Session History keeps them, whichever preset reads it afterwards.

const dirs = vi.hoisted(() => ({ root: '', real: '', demo: '', games: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  net: { fetch: vi.fn() },
}))

vi.mock('../../persist/userDataPaths.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../persist/userDataPaths.ts')>()),
  getSessionsDir: () => dirs.real,
  getLegacySessionsDir: () => dirs.real,
  getAppWorkspacesDir: () => `${dirs.real}-workspaces`,
  getSessionsDemoDir: () => dirs.demo,
  getLegacySessionsDemoDir: () => dirs.demo,
  getAppWorkspacesDemoDir: () => `${dirs.demo}-workspaces`,
  getGamesDir: () => dirs.games,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../kernel/kernelBus', () => ({ emitSessionChanged: vi.fn() }))

const { createSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { ensureSessionWorkspace } = await import('../../session/sessionWorkspace')
const { registerAgentFolder } = await import('../../session/sessionFolders')
const { sessionFolderPaths } = await import('../../persist/sessionFiles')
const { trackAgentTurnInSession } = await import('../../session/sessionAgentTurns')
const { readHistoryEntries } = await import('../../session/sessionHistory')
const { historyAsSeenBy } = await import('../../session/historyArtifacts')
const { missingArtifactUrls, newestArtifact } = await import('../../session/sessionArtifacts')
const { sessionFolderMediaFile } = await import('../../session/sessionFolderMedia')
const { attachmentsFolderFor } = await import('../../session/sessionAttachments')
const { sessionMediaOf } = await import('../../agent/piSessionLifecycle')
const { saveGeneratedMediaToWorkspace, setAppMediaPathResolver } =
  await import('../../agent/piCustomTools')
const { sessionFolderMediaUrl } = await import('@/lib/comfyWorkflow')

const OVERRIDE_ID = 'agent-folder-1'
const completed = {
  sessionId: 'aipg-agent-1',
  turnId: 'turn-1',
  outcome: 'completed',
  reply: 'done',
} as const

beforeAll(async () => {
  dirs.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-override-art-')))
  dirs.real = path.join(dirs.root, 'sessions')
  dirs.demo = path.join(dirs.root, 'sessions-demo')
  dirs.games = path.join(dirs.root, 'games')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetSessionsForTest()
  setAppMediaPathResolver(null)
  for (const dir of ['sessions', 'sessions-workspaces', 'games', 'reports', 'app-media']) {
    await fs.rm(path.join(dirs.root, dir), { recursive: true, force: true })
  }
})

/** A Session with its own Workspace, and an Agent's override folder registered in it. */
async function sessionWithOverride() {
  const { id } = await createSession()
  const workspace = await ensureSessionWorkspace(id)
  const override = path.join(dirs.root, 'reports')
  await fs.mkdir(override, { recursive: true })
  await registerAgentFolder(id, {
    agentId: 'agent-1',
    folder: { id: OVERRIDE_ID, hostPath: override, slug: 'reports' },
  })
  return { id, workspace, override }
}

/** Generates `name` the way a media tool does: an app-folder URL the save moves into place. */
async function generate(name: string, bytes: string) {
  const appMedia = path.join(dirs.root, 'app-media')
  await fs.mkdir(appMedia, { recursive: true })
  await fs.writeFile(path.join(appMedia, name), bytes)
  setAppMediaPathResolver((url) => path.join(appMedia, new URL(url).pathname))
  return { images: [{ imageUrl: `aipg-media://media/${name}` }] }
}

describe('an Agent Run working in its override folder', () => {
  it('saves its media in the override folder under free names, not the Session’s', async () => {
    const { id, workspace, override } = await sessionWithOverride()
    await fs.writeFile(path.join(override, 'chart.png'), 'earlier chart')
    const target = sessionMediaOf(id, override)

    const result = (await saveGeneratedMediaToWorkspace(
      await generate('chart.png', 'new chart'),
      override,
      target,
    )) as { images: { imageUrl: string }[]; savedFiles: string[] }

    expect(target).toEqual({ sessionRef: id, workspace: 'files', folderId: OVERRIDE_ID })
    expect(result.savedFiles).toEqual(['chart-1.png'])
    expect(await fs.readFile(path.join(override, 'chart.png'), 'utf8')).toBe('earlier chart')
    expect(await fs.readFile(path.join(override, 'chart-1.png'), 'utf8')).toBe('new chart')
    expect(await fs.readdir(workspace)).toEqual([])
    expect(sessionFolderMediaFile(result.images[0].imageUrl)).toBe(
      path.join(override, 'chart-1.png'),
    )
  })

  it('numbers a ComfyUI series ascending as the Agent keeps generating', async () => {
    const { id, override } = await sessionWithOverride()
    const target = sessionMediaOf(id, override)

    const first = (await saveGeneratedMediaToWorkspace(
      await generate('AIPG_Image_00001_.png', 'one'),
      override,
      target,
    )) as { savedFiles: string[] }
    const second = (await saveGeneratedMediaToWorkspace(
      await generate('AIPG_Image_00001_.png', 'two'),
      override,
      target,
    )) as { savedFiles: string[] }

    expect(first.savedFiles).toEqual(['AIPG_Image_00001_.png'])
    expect(second.savedFiles).toEqual(['AIPG_Image_00002_.png'])
    expect(await fs.readdir(override)).toEqual(['AIPG_Image_00001_.png', 'AIPG_Image_00002_.png'])
    expect(await fs.readFile(path.join(override, 'AIPG_Image_00002_.png'), 'utf8')).toBe('two')
  })

  it('records the Artifacts in the History as the Agent-owned entry plus a path', async () => {
    const { id, override } = await sessionWithOverride()
    const turn = trackAgentTurnInSession({
      sessionRef: id,
      presetName: 'Reporter',
      workspaceDir: override,
      prompt: 'chart it',
      harnessSessionId: 'aipg-agent-1',
      turnId: 't1',
      taskRun: { taskName: 'Reporter' },
    })

    await saveGeneratedMediaToWorkspace(
      await generate('chart.png', 'chart'),
      override,
      sessionMediaOf(id, override),
    )
    await turn.settle(completed)

    const [entry] = await readHistoryEntries(id)
    expect(entry.artifacts).toEqual([
      { folderId: OVERRIDE_ID, path: 'chart.png', mediaType: 'image' },
    ])
    expect(await missingArtifactUrls(id)).toEqual([])
    expect(await newestArtifact(id, 'image')).toMatchObject({
      url: sessionFolderMediaUrl(id, OVERRIDE_ID, 'chart.png'),
    })
    expect(sessionFolderMediaFile(sessionFolderMediaUrl(id, OVERRIDE_ID, 'chart.png'))).toBe(
      path.join(override, 'chart.png'),
    )
  })

  it('keeps its attachments in the Session’s storage, out of the override folder', async () => {
    const { id, override } = await sessionWithOverride()

    const folder = attachmentsFolderFor({ sessionId: id, workspaceDir: override })

    expect(folder.dir).toBe(sessionFolderPaths(id).attachmentsDir)
  })
})

describe('session_history read by the Assistant after an overriding Agent Run', () => {
  async function recorded(files: Record<string, string>) {
    const session = await sessionWithOverride()
    const turn = trackAgentTurnInSession({
      sessionRef: session.id,
      presetName: 'Reporter',
      workspaceDir: session.override,
      prompt: 'make things',
      harnessSessionId: 'aipg-agent-1',
      turnId: 't1',
    })
    for (const [name, bytes] of Object.entries(files)) {
      await saveGeneratedMediaToWorkspace(
        await generate(name, bytes),
        session.override,
        sessionMediaOf(session.id, session.override),
      )
    }
    await turn.settle(completed)
    return { ...session, entries: await readHistoryEntries(session.id) }
  }

  it('gives the Artifact at its sandbox path when the Assistant mounts the folder', async () => {
    const { id, workspace, override, entries } = await recorded({ 'chart.png': 'chart' })

    const [seen] = await historyAsSeenBy(id, entries, {
      workspaceDir: workspace,
      folders: [{ hostPath: override, path: '/mnt/reports' }],
    })

    expect(seen.artifacts).toEqual([{ path: '/mnt/reports/chart.png', mediaType: 'image' }])
  })

  it('copies small media into the Assistant’s Workspace when it cannot reach it', async () => {
    const { id, workspace, entries } = await recorded({ 'chart.png': 'chart' })

    const [seen] = await historyAsSeenBy(id, entries, { workspaceDir: workspace, folders: [] })

    const [artifact] = seen.artifacts
    if (!('path' in artifact)) throw new Error('not copied')
    expect(artifact.mediaType).toBe('image')
    expect(await fs.readFile(path.join(workspace, artifact.path), 'utf8')).toBe('chart')
  })

  it('marks an Artifact it cannot copy as not accessible', async () => {
    const { id, workspace, entries } = await recorded({ 'ship.glb': 'model' })

    const [seen] = await historyAsSeenBy(id, entries, { workspaceDir: workspace, folders: [] })

    expect(seen.artifacts).toEqual([{ mediaType: 'model3d', notAccessible: true }])
  })
})
