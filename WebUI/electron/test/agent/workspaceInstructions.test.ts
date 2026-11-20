import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }))

const { buildWorkspaceInstructions } = await import('../../agent/piWorkspaceRuntime.ts')

const workspace = {
  hostPath: '/Users/ada/AI-Playground/Sessions/2026-11-20 Poster',
  name: 'poster',
  access: 'read-write' as const,
}
const notes = { hostPath: '/Users/ada/notes', name: 'notes', access: 'read-only' as const }
const drafts = { hostPath: '/Users/ada/drafts', name: 'drafts', access: 'read-write' as const }

const sandboxed = {
  cwd: '/mnt/poster',
  baseUrl: null,
  unsandboxed: false,
  workspace,
  mountedFolders: [notes, drafts],
  attachments: '/attachments',
}

describe("a Session turn's folder instructions", () => {
  it('lists every folder under /mnt, the Workspace first as the working directory', () => {
    const instructions = buildWorkspaceInstructions(sandboxed)

    expect(instructions).toMatch(/\/mnt\/poster .*Workspace.*working directory.*read-write/)
    expect(instructions).toContain('/mnt/notes (read-only)')
    expect(instructions).toContain('/mnt/drafts (read-write)')
    expect(instructions.indexOf('/mnt/poster')).toBeLessThan(instructions.indexOf('/mnt/notes'))
  })

  it('says a bare ls shows only the Workspace and ls /mnt shows every folder', () => {
    const instructions = buildWorkspaceInstructions(sandboxed)

    expect(instructions).toMatch(/`ls \/mnt`/)
    expect(instructions).toMatch(/only the Workspace/i)
  })

  it('allows writes in the Workspace and read-write folders, not only the Workspace', () => {
    const instructions = buildWorkspaceInstructions(sandboxed)

    expect(instructions).not.toMatch(/writes outside the workspace are rejected/i)
    expect(instructions).toMatch(/write in the Workspace and in read-write folders/i)
  })

  it('names the read-only attachments folder', () => {
    expect(buildWorkspaceInstructions(sandboxed)).toMatch(/\/attachments.*read-only/)
  })

  it('keeps the Workspace host path out of the sandboxed prompt', () => {
    expect(buildWorkspaceInstructions(sandboxed)).not.toContain(workspace.hostPath)
  })

  it('lists every folder by its real path under the real shell, with no /mnt', () => {
    const instructions = buildWorkspaceInstructions({
      ...sandboxed,
      cwd: workspace.hostPath,
      workspaceDir: workspace.hostPath,
      unsandboxed: true,
      attachments: '/Users/ada/Library/sessions/s1/attachments',
    })

    expect(instructions).toContain(`${workspace.hostPath} — the Workspace`)
    expect(instructions).toContain('/Users/ada/notes (read-only)')
    expect(instructions).not.toContain('/mnt')
    expect(instructions).toMatch(/do not change files in a read-only folder, from bash either/i)
  })
})
