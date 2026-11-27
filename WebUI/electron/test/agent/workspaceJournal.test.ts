import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import {
  beginTurnJournal,
  deleteSessionJournals,
  deleteTurnJournal,
  endTurnJournal,
  journalRootsOf,
  recordJournalMedia,
  recordWorkspaceWrite,
  resetWorkspaceJournalsForTest,
  restoreTurnJournal,
  setJournalBackupCapForTest,
  turnJournalHostShell,
} from '../../agent/workspaceJournal'
import { createAgentToolAccess, SANDBOX_WORKDIR } from '../../agent/piToolOperations'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => os.tmpdir()) },
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
    }),
  },
  shell: {
    // The journal's media trash goes through Electron; the test deletes for real
    // so a restored turn's copies can be asserted gone from disk.
    trashItem: vi.fn(async (target: string) => {
      fs.rmSync(target, { force: true })
    }),
  },
}))

// The workspace journal (electron/agent/workspaceJournal.ts) gives every agent
// turn a copy-on-write diary of its workspace writes so a later delete or
// regenerate can put the workspace back as the turn found it. These tests drive
// the journal directly — record, restore, restart persistence — and then once
// through the real tool access, the way a turn actually writes.

let root: string
let workspace: string

const SESSION = 'aipg-agent-journal-test'
const TURN = 'turn-1'

beforeEach(() => {
  resetWorkspaceJournalsForTest()
  setJournalBackupCapForTest(64 * 1024 * 1024)
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-journal-')))
  workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace)
  // The journal lives under userData: a fresh one per test keeps manifests of
  // earlier runs out of this run's restores.
  vi.mocked(app.getPath).mockReturnValue(path.join(root, 'app-data'))
})

afterEach(() => {
  deleteSessionJournals(SESSION)
  resetWorkspaceJournalsForTest()
  fs.rmSync(root, { recursive: true, force: true })
})

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true })
  fs.writeFileSync(path.join(workspace, file), content)
}

function read(file: string): string {
  return fs.readFileSync(path.join(workspace, file), 'utf-8')
}

function exists(file: string): boolean {
  return fs.existsSync(path.join(workspace, file))
}

function beginTurn(options: Partial<Parameters<typeof beginTurnJournal>[0]> = {}): void {
  beginTurnJournal({
    sessionId: SESSION,
    turnId: TURN,
    workspaceDir: workspace,
    ...options,
  })
}

/** The write of one file, the way a turn seam does it: record, then mutate. */
function journaledWrite(file: string, content: string): void {
  recordWorkspaceWrite(SESSION, path.join(workspace, file))
  write(file, content)
}

type ExecutableTool = {
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>
}

function findTool(
  access: Awaited<ReturnType<typeof createAgentToolAccess>>,
  name: string,
): ExecutableTool {
  const tool = access.definitions.find((definition) => definition.name === name)
  if (!tool) throw new Error(`${name} tool missing`)
  return tool as unknown as ExecutableTool
}

function invoke(tool: ExecutableTool, params: unknown) {
  return tool.execute('call-1', params, undefined, undefined, undefined as never)
}

describe('a turn journal', () => {
  it('restores a modified file to its pre-turn bytes and mode', async () => {
    write('game.js', 'const original = 1\n')
    fs.chmodSync(path.join(workspace, 'game.js'), 0o644)
    beginTurn()
    journaledWrite('game.js', 'const overwritten = 2\n')
    expect(read('game.js')).toBe('const overwritten = 2\n')
    endTurnJournal(SESSION)

    const report = await restoreTurnJournal(SESSION, TURN)
    expect(report).toBeDefined()
    expect(read('game.js')).toBe('const original = 1\n')
    expect(report?.restored).toBeGreaterThan(0)
  })

  it('deletes what the turn created, including created folders', async () => {
    beginTurn()
    journaledWrite(path.join('level', 'one', 'deep.txt'), 'new')
    recordWorkspaceWrite(SESSION, path.join(workspace, 'art'))
    fs.mkdirSync(path.join(workspace, 'art'))
    endTurnJournal(SESSION)

    expect(exists(path.join('level', 'one', 'deep.txt'))).toBe(true)
    expect(exists('art')).toBe(true)
    await restoreTurnJournal(SESSION, TURN)
    expect(exists(path.join('level', 'one', 'deep.txt'))).toBe(false)
    expect(exists('level')).toBe(false)
    expect(exists('art')).toBe(false)
  })

  it('re-creates a file the turn deleted', async () => {
    write('todo.md', 'was here\n')
    beginTurn()
    recordWorkspaceWrite(SESSION, path.join(workspace, 'todo.md'))
    fs.rmSync(path.join(workspace, 'todo.md'))
    endTurnJournal(SESSION)

    await restoreTurnJournal(SESSION, TURN)
    expect(read('todo.md')).toBe('was here\n')
  })

  it('restores a folder a recursive delete took away, contents included', async () => {
    fs.mkdirSync(path.join(workspace, 'assets'))
    write('assets/sprite.png', 'png bytes')
    write('assets/readme.txt', 'about the sprites')
    beginTurn()
    recordWorkspaceWrite(SESSION, path.join(workspace, 'assets'))
    fs.rmSync(path.join(workspace, 'assets'), { recursive: true })
    endTurnJournal(SESSION)

    await restoreTurnJournal(SESSION, TURN)
    expect(read(path.join('assets', 'sprite.png'))).toBe('png bytes')
    expect(read(path.join('assets', 'readme.txt'))).toBe('about the sprites')
  })

  it('undoes a move: the source comes back, the destination goes', async () => {
    write('old-name.js', 'the code')
    beginTurn()
    const source = path.join(workspace, 'old-name.js')
    const target = path.join(workspace, 'new-name.js')
    recordWorkspaceWrite(SESSION, source)
    recordWorkspaceWrite(SESSION, target)
    fs.renameSync(source, target)
    endTurnJournal(SESSION)

    await restoreTurnJournal(SESSION, TURN)
    expect(read('old-name.js')).toBe('the code')
    expect(exists('new-name.js')).toBe(false)
  })

  it('composes: rolling back the newest turn restores its predecessor, then that one', async () => {
    write('design.md', 'v1')
    beginTurn()
    journaledWrite('design.md', 'v2')
    endTurnJournal(SESSION)

    beginTurn({ turnId: 'turn-2' })
    journaledWrite('design.md', 'v3')
    endTurnJournal(SESSION)
    expect(read('design.md')).toBe('v3')

    await restoreTurnJournal(SESSION, 'turn-2')
    expect(read('design.md')).toBe('v2')
    await restoreTurnJournal(SESSION, TURN)
    expect(read('design.md')).toBe('v1')
  })

  it('survives a restart: the manifest is read back from disk', async () => {
    write('game.js', 'original')
    beginTurn()
    journaledWrite('game.js', 'changed')
    endTurnJournal(SESSION)
    // A fresh process has no live journals — only what was persisted.
    resetWorkspaceJournalsForTest()

    await restoreTurnJournal(SESSION, TURN)
    expect(read('game.js')).toBe('original')
  })

  it('restores nothing for a turn that never had a journal', async () => {
    write('untouched.js', 'as it was')
    beginTurn()
    endTurnJournal(SESSION)
    expect(await restoreTurnJournal(SESSION, TURN)).toBeUndefined()

    expect(await restoreTurnJournal(SESSION, 'never-ran')).toBeUndefined()
    expect(read('untouched.js')).toBe('as it was')
  })

  it('notes a file too large to back up instead of pretending it can restore it', async () => {
    setJournalBackupCapForTest(4)
    write('huge.bin', 'way more than four bytes')
    beginTurn()
    journaledWrite('huge.bin', 'overwritten')
    endTurnJournal(SESSION)

    const report = await restoreTurnJournal(SESSION, TURN)
    expect(report?.unrestorable).toEqual([path.join(workspace, 'huge.bin')])
    expect(read('huge.bin')).toBe('overwritten')
  })

  it("records nothing outside the turn's writable roots", async () => {
    const outside = path.join(root, 'elsewhere.txt')
    fs.writeFileSync(outside, 'not the journal business')
    beginTurn()
    recordWorkspaceWrite(SESSION, outside)
    endTurnJournal(SESSION)

    expect(await restoreTurnJournal(SESSION, TURN)).toBeUndefined()
    expect(fs.readFileSync(outside, 'utf-8')).toBe('not the journal business')
  })

  it('restores a re-pointed symlink', async () => {
    fs.symlinkSync('game.js', path.join(workspace, 'link.js'))
    beginTurn()
    const link = path.join(workspace, 'link.js')
    recordWorkspaceWrite(SESSION, link)
    fs.rmSync(link)
    fs.symlinkSync('other.js', link)
    endTurnJournal(SESSION)

    await restoreTurnJournal(SESSION, TURN)
    expect(fs.readlinkSync(link)).toBe('game.js')
  })

  it('is dropped with its turn, and a session drop takes every turn of it', async () => {
    beginTurn()
    journaledWrite('one.js', 'one')
    endTurnJournal(SESSION)
    beginTurn({ turnId: 'turn-2' })
    journaledWrite('two.js', 'two')
    endTurnJournal(SESSION)

    deleteTurnJournal(SESSION, TURN)
    expect(await restoreTurnJournal(SESSION, TURN)).toBeUndefined()
    expect(await restoreTurnJournal(SESSION, 'turn-2')).toBeDefined()

    deleteSessionJournals(SESSION)
    expect(await restoreTurnJournal(SESSION, 'turn-2')).toBeUndefined()
  })

  it('keeps read-write mounted folders as roots and leaves read-only ones out', () => {
    const writable = path.join(root, 'writable-mount')
    const readOnly = path.join(root, 'read-only-mount')
    fs.mkdirSync(writable)
    fs.mkdirSync(readOnly)
    const roots = journalRootsOf(workspace, [
      { hostPath: writable, name: 'w', access: 'read-write' },
      { hostPath: readOnly, name: 'r', access: 'read-only' },
    ])
    expect(roots).toEqual(expect.arrayContaining([workspace, writable]))
    expect(roots).not.toContain(readOnly)
  })

  it('trashes the apart media copies a turn saved, and counts them', async () => {
    const apartDir = path.join(root, 'session-files')
    fs.mkdirSync(apartDir)
    const apartCopy = path.join(apartDir, 'cover.png')
    fs.writeFileSync(apartCopy, 'the session copy')
    beginTurn()
    recordJournalMedia(SESSION, [apartCopy])
    endTurnJournal(SESSION)

    const report = await restoreTurnJournal(SESSION, TURN)
    expect(report?.trashedMedia).toBe(1)
    expect(report?.unrestorable).toEqual([])
    expect(fs.existsSync(apartCopy)).toBe(false)
  })

  it('notes an apart media copy once, and never one inside the roots', async () => {
    const apartDir = path.join(root, 'session-files')
    fs.mkdirSync(apartDir)
    const apartCopy = path.join(apartDir, 'cover.png')
    const inside = path.join(workspace, 'generated', 'cover.png')
    fs.writeFileSync(apartCopy, 'the session copy')
    beginTurn()
    for (let seen = 0; seen < 3; seen++) recordJournalMedia(SESSION, [apartCopy])
    recordJournalMedia(SESSION, [inside])
    recordJournalMedia(SESSION, [])
    endTurnJournal(SESSION)

    const report = await restoreTurnJournal(SESSION, TURN)
    expect(report?.trashedMedia).toBe(1)
  })

  it('reports a media copy the Trash refused as unrestorable', async () => {
    const { shell } = await import('electron')
    const apartCopy = path.join(root, 'session-files', 'cover.png')
    fs.mkdirSync(path.dirname(apartCopy))
    fs.writeFileSync(apartCopy, 'the session copy')
    beginTurn()
    recordJournalMedia(SESSION, [apartCopy])
    endTurnJournal(SESSION)
    vi.mocked(shell.trashItem).mockRejectedValueOnce(new Error('trash is full'))

    const report = await restoreTurnJournal(SESSION, TURN)
    expect(report?.trashedMedia).toBe(0)
    expect(report?.unrestorable).toEqual([apartCopy])
    expect(fs.existsSync(apartCopy)).toBe(true)
    vi.mocked(shell.trashItem).mockClear()
  })

  it('tells a host-shell turn from a sandboxed one, and a journal-less turn apart', async () => {
    beginTurn({ unsandboxed: true })
    journaledWrite('one.js', 'one')
    endTurnJournal(SESSION)
    beginTurn({ turnId: 'turn-2' })
    journaledWrite('two.js', 'two')
    endTurnJournal(SESSION)

    expect(turnJournalHostShell(SESSION, TURN)).toBe(true)
    expect(turnJournalHostShell(SESSION, 'turn-2')).toBe(false)
    expect(turnJournalHostShell(SESSION, 'never-ran')).toBe(false)
  })

  it('keeps a host-shell turn refused even when it wrote nothing', async () => {
    beginTurn({ unsandboxed: true, turnId: 'host-shell-empty' })
    endTurnJournal(SESSION)
    beginTurn({ turnId: 'sandboxed-empty' })
    endTurnJournal(SESSION)

    expect(turnJournalHostShell(SESSION, 'host-shell-empty')).toBe(true)
    await expect(restoreTurnJournal(SESSION, 'host-shell-empty')).resolves.toMatchObject({
      removedCreated: 0,
      restored: 0,
      trashedMedia: 0,
    })
    await expect(restoreTurnJournal(SESSION, 'sandboxed-empty')).resolves.toBeUndefined()
  })
})

describe('the sandbox writes a turn actually makes', () => {
  it('is recorded through the write tool, the edit tool and the shell', async () => {
    const access = await createAgentToolAccess({
      workspaceDir: workspace,
      unsandboxed: false,
      sessionId: SESSION,
      skillsDir: path.join(root, 'skills'),
      skills: [],
    })
    try {
      write('game.js', 'const scaffold = true\n')
      write('gone.txt', 'delete me\n')
      beginTurn()
      await invoke(findTool(access, 'write'), {
        path: `${SANDBOX_WORKDIR}/game.js`,
        content: 'const rebuilt = 2\n',
      })
      await invoke(findTool(access, 'bash'), {
        command: 'rm gone.txt && mkdir -p fresh/dir && echo hi > fresh/dir/new.txt',
      })
      expect(read('game.js')).toBe('const rebuilt = 2\n')
      expect(exists('gone.txt')).toBe(false)
      endTurnJournal(SESSION)

      await restoreTurnJournal(SESSION, TURN)
      expect(read('game.js')).toBe('const scaffold = true\n')
      expect(read('gone.txt')).toBe('delete me\n')
      expect(exists('fresh')).toBe(false)
    } finally {
      await access.dispose()
    }
  })

  it('is recorded through the host-shell write tool too', async () => {
    const access = await createAgentToolAccess({
      workspaceDir: workspace,
      unsandboxed: true,
      sessionId: SESSION,
      skillsDir: path.join(root, 'skills'),
      skills: [],
    })
    try {
      write('game.js', 'host original')
      beginTurn()
      await invoke(findTool(access, 'write'), {
        path: path.join(workspace, 'game.js'),
        content: 'host rewritten',
      })
      endTurnJournal(SESSION)

      await restoreTurnJournal(SESSION, TURN)
      expect(read('game.js')).toBe('host original')
    } finally {
      await access.dispose()
    }
  })
})
