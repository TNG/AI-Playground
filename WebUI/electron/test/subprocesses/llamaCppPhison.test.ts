import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import * as filesystem from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'
import { binary } from '../../subprocesses/tools'
import {
  computePhisonArtifactsReady,
  computeStandardArtifactsReady,
  ensureSsdOffloadConfigFileSync,
  ensureSsdOffloadEmbeddingConfigFileSync,
  getLlamaCppDirForVariant,
  getModelServerEnvAdditions,
  getRelativeSsdOffloadConfigPath,
  getSsdOffloadConfigPath,
  getSsdOffloadEmbeddingConfigPath,
  getZipPathForVariant,
  migrateLegacyPhisonIntoSeparateDirectory,
  migrateLegacySsdOffloadConfigFile,
  normalizeOffloadDrivePath,
  withConfigFileArg,
} from '../../subprocesses/llamaCppPhison'

const tempDirs: string[] = []

function createServiceDir(): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'llamacpp-phison-'))
  tempDirs.push(tempDir)
  return tempDir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
})

describe('llamaCppPhison helpers', () => {
  it('keeps standard and Phison artifacts isolated on disk', () => {
    const serviceDir = createServiceDir()
    const standardDir = getLlamaCppDirForVariant(serviceDir, 'standard')
    const phisonDir = getLlamaCppDirForVariant(serviceDir, 'ssd-offload')

    expect(standardDir).toBe(path.join(serviceDir, 'llama-cpp'))
    expect(phisonDir).toBe(path.join(serviceDir, 'llama-cpp-phison'))
    expect(getZipPathForVariant(serviceDir, 'standard', 'zip')).toBe(
      path.join(serviceDir, 'llama-cpp.zip'),
    )
    expect(getZipPathForVariant(serviceDir, 'ssd-offload', 'zip')).toBe(
      path.join(serviceDir, 'llama-cpp-phison.zip'),
    )
  })

  it('detects standard vs Phison artifact readiness independently', () => {
    const serviceDir = createServiceDir()
    const standardDir = getLlamaCppDirForVariant(serviceDir, 'standard')
    const phisonDir = getLlamaCppDirForVariant(serviceDir, 'ssd-offload')

    filesystem.ensureDirSync(standardDir)
    filesystem.ensureDirSync(phisonDir)
    filesystem.writeFileSync(path.join(standardDir, binary('llama-server')), '')
    filesystem.writeFileSync(path.join(phisonDir, binary('llama-server')), '')

    expect(computeStandardArtifactsReady(serviceDir)).toBe(true)
    expect(computePhisonArtifactsReady(serviceDir)).toBe(false)

    filesystem.writeFileSync(path.join(phisonDir, 'ada.exe'), '')
    expect(computePhisonArtifactsReady(serviceDir)).toBe(true)

    filesystem.writeFileSync(path.join(standardDir, 'ada.exe'), '')
    expect(computeStandardArtifactsReady(serviceDir)).toBe(false)
  })

  it('migrates legacy Phison installs and config files without touching standard defaults', () => {
    const serviceDir = createServiceDir()
    const standardDir = getLlamaCppDirForVariant(serviceDir, 'standard')
    const phisonDir = getLlamaCppDirForVariant(serviceDir, 'ssd-offload')
    const configPath = getSsdOffloadConfigPath(serviceDir)
    const legacyConfigPath = path.join(serviceDir, 'aidaptiv(303G0B).json')

    filesystem.ensureDirSync(standardDir)
    filesystem.writeFileSync(path.join(standardDir, 'ada.exe'), '')
    filesystem.writeFileSync(path.join(standardDir, 'custom.txt'), 'legacy-phison')
    filesystem.ensureDirSync(serviceDir)
    filesystem.writeJsonSync(legacyConfigPath, { legacy: true })

    migrateLegacySsdOffloadConfigFile(serviceDir, configPath)
    migrateLegacyPhisonIntoSeparateDirectory(serviceDir)

    expect(filesystem.existsSync(configPath)).toBe(true)
    expect(filesystem.readJsonSync(configPath)).toEqual({ legacy: true })
    expect(filesystem.existsSync(path.join(phisonDir, 'custom.txt'))).toBe(true)
    expect(filesystem.existsSync(standardDir)).toBe(true)
  })

  it('normalizes SSD settings and exposes relative config paths', () => {
    const serviceDir = createServiceDir()
    const configPath = getSsdOffloadConfigPath(serviceDir)

    ensureSsdOffloadConfigFileSync(serviceDir, configPath)

    expect(normalizeOffloadDrivePath('r:')).toBe('R:\\')
    expect(normalizeOffloadDrivePath(' /mnt/fast ')).toBe('/mnt/fast')
    expect(getRelativeSsdOffloadConfigPath(serviceDir, 'ssd-offload', configPath)).toBe(
      path.join('..', 'aidaptiv_config.json'),
    )
    expect(getModelServerEnvAdditions('standard')).toEqual({})
    expect(getModelServerEnvAdditions('ssd-offload')).toEqual({ GGML_VK_DISABLE_F16: '1' })
  })

  it('gives the embedding server its own config with no aiDAPTIV+ budgets of its own', () => {
    const serviceDir = createServiceDir()
    const configPath = getSsdOffloadConfigPath(serviceDir)
    const embeddingConfigPath = getSsdOffloadEmbeddingConfigPath(serviceDir)

    expect(embeddingConfigPath).not.toBe(configPath)

    ensureSsdOffloadConfigFileSync(serviceDir, configPath)
    ensureSsdOffloadEmbeddingConfigFileSync(serviceDir, embeddingConfigPath)

    const llm = filesystem.readJsonSync(configPath)
    const embedding = filesystem.readJsonSync(embeddingConfigPath)

    // The embedding config carries only the aiDAPTIV+ block: no `common` of its
    // own (the llama.cpp side comes from the shared startup parameters on the
    // argv), and none of the aiDAPTIV+ budget keys at all — an embedding pass has
    // no KV cache worth parking on the SSD and no experts worth pinning in VRAM,
    // and leaving the keys out entirely (rather than writing zeros) is what keeps
    // the LLM server's own reservations untouched.
    expect(embedding.common).toBeUndefined()
    expect(llm.common.gpu_layers).toBe('999')
    expect(embedding.aidaptiv.cache_kv_offload_gb).toBeUndefined()
    expect(embedding.aidaptiv.dram_kv_offload_gb).toBeUndefined()
    expect(embedding.aidaptiv.vram_experts_cached_gb).toBeUndefined()
    expect(embedding.aidaptiv.kv_cache_resume_policy).toBeUndefined()
    expect(llm.aidaptiv.cache_kv_offload_gb).toBe(-1)

    expect(getRelativeSsdOffloadConfigPath(serviceDir, 'ssd-offload', embeddingConfigPath)).toBe(
      path.join('..', 'aidaptiv_embedding_config.json'),
    )
  })

  it('does not overwrite an existing embedding config', () => {
    const serviceDir = createServiceDir()
    const embeddingConfigPath = getSsdOffloadEmbeddingConfigPath(serviceDir)

    filesystem.ensureDirSync(serviceDir)
    filesystem.writeJsonSync(embeddingConfigPath, { aidaptiv: { cache_kv_offload_gb: 4 } })
    ensureSsdOffloadEmbeddingConfigFileSync(serviceDir, embeddingConfigPath)

    expect(filesystem.readJsonSync(embeddingConfigPath)).toEqual({
      aidaptiv: { cache_kv_offload_gb: 4 },
    })
  })

  describe('withConfigFileArg', () => {
    const target = '..\aidativ_embedding_config.json'

    it('replaces the value of a spaced --config-file, keeping other flags', () => {
      expect(
        withConfigFileArg(
          ['--gpu-layers', '999', '--config-file', '..\aidaptiv_config.json'],
          target,
        ),
      ).toEqual(['--gpu-layers', '999', '--config-file', target])
    })

    it('replaces the --config-file=value spelling', () => {
      expect(
        withConfigFileArg(['--config-file=../aidaptiv_config.json', '-fa', 'on'], target),
      ).toEqual([`--config-file=${target}`, '-fa', 'on'])
    })

    it('appends the flag when the user removed it', () => {
      expect(withConfigFileArg(['--gpu-layers', '999'], target)).toEqual([
        '--gpu-layers',
        '999',
        '--config-file',
        target,
      ])
    })

    it('collapses a repeated --config-file to a single occurrence', () => {
      expect(
        withConfigFileArg(
          ['--config-file', 'a.json', '--jinja', '--config-file', 'b.json'],
          target,
        ),
      ).toEqual(['--config-file', target, '--jinja'])
    })

    it('does not swallow the next flag after a bare --config-file', () => {
      expect(withConfigFileArg(['--config-file', '--jinja'], target)).toEqual([
        '--config-file',
        target,
        '--jinja',
      ])
    })
  })
})
