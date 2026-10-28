import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const script = path.resolve(__dirname, '../../../build/remove-backend-venvs.ps1')
const tempDirs: string[] = []
const children: ChildProcess[] = []

// Every test and the cleanup start or stop PowerShell, which is several seconds cold on a CI runner.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// Long form: a CI runner's os.tmpdir() is an 8.3 path (RUNNER~1), and the script reports long ones.
function tempDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-venvs-')))
  tempDirs.push(dir)
  return dir
}

// The 8.3 alias of a file, or the path itself where the volume does not generate them.
function shortPath(target: string): string {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${target}').ShortPath`,
    ],
    { windowsHide: true, encoding: 'utf8' },
  ).trim()
}

function writeFile(file: string, content = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

// Deep enough to exceed MAX_PATH, the way ComfyUI's site-packages does.
function writeDeepVenv(venv: string): void {
  const deep = path.join(venv, 'Lib', 'site-packages', ...Array(12).fill('nested_package_dir'))
  const file = path.join(deep, 'module.py')
  writeFile(file, 'x = 1')
  expect(file.length).toBeGreaterThan(260)
}

function run(roots: string[]): { exitCode: number; leftovers: string[] } {
  const dir = tempDir()
  const rootsFile = path.join(dir, 'roots.txt')
  const reportFile = path.join(dir, 'report.txt')
  fs.writeFileSync(rootsFile, `\uFEFF${roots.join('\r\n')}`, 'utf16le')
  let exitCode = 0
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-RootsFile',
        rootsFile,
        '-ReportFile',
        reportFile,
      ],
      { windowsHide: true, timeout: 60_000 },
    )
  } catch (error) {
    exitCode = (error as { status: number }).status
  }
  const report = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf16le') : ''
  return { exitCode, leftovers: report.split(/\r?\n/).filter(Boolean) }
}

afterEach(async () => {
  // Their handles must be released before the temp dirs can be removed.
  await Promise.all(
    children.splice(0).map((child) => {
      if (child.exitCode !== null) return
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      return exited
    }),
  )
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

describe.skipIf(process.platform !== 'win32')('remove-backend-venvs.ps1 (uninstaller)', () => {
  it('removes every backend .venv in every root, including paths past MAX_PATH', () => {
    const perUser = path.join(tempDir(), 'resources')
    const shared = path.join(tempDir(), 'Shared Folder', 'resources')
    const venvs = [
      path.join(perUser, 'ComfyUI', '.venv'),
      path.join(perUser, 'service', '.venv'),
      path.join(perUser, 'OpenVINO', '.venv'),
      path.join(shared, 'home-agent', '.venv'),
      path.join(shared, '.venv'),
    ]
    venvs.forEach(writeDeepVenv)
    const readOnly = path.join(perUser, 'service', '.venv', 'Lib', 'locked.pyd')
    writeFile(readOnly)
    fs.chmodSync(readOnly, 0o444)
    const model = path.join(perUser, 'models', 'llm', 'weights.gguf')
    writeFile(model)
    const mainPy = path.join(perUser, 'ComfyUI', 'main.py')
    writeFile(mainPy)

    const result = run([perUser, shared, path.join(tempDir(), 'missing')])

    expect(result).toEqual({ exitCode: 0, leftovers: [] })
    for (const venv of venvs) expect(fs.existsSync(venv)).toBe(false)
    expect(fs.existsSync(model)).toBe(true)
    expect(fs.existsSync(mainPy)).toBe(true)
  })

  it('does not follow a .venv junction out of the install root', () => {
    const root = path.join(tempDir(), 'resources')
    const outside = tempDir()
    const keep = path.join(outside, 'keep.txt')
    writeFile(keep)
    fs.mkdirSync(path.join(root, 'ComfyUI'), { recursive: true })
    fs.symlinkSync(outside, path.join(root, 'ComfyUI', '.venv'), 'junction')

    const result = run([root])

    expect(result.exitCode).toBe(0)
    expect(fs.existsSync(path.join(root, 'ComfyUI', '.venv'))).toBe(false)
    expect(fs.existsSync(keep)).toBe(true)
  })

  it('ignores a root that is itself a link', () => {
    const target = path.join(tempDir(), 'resources')
    writeDeepVenv(path.join(target, 'service', '.venv'))
    const link = path.join(tempDir(), 'linked')
    fs.symlinkSync(target, link, 'junction')

    expect(run([link])).toEqual({ exitCode: 0, leftovers: [] })
    expect(fs.existsSync(path.join(target, 'service', '.venv'))).toBe(true)
  })

  it('stops a process running from the venv before deleting it', async () => {
    const root = path.join(tempDir(), 'resources')
    const exe = path.join(root, 'service', '.venv', 'Scripts', 'python.exe')
    fs.mkdirSync(path.dirname(exe), { recursive: true })
    fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'ping.exe'), exe)
    // Started through its 8.3 alias, a process reports that path rather than the long one.
    const child = spawn(shortPath(exe), ['-n', '60', '127.0.0.1'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    children.push(child)
    await new Promise((resolve) => child.once('spawn', resolve))

    expect(run([root])).toEqual({ exitCode: 0, leftovers: [] })
    expect(fs.existsSync(path.join(root, 'service', '.venv'))).toBe(false)
  })

  it('reports a venv it cannot remove, with the reason', async () => {
    const root = path.join(tempDir(), 'resources')
    const venv = path.join(root, 'ComfyUI', '.venv')
    const locked = path.join(venv, 'Lib', 'held-open.dll')
    writeFile(locked)
    // Node opens files with FILE_SHARE_DELETE, so the lock comes from another process holding
    // the file with FileShare.None, like a backend another account left running.
    const holder = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$f = [IO.File]::Open('${locked}', 'Open', 'Read', 'None'); 'locked'; Start-Sleep 60`,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    children.push(holder)
    await new Promise((resolve) => holder.stdout?.once('data', resolve))

    const result = run([root])

    expect(result.exitCode).toBe(1)
    expect(result.leftovers).toHaveLength(1)
    // The reason is the localized Windows message, which names the locked file.
    expect(result.leftovers[0].startsWith(`${venv}: `)).toBe(true)
    expect(result.leftovers[0]).toContain('held-open.dll')
  })
})
