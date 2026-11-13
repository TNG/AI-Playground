import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// aipgRoot caches the shared-mode decision and the "seeded" flag at module scope,
// so each scenario loads a fresh module instance with its own electron /
// installConfig mocks via vi.resetModules() + dynamic import.
//
// All of %PUBLIC%, %LOCALAPPDATA% and process.resourcesPath are pointed at
// temp dirs so that shared mode — which seeds the shared root — never touches a
// real machine-wide location.

const origPlatform = process.platform
const origResourcesPath = (process as { resourcesPath?: string }).resourcesPath
const origPublic = process.env.PUBLIC
const origLocalAppData = process.env.LOCALAPPDATA

let tmpBase = ''
let tmpResources = ''
let tmpPublic = ''
let tmpLocalAppData = ''

function setProp(obj: object, key: string, value: unknown) {
  Object.defineProperty(obj, key, { value, configurable: true })
}

async function loadAipgRoot(opts: {
  isPackaged: boolean
  mode: 'shared' | 'per-user' | null
  platform: NodeJS.Platform
  sharedResourcesDir?: string
  installDir?: string | null
  build?: { commit?: string; tag?: string }
}) {
  vi.resetModules()
  vi.stubEnv('VITE_GIT_COMMIT', opts.build?.commit ?? 'testbuild')
  vi.stubEnv('VITE_GIT_TAG', opts.build?.tag ?? '')
  setProp(process, 'platform', opts.platform)
  vi.doMock('electron', () => ({
    app: { isPackaged: opts.isPackaged, getVersion: () => '0.0.0-test' },
  }))
  vi.doMock('../../kernel/installConfig.ts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../kernel/installConfig.ts')>()),
    readInstallConfig: () => {
      if (!opts.mode) return null
      const sharedResourcesDir =
        opts.sharedResourcesDir !== undefined
          ? opts.sharedResourcesDir
          : opts.mode === 'shared'
            ? path.join(tmpPublic, 'AI Playground')
            : undefined
      const installDir =
        opts.installDir === null ? undefined : (opts.installDir ?? path.dirname(tmpResources))
      return { modelFolderMode: opts.mode, sharedResourcesDir, installDir }
    },
  }))
  return import('../../kernel/aipgRoot.ts')
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `aipg-root-${process.pid}-`))
  tmpResources = path.join(tmpBase, 'bundle')
  tmpPublic = path.join(tmpBase, 'Public')
  tmpLocalAppData = path.join(tmpBase, 'LocalAppData')
  fs.mkdirSync(tmpResources, { recursive: true })
  setProp(process, 'resourcesPath', tmpResources)
  process.env.PUBLIC = tmpPublic
  process.env.LOCALAPPDATA = tmpLocalAppData
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('electron')
  vi.doUnmock('../../kernel/installConfig.ts')
  vi.doUnmock('../../kernel/sharedAcl.ts')
  vi.resetModules()
  vi.unstubAllEnvs()
  setProp(process, 'platform', origPlatform)
  setProp(process, 'resourcesPath', origResourcesPath)
  process.env.PUBLIC = origPublic
  process.env.LOCALAPPDATA = origLocalAppData
  fs.rmSync(tmpBase, { recursive: true, force: true })
})

describe('writableConfigRoot', () => {
  it('is a private per-user config dir in a shared all-users install', async () => {
    const mod = await loadAipgRoot({ isPackaged: true, mode: 'shared', platform: 'win32' })

    expect(mod.writableConfigRoot()).toBe(path.join(tmpLocalAppData, 'ai-playground', 'config'))
    // The shared branch resolves without hitting packagedResourcesRoot(), so the
    // two roots are distinct — that separation is the whole point of the feature.
    expect(mod.writableConfigRoot()).not.toBe(mod.packagedResourcesRoot())
  })

  it('equals the resources root for an all-users install without sharing', async () => {
    const mod = await loadAipgRoot({ isPackaged: true, mode: 'per-user', platform: 'win32' })

    expect(mod.writableConfigRoot()).toBe(mod.packagedResourcesRoot())
  })

  it('ignores a "shared" config on non-Windows (guarded by platform)', async () => {
    const mod = await loadAipgRoot({ isPackaged: true, mode: 'shared', platform: 'linux' })

    // Not win32 -> shared mode inactive -> config root equals the resources root.
    expect(mod.writableConfigRoot()).toBe(mod.packagedResourcesRoot())
  })

  it('equals the resources root in dev (unpackaged)', async () => {
    const mod = await loadAipgRoot({ isPackaged: false, mode: null, platform: 'win32' })

    expect(mod.writableConfigRoot()).toBe(mod.packagedResourcesRoot())
  })
})

describe('packagedResourcesRoot', () => {
  it('points at the machine-wide shared resources root in shared mode', async () => {
    const mod = await loadAipgRoot({ isPackaged: true, mode: 'shared', platform: 'win32' })

    expect(mod.packagedResourcesRoot()).toBe(path.join(tmpPublic, 'AI Playground', 'resources'))
  })

  it('does not copy a bundled .venv or python-interpreter into the shared root', async () => {
    fs.mkdirSync(path.join(tmpResources, '.venv'), { recursive: true })
    fs.writeFileSync(path.join(tmpResources, '.venv', 'pyvenv.cfg'), 'home = leftover')
    fs.mkdirSync(path.join(tmpResources, 'python-interpreter'), { recursive: true })
    fs.writeFileSync(path.join(tmpResources, 'python-interpreter', 'python.exe'), '')
    fs.writeFileSync(path.join(tmpResources, 'uv.exe'), '')
    const mod = await loadAipgRoot({ isPackaged: true, mode: 'shared', platform: 'win32' })

    const root = mod.packagedResourcesRoot()
    expect(fs.existsSync(path.join(root, 'uv.exe'))).toBe(true)
    expect(fs.existsSync(path.join(root, '.venv'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'python-interpreter'))).toBe(false)
  })

  it('honors an admin-chosen shared resources base dir, appending the resources leaf', async () => {
    const customBase = path.join(tmpBase, 'CustomShared')
    const mod = await loadAipgRoot({
      isPackaged: true,
      mode: 'shared',
      platform: 'win32',
      sharedResourcesDir: customBase,
    })

    // The `resources` leaf is always appended so model_config's relative
    // `./resources/models` paths (anchored to path.dirname(root)) still resolve.
    expect(mod.packagedResourcesRoot()).toBe(path.join(customBase, 'resources'))
  })

  it('does not fall back to %PUBLIC% when shared mode has no resources dir', async () => {
    const mod = await loadAipgRoot({
      isPackaged: true,
      mode: 'shared',
      platform: 'win32',
      sharedResourcesDir: '',
    })

    expect(mod.packagedResourcesRoot()).toBe(
      path.join(tmpLocalAppData, 'ai-playground', 'resources'),
    )
  })

  it('ignores a shared config left by another install (per-user install after all-users)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mod = await loadAipgRoot({
      isPackaged: true,
      mode: 'shared',
      platform: 'win32',
      installDir: 'C:\\Program Files\\AI Playground',
    })

    expect(mod.isSharedAllUsersInstall()).toBe(false)
    expect(mod.packagedResourcesRoot()).toBe(tmpResources)
    expect(mod.writableConfigRoot()).toBe(tmpResources)
    expect(fs.existsSync(path.join(tmpPublic, 'AI Playground'))).toBe(false)
  })

  it('ignores a legacy shared config without installDir when the install dir is writable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mod = await loadAipgRoot({
      isPackaged: true,
      mode: 'shared',
      platform: 'win32',
      installDir: null,
    })

    expect(mod.isSharedAllUsersInstall()).toBe(false)
    expect(mod.packagedResourcesRoot()).toBe(tmpResources)
  })

  it('replaces a pre-seeded uv.exe when the seed marker matches', async () => {
    fs.writeFileSync(path.join(tmpResources, 'uv.exe'), 'from-bundle')
    fs.writeFileSync(path.join(tmpResources, 'notes.txt'), 'shipped-note')
    const sharedRoot = path.join(tmpPublic, 'AI Playground', 'resources')
    fs.mkdirSync(sharedRoot, { recursive: true })
    fs.writeFileSync(path.join(sharedRoot, 'uv.exe'), 'trojan')
    fs.writeFileSync(path.join(sharedRoot, 'planted.txt'), 'leave-me')
    const mod = await loadAipgRoot({ isPackaged: true, mode: 'shared', platform: 'win32' })
    fs.writeFileSync(path.join(sharedRoot, '.aipg-seed-version'), mod.seedId())

    expect(mod.packagedResourcesRoot()).toBe(sharedRoot)
    expect(fs.readFileSync(path.join(sharedRoot, 'uv.exe'), 'utf-8')).toBe('from-bundle')
    expect(fs.readFileSync(path.join(sharedRoot, 'planted.txt'), 'utf-8')).toBe('leave-me')
    expect(fs.existsSync(path.join(sharedRoot, 'notes.txt'))).toBe(false)
  })
})

describe('packagedResourcesRoot — per-build re-seed', () => {
  const sharedRoot = () => path.join(tmpPublic, 'AI Playground', 'resources')

  function plantModes(base: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(base, 'modes', rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    }
  }

  function writeBareMarker(): void {
    fs.writeFileSync(path.join(sharedRoot(), '.aipg-seed-version'), '0.0.0-test')
  }

  it('re-seeds a bare-version marker and overwrites the stale shipped preset', async () => {
    plantModes(tmpResources, { 'Assistant.json': '{"agentPreset":true}' })
    plantModes(sharedRoot(), { 'Assistant.json': '{"agentPreset":false}' })
    writeBareMarker()
    const mod = await loadAipgRoot({
      isPackaged: true,
      mode: 'shared',
      platform: 'win32',
      build: { commit: 'feedbee' },
    })

    expect(mod.packagedResourcesRoot()).toBe(sharedRoot())
    expect(fs.readFileSync(path.join(sharedRoot(), 'modes', 'Assistant.json'), 'utf-8')).toBe(
      '{"agentPreset":true}',
    )
    expect(fs.readFileSync(path.join(sharedRoot(), '.aipg-seed-version'), 'utf-8')).toBe(
      mod.seedId(),
    )
  })

  it('removes preset files and directories the new build dropped', async () => {
    plantModes(tmpResources, { 'Assistant.json': 'new', 'agent-pack/readme.txt': 'new' })
    plantModes(sharedRoot(), {
      'Assistant.json': 'old',
      'Agent.json': 'retired',
      'Agent.backup/Agent.json': 'retired-backup',
      'agent-pack/readme.txt': 'old',
    })
    writeBareMarker()
    const mod = await loadAipgRoot({ isPackaged: true, mode: 'shared', platform: 'win32' })

    mod.packagedResourcesRoot()

    expect(fs.existsSync(path.join(sharedRoot(), 'modes', 'Agent.json'))).toBe(false)
    expect(fs.existsSync(path.join(sharedRoot(), 'modes', 'Agent.backup'))).toBe(false)
    expect(fs.existsSync(path.join(sharedRoot(), 'modes', 'Assistant.json'))).toBe(true)
    expect(fs.existsSync(path.join(sharedRoot(), 'modes', 'agent-pack'))).toBe(true)
    expect(
      fs.readFileSync(path.join(sharedRoot(), 'modes', 'agent-pack', 'readme.txt'), 'utf-8'),
    ).toBe('new')
  })

  it('prunes a dropped preset whose name starts with ".."', async () => {
    plantModes(tmpResources, { 'Assistant.json': 'new' })
    plantModes(sharedRoot(), { '..cache.json': 'retired' })
    writeBareMarker()
    const mod = await loadAipgRoot({ isPackaged: true, mode: 'shared', platform: 'win32' })

    mod.packagedResourcesRoot()

    expect(fs.existsSync(path.join(sharedRoot(), 'modes', '..cache.json'))).toBe(false)
  })

  it('prunes only the shipped preset tree, leaving other writable files untouched', async () => {
    plantModes(tmpResources, { 'Assistant.json': 'new' })
    plantModes(sharedRoot(), { 'Agent.json': 'retired' })
    fs.mkdirSync(path.join(sharedRoot(), 'models'), { recursive: true })
    fs.writeFileSync(path.join(sharedRoot(), 'models', 'downloaded.json'), 'keep')
    fs.mkdirSync(path.join(sharedRoot(), 'user-presets'), { recursive: true })
    fs.writeFileSync(path.join(sharedRoot(), 'user-presets', 'mine.json'), 'mine')
    writeBareMarker()
    const mod = await loadAipgRoot({ isPackaged: true, mode: 'shared', platform: 'win32' })

    mod.packagedResourcesRoot()

    expect(fs.existsSync(path.join(sharedRoot(), 'modes', 'Agent.json'))).toBe(false)
    expect(fs.readFileSync(path.join(sharedRoot(), 'models', 'downloaded.json'), 'utf-8')).toBe(
      'keep',
    )
    expect(fs.readFileSync(path.join(sharedRoot(), 'user-presets', 'mine.json'), 'utf-8')).toBe(
      'mine',
    )
  })

  it.skipIf(process.platform === 'win32')(
    'leaves a link inside the preset tree alone and its target untouched',
    async () => {
      const outside = path.join(tmpBase, 'outside')
      fs.mkdirSync(outside, { recursive: true })
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
      plantModes(tmpResources, { 'Assistant.json': 'new' })
      fs.mkdirSync(path.join(sharedRoot(), 'modes'), { recursive: true })
      fs.symlinkSync(outside, path.join(sharedRoot(), 'modes', 'planted-link'), 'dir')
      writeBareMarker()
      const mod = await loadAipgRoot({
        isPackaged: true,
        mode: 'shared',
        platform: 'win32',
      })

      mod.packagedResourcesRoot()

      expect(fs.lstatSync(path.join(sharedRoot(), 'modes', 'planted-link')).isSymbolicLink()).toBe(
        true,
      )
      expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf-8')).toBe('secret')
    },
  )

  it('a second launch on the same build changes nothing', async () => {
    plantModes(tmpResources, { 'Assistant.json': 'current' })
    fs.writeFileSync(path.join(tmpResources, 'uv.exe'), 'from-bundle')
    const first = await loadAipgRoot({ isPackaged: true, mode: 'shared', platform: 'win32' })
    first.packagedResourcesRoot()
    const marker = fs.readFileSync(path.join(sharedRoot(), '.aipg-seed-version'), 'utf-8')
    fs.writeFileSync(path.join(sharedRoot(), 'user-added.txt'), 'mine')
    fs.writeFileSync(path.join(sharedRoot(), 'modes', 'stale.json'), 'keep-on-match')

    const second = await loadAipgRoot({ isPackaged: true, mode: 'shared', platform: 'win32' })

    expect(second.packagedResourcesRoot()).toBe(sharedRoot())
    expect(fs.readFileSync(path.join(sharedRoot(), '.aipg-seed-version'), 'utf-8')).toBe(marker)
    expect(marker).toBe(second.seedId())
    expect(fs.readFileSync(path.join(sharedRoot(), 'user-added.txt'), 'utf-8')).toBe('mine')
    expect(fs.existsSync(path.join(sharedRoot(), 'modes', 'stale.json'))).toBe(true)
  })

  it('produces a marker unlike a bare version, with one warning, when the build has no identity', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    plantModes(tmpResources, { 'Assistant.json': 'new' })
    fs.mkdirSync(sharedRoot(), { recursive: true })
    writeBareMarker()
    const mod = await loadAipgRoot({
      isPackaged: true,
      mode: 'shared',
      platform: 'win32',
      build: { commit: '', tag: '' },
    })

    mod.packagedResourcesRoot()

    const marker = fs.readFileSync(path.join(sharedRoot(), '.aipg-seed-version'), 'utf-8')
    expect(marker).not.toBe('0.0.0-test')
    expect(marker).toContain('0.0.0-test')
    expect(mod.seedId()).toBe('2|0.0.0-test|')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
