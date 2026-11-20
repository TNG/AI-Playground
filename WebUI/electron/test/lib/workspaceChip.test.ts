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

  it("lists a picked Agent's own folders after the Workspace, as its run sees them", () => {
    const agent = {
      id: 'agent-1',
      name: 'Researcher',
      folders: [{ hostPath: '/Users/me/Papers', access: 'read-only' as const }],
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

  it('lists an Agent folder that is the Workspace once, as the Workspace, as its run mounts it', () => {
    const agent = {
      id: 'agent-1',
      name: 'Researcher',
      folders: [{ hostPath: 'C:\\Users\\me\\poster', access: 'read-only' as const }],
    }

    expect(workspaceChipOf({ games: false, folderList, agent })?.folders).toEqual([
      { id: 'folder-project', name: 'Poster', path: 'C:\\Users\\me\\Poster', workspace: true },
    ])
  })

  it('shows nothing under a games preset, whose game bar names its folder', () => {
    expect(workspaceChipOf({ games: true, folderList })).toBeUndefined()
  })

  it('shows nothing while no Session is open', () => {
    expect(workspaceChipOf({ games: false, folderList: undefined })).toBeUndefined()
  })
})
