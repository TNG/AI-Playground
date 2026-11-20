import { describe, expect, it } from 'vitest'
import { workspaceChipOf } from '@/lib/workspaceChip'
import type { SessionFolderList } from '@/types/sessionIpc'

const appFolder = {
  id: 'folder-workspace',
  hostPath: '/docs/AI-Playground/Sessions/2026-11-19 New session',
  access: 'read-write' as const,
  slug: 'files',
  appCreated: true,
}

const papers = {
  id: 'agent-folder-1',
  hostPath: '/Users/me/Papers',
  slug: 'papers',
  access: 'read-only' as const,
}

const folderList: SessionFolderList = {
  workspaceId: 'folder-project',
  folders: [
    appFolder,
    {
      id: 'folder-project',
      hostPath: 'C:\\Users\\me\\Poster',
      access: 'read-write',
      slug: 'poster',
    },
  ],
}

describe('the workspace chip', () => {
  it("names the Session's starred folder and lists every folder, the Workspace first", () => {
    expect(workspaceChipOf({ games: false, folderList })).toEqual({
      name: 'Poster',
      path: 'C:\\Users\\me\\Poster',
      folderId: 'folder-project',
      folders: [
        { id: 'folder-project', name: 'Poster', path: 'C:\\Users\\me\\Poster', workspace: true },
        {
          id: 'folder-workspace',
          name: '2026-11-19 New session',
          path: appFolder.hostPath,
          workspace: false,
        },
      ],
    })
  })

  it('lists only the Workspace when it is the only folder', () => {
    const single = { workspaceId: appFolder.id, folders: [appFolder] }
    expect(workspaceChipOf({ games: false, folderList: single })?.folders).toEqual([
      {
        id: appFolder.id,
        name: '2026-11-19 New session',
        path: appFolder.hostPath,
        workspace: true,
      },
    ])
  })

  it("lists the Session's folders while the picked Agent inherits them", () => {
    const agent = { id: 'agent-1', name: 'Researcher' }

    expect(workspaceChipOf({ games: false, folderList, agent })).toEqual(
      workspaceChipOf({ games: false, folderList }),
    )
  })

  it("lists only the picked Agent's folders after the Workspace when it uses only these", () => {
    const agent = {
      id: 'agent-1',
      name: 'Researcher',
      overrides: { folders: [papers] },
    }

    expect(workspaceChipOf({ games: false, folderList, agent })?.folders).toEqual([
      { id: 'folder-project', name: 'Poster', path: 'C:\\Users\\me\\Poster', workspace: true },
      {
        id: 'agent-1:/Users/me/Papers',
        name: 'Papers',
        path: '/Users/me/Papers',
        workspace: false,
        agentId: 'agent-1',
      },
    ])
  })

  it('lists an Agent folder that is the Workspace once, as its run mounts it', () => {
    const agent = {
      id: 'agent-1',
      name: 'Researcher',
      overrides: { folders: [{ ...papers, hostPath: 'C:\\Users\\me\\poster' }] },
    }

    expect(workspaceChipOf({ games: false, folderList, agent })?.folders).toEqual([
      { id: 'folder-project', name: 'Poster', path: 'C:\\Users\\me\\Poster', workspace: true },
    ])
  })

  it("names the Agent's own Workspace while it always works there, the Session's beside it", () => {
    const agent = {
      id: 'agent-1',
      name: 'Researcher',
      overrides: { workspace: { id: 'w1', hostPath: '/Users/me/Site', slug: 'site' } },
    }

    expect(workspaceChipOf({ games: false, folderList, agent })).toEqual({
      name: 'Site',
      path: '/Users/me/Site',
      folderId: 'agent-1:/Users/me/Site',
      folders: [
        {
          id: 'agent-1:/Users/me/Site',
          name: 'Site',
          path: '/Users/me/Site',
          workspace: true,
          agentId: 'agent-1',
        },
        {
          id: 'folder-workspace',
          name: '2026-11-19 New session',
          path: appFolder.hostPath,
          workspace: false,
        },
        { id: 'folder-project', name: 'Poster', path: 'C:\\Users\\me\\Poster', workspace: false },
      ],
    })
  })

  it('shows nothing under a games preset, whose game bar names its folder', () => {
    expect(workspaceChipOf({ games: true, folderList })).toBeUndefined()
  })

  it('shows nothing while no Session is open', () => {
    expect(workspaceChipOf({ games: false, folderList: undefined })).toBeUndefined()
  })
})
