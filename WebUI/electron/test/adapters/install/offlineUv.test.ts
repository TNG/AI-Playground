import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyOfflineUv,
  offlineUvCacheDir,
} from '../../../adapters/install/uvBasedBackends/offlineUv'

describe('applyOfflineUv', () => {
  const baseDir = path.join('resources')

  it('adds --offline and the bundled cache for a shipped project', () => {
    const applied = applyOfflineUv(['sync', '--project', 'service'], {
      baseDir,
      project: 'service',
      markerExists: true,
    })
    expect(applied.command).toEqual(['--offline', 'sync', '--project', 'service'])
    expect(applied.env).toEqual({ UV_CACHE_DIR: offlineUvCacheDir(baseDir) })
    expect(offlineUvCacheDir(baseDir)).toBe(path.join(baseDir, 'uv-cache'))
  })

  it('leaves ComfyUI and unmarked projects on the network', () => {
    expect(
      applyOfflineUv(['sync'], { baseDir, project: 'comfyui', markerExists: true }).command,
    ).toEqual(['sync'])
    expect(
      applyOfflineUv(['sync'], { baseDir, project: 'service', markerExists: false }).command,
    ).toEqual(['sync'])
    expect(
      applyOfflineUv(['python', 'install', '3.12'], { baseDir, markerExists: true }).command,
    ).toEqual(['python', 'install', '3.12'])
  })

  it('does not add --offline twice and keeps the caller env', () => {
    const applied = applyOfflineUv(['--offline', 'sync'], {
      baseDir,
      project: 'OpenVINO',
      markerExists: true,
      extraEnv: { UV_PYTHON_PREFERENCE: 'only-managed' },
    })
    expect(applied.command).toEqual(['--offline', 'sync'])
    expect(applied.env).toEqual({
      UV_PYTHON_PREFERENCE: 'only-managed',
      UV_CACHE_DIR: offlineUvCacheDir(baseDir),
    })
  })
})

describe('offline installer command', () => {
  const cmd = readFileSync(
    path.resolve(__dirname, '../../../../build/offline/install-offline.cmd'),
    'utf8',
  )

  it('creates the three environments from the bundled cache', () => {
    expect(cmd).toContain('call :syncProject service')
    expect(cmd).toContain('call :syncProject home-agent')
    expect(cmd).toContain('call :syncProject OpenVINO')
    expect(cmd).toContain('--offline')
    expect(cmd).not.toContain('.aipg-seed-version')
  })
})
