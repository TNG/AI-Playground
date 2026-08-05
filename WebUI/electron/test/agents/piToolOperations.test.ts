import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SANDBOX_SKILLS_DIR,
  SANDBOX_WORKDIR,
  createAgentToolAccess,
  testables,
  type AgentToolAccess,
} from '../../agentMode/piToolOperations'
import type { AgentSkill } from '../../agentMode/piCustomTools'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }))

// Containment tests for Agent Mode's file/shell access. The whole security
// story of Agent Mode is "the agent can only touch the workspace folder the
// user picked", enforced two different ways: by construction in sandboxed mode
// (the virtual filesystem only mounts the workspace) and by explicit path
// checks in host-shell mode. Both are exercised here against a real temp
// workspace and a real sibling folder that must stay untouched.

let workspace: string
let outsideDir: string
let outsideFile: string
let hostSkillsDir: string

beforeEach(() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-agent-tools-')))
  workspace = path.join(root, 'workspace')
  outsideDir = path.join(root, 'outside')
  hostSkillsDir = path.join(root, 'skills')
  fs.mkdirSync(workspace)
  fs.mkdirSync(outsideDir)
  fs.mkdirSync(path.join(hostSkillsDir, 'browser-debugging'), { recursive: true })
  fs.writeFileSync(path.join(hostSkillsDir, 'browser-debugging/SKILL.md'), SKILL.content)
  outsideFile = path.join(outsideDir, 'secret.txt')
  fs.writeFileSync(outsideFile, 'top secret')
})

afterEach(() => {
  fs.rmSync(path.dirname(workspace), { recursive: true, force: true })
})

function toolOf(access: AgentToolAccess, name: string): ToolDefinition {
  const tool = access.definitions.find((definition) => definition.name === name)
  if (!tool) throw new Error(`tool '${name}' is not defined`)
  return tool
}

const SKILL: AgentSkill = {
  name: 'browser-debugging',
  description: 'Debug a page in the workspace.',
  relativePath: 'browser-debugging/SKILL.md',
  content: '---\nname: browser-debugging\n---\n\nOpen the page, read the console.\n',
}

function accessOptions(unsandboxed: boolean) {
  return { workspaceDir: workspace, unsandboxed, skillsDir: hostSkillsDir, skills: [SKILL] }
}

/** Invoke a Pi tool the way the agent would, minus the extension context. */
function invoke(tool: ToolDefinition, params: unknown): Promise<unknown> {
  return tool.execute('call-1', params as never, undefined, undefined, undefined as never)
}

function resultText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')
}

describe('sandboxed access', () => {
  let access: AgentToolAccess

  beforeEach(async () => {
    access = await createAgentToolAccess(accessOptions(false))
  })

  afterEach(async () => {
    await access.dispose()
  })

  it('exposes the workspace at the sandbox mount point, not the host path', () => {
    expect(access.cwd).toBe(SANDBOX_WORKDIR)
  })

  it('writes and reads real files inside the workspace', async () => {
    await invoke(toolOf(access, 'write'), {
      path: `${SANDBOX_WORKDIR}/notes/todo.md`,
      content: '# todo\n',
    })

    expect(fs.readFileSync(path.join(workspace, 'notes/todo.md'), 'utf8')).toBe('# todo\n')
    const read = await invoke(toolOf(access, 'read'), { path: `${SANDBOX_WORKDIR}/notes/todo.md` })
    expect(resultText(read)).toContain('# todo')
  })

  it('cannot write outside the mounted workspace', async () => {
    await expect(
      invoke(toolOf(access, 'write'), { path: outsideFile, content: 'overwritten' }),
    ).rejects.toThrow(/outside the workspace/)

    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('top secret')
  })

  it('cannot escape the workspace with a relative path', async () => {
    await expect(
      invoke(toolOf(access, 'write'), { path: '../escaped.txt', content: 'nope' }),
    ).rejects.toThrow(/outside the workspace/)

    expect(fs.existsSync(path.join(path.dirname(workspace), 'escaped.txt'))).toBe(false)
  })

  it('cannot edit outside the mounted workspace', async () => {
    await expect(
      invoke(toolOf(access, 'edit'), {
        path: outsideFile,
        edits: [{ oldText: 'top secret', newText: 'leaked' }],
      }),
    ).rejects.toThrow()

    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('top secret')
  })

  it('cannot read host files that are not mounted', async () => {
    await expect(invoke(toolOf(access, 'read'), { path: outsideFile })).rejects.toThrow()
  })

  it('runs shell commands against the mounted workspace only', async () => {
    fs.writeFileSync(path.join(workspace, 'hello.txt'), 'from the workspace')

    const inside = await invoke(toolOf(access, 'bash'), { command: 'cat hello.txt' })
    expect(resultText(inside)).toContain('from the workspace')

    // The emulated shell has no host filesystem behind it, so this cannot leak
    // the file even though the process running the test can read it.
    await expect(invoke(toolOf(access, 'bash'), { command: `cat ${outsideFile}` })).rejects.toThrow(
      /No such file or directory/,
    )
  })

  it('runs python inside the sandbox', async () => {
    const result = await invoke(toolOf(access, 'bash'), {
      command: 'python3 -c "print(6 * 7)"',
    })

    expect(resultText(result)).toContain('42')
  })

  it('lists workspace entries through the virtual filesystem', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'a')
    fs.mkdirSync(path.join(workspace, 'src'))

    const result = await invoke(toolOf(access, 'ls'), { path: SANDBOX_WORKDIR })
    const text = resultText(result)
    expect(text).toContain('a.txt')
    expect(text).toContain('src')
  })

  it('finds files by glob', async () => {
    fs.mkdirSync(path.join(workspace, 'src'))
    fs.writeFileSync(path.join(workspace, 'src/app.ts'), 'export const answer = 42\n')

    const found = await invoke(toolOf(access, 'find'), { pattern: '**/*.ts' })
    expect(resultText(found)).toContain('app.ts')
  })

  it('greps the virtual filesystem instead of the host', async () => {
    fs.mkdirSync(path.join(workspace, 'src'))
    fs.writeFileSync(path.join(workspace, 'src/app.ts'), 'export const answer = 42\n')
    fs.writeFileSync(path.join(workspace, 'src/other.md'), 'answer elsewhere\n')

    const result = await invoke(toolOf(access, 'grep'), { pattern: 'answer' })
    const text = resultText(result)
    expect(text).toContain('src/app.ts:1:export const answer = 42')
    expect(text).toContain('src/other.md:1:answer elsewhere')
  })

  it('limits grep to matching files and reports no matches honestly', async () => {
    fs.writeFileSync(path.join(workspace, 'app.ts'), 'const answer = 42\n')
    fs.writeFileSync(path.join(workspace, 'notes.md'), 'answer\n')

    const globbed = await invoke(toolOf(access, 'grep'), { pattern: 'answer', glob: '*.ts' })
    expect(resultText(globbed)).toContain('app.ts')
    expect(resultText(globbed)).not.toContain('notes.md')

    const missing = await invoke(toolOf(access, 'grep'), { pattern: 'nothing here' })
    expect(resultText(missing)).toBe('No matches found.')
  })

  it('refuses to grep outside the workspace', async () => {
    await expect(
      invoke(toolOf(access, 'grep'), { pattern: 'secret', path: outsideDir }),
    ).rejects.toThrow(/outside the workspace/)
  })

  // Pi announces a skill by telling the model to read its file, so an
  // unreadable skill is a silently useless one.
  it('lets the model read the skills it is told about', async () => {
    expect(access.skillsRoot).toBe(SANDBOX_SKILLS_DIR)

    const result = await invoke(toolOf(access, 'read'), {
      path: `${SANDBOX_SKILLS_DIR}/${SKILL.relativePath}`,
    })

    expect(resultText(result)).toContain('Open the page, read the console.')
  })
})

describe('host-shell access', () => {
  let access: AgentToolAccess

  beforeEach(async () => {
    access = await createAgentToolAccess(accessOptions(true))
  })

  afterEach(async () => {
    await access.dispose()
  })

  it('runs Pi against the real workspace folder', () => {
    expect(access.cwd).toBe(workspace)
  })

  it('writes real files inside the workspace', async () => {
    await invoke(toolOf(access, 'write'), { path: 'build/out.txt', content: 'built' })

    expect(fs.readFileSync(path.join(workspace, 'build/out.txt'), 'utf8')).toBe('built')
  })

  it('refuses to write outside the workspace', async () => {
    await expect(
      invoke(toolOf(access, 'write'), { path: outsideFile, content: 'overwritten' }),
    ).rejects.toThrow(/outside the workspace folder/)

    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('top secret')
  })

  it('refuses to edit outside the workspace', async () => {
    await expect(
      invoke(toolOf(access, 'edit'), {
        path: outsideFile,
        edits: [{ oldText: 'top secret', newText: 'leaked' }],
      }),
    ).rejects.toThrow(/outside the workspace/)

    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('top secret')
  })

  it('points the model at the real skill files', async () => {
    expect(access.skillsRoot).toBe(hostSkillsDir)

    const result = await invoke(toolOf(access, 'read'), {
      path: path.join(hostSkillsDir, SKILL.relativePath),
    })

    expect(resultText(result)).toContain('Open the page, read the console.')
  })

  it('edits files inside the workspace', async () => {
    fs.writeFileSync(path.join(workspace, 'app.ts'), 'const answer = 41\n')

    await invoke(toolOf(access, 'edit'), {
      path: 'app.ts',
      edits: [{ oldText: '41', newText: '42' }],
    })

    expect(fs.readFileSync(path.join(workspace, 'app.ts'), 'utf8')).toBe('const answer = 42\n')
  })
})

describe('containment helpers', () => {
  it('accepts the root itself and paths below it', () => {
    expect(testables.containedIn('/work', '/work')).toBe(true)
    expect(testables.containedIn('/work', '/work/src/app.ts')).toBe(true)
  })

  it('rejects siblings, parents and prefix look-alikes', () => {
    expect(testables.containedIn('/work', '/work-other/app.ts')).toBe(false)
    expect(testables.containedIn('/work', '/')).toBe(false)
    expect(testables.containedIn('/work', '/etc/passwd')).toBe(false)
  })

  it('explains which action was refused', () => {
    expect(() => testables.assertContained('/work', '/etc/passwd', 'write')).toThrow(
      /Refusing to write outside the workspace folder/,
    )
  })

  it('translates globs so ** spans directories and * does not', () => {
    expect(testables.globToRegExp('**/*.ts').test('src/deep/app.ts')).toBe(true)
    // `**/` also matches zero directories.
    expect(testables.globToRegExp('**/*.ts').test('app.ts')).toBe(true)
    expect(testables.globToRegExp('*.ts').test('src/app.ts')).toBe(false)
    expect(testables.globToRegExp('src/?.ts').test('src/a.ts')).toBe(true)
    expect(testables.globToRegExp('src/?.ts').test('src/ab.ts')).toBe(false)
    // Dots are literal, not "any character".
    expect(testables.globToRegExp('*.ts').test('appXts')).toBe(false)
  })
})
