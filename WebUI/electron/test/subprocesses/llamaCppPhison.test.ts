import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import * as filesystem from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'
import { binary } from '../../subprocesses/tools'
import {
  computePhisonArtifactsReady,
  computeStandardArtifactsReady,
  defaultAidaptivPath,
  PHISON_DEFAULT_OFFLOAD_PATH,
  PHISON_DEFAULT_VRAM_EXPERTS_CACHED_GB,
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
  reconcileSsdOffloadConfig,
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

  it('exposes relative config paths', () => {
    const serviceDir = createServiceDir()
    const configPath = getSsdOffloadConfigPath(serviceDir)

    ensureSsdOffloadConfigFileSync(serviceDir, configPath)

    expect(getRelativeSsdOffloadConfigPath(serviceDir, 'ssd-offload', configPath)).toBe(
      path.join('..', 'aidaptiv_config.json'),
    )
    expect(getModelServerEnvAdditions('standard')).toEqual({})
    expect(getModelServerEnvAdditions('ssd-offload')).toEqual({ GGML_VK_DISABLE_F16: '1' })
  })

  it('gives the embedding server its own config with no aiDAPTIV budgets of its own', () => {
    const serviceDir = createServiceDir()
    const configPath = getSsdOffloadConfigPath(serviceDir)
    const embeddingConfigPath = getSsdOffloadEmbeddingConfigPath(serviceDir)

    expect(embeddingConfigPath).not.toBe(configPath)

    ensureSsdOffloadConfigFileSync(serviceDir, configPath)
    ensureSsdOffloadEmbeddingConfigFileSync(serviceDir, embeddingConfigPath)

    const llm = filesystem.readJsonSync(configPath)
    const embedding = filesystem.readJsonSync(embeddingConfigPath)

    // The embedding config carries only the aiDAPTIV block: no `common` of its
    // own (the llama.cpp side comes from the shared startup parameters on the
    // argv), and none of the aiDAPTIV budget keys at all — an embedding pass has
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
    // A positive cap, not the `-1` this shipped as: at `-1` the runtime keeps
    // every expert in VRAM and never spills, which is the ssd-offload build
    // with its offload switched off.
    expect(llm.aidaptiv.vram_experts_cached_gb).toBe(PHISON_DEFAULT_VRAM_EXPERTS_CACHED_GB)
    expect(PHISON_DEFAULT_VRAM_EXPERTS_CACHED_GB).toBeGreaterThan(0)

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

  // aiDAPTIV rejects a config with no `offload_path` at all, so both configs
  // have to carry one — and it has to name the SSD the build offloads to, not
  // the install directory, which would load the model with no spill device.
  it('seeds both configs with the SSD offload path and a usable debug log path', () => {
    const serviceDir = createServiceDir()
    const configPath = getSsdOffloadConfigPath(serviceDir)
    const embeddingConfigPath = getSsdOffloadEmbeddingConfigPath(serviceDir)

    ensureSsdOffloadConfigFileSync(serviceDir, configPath)
    ensureSsdOffloadEmbeddingConfigFileSync(serviceDir, embeddingConfigPath)

    for (const seeded of [configPath, embeddingConfigPath]) {
      const { offload_path, debug_log_path } = filesystem.readJsonSync(seeded).aidaptiv
      expect(offload_path).toBe(PHISON_DEFAULT_OFFLOAD_PATH)
      expect(debug_log_path).toBe(defaultAidaptivPath(serviceDir))
      expect(filesystem.existsSync(debug_log_path)).toBe(true)
    }
  })

  describe('reconcileSsdOffloadConfig', () => {
    it('renames the legacy offload key and keeps unknown keys', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)

      filesystem.ensureDirSync(serviceDir)
      filesystem.writeJsonSync(configPath, {
        common: { gpu_layers: '999' },
        aidaptiv: { ssd_kv_offload_gb: 10, offload_path: serviceDir, debug_log_path: serviceDir },
      })

      await reconcileSsdOffloadConfig(configPath, serviceDir)

      const config = filesystem.readJsonSync(configPath)
      expect(config.aidaptiv.cache_kv_offload_gb).toBe(10)
      expect(config.aidaptiv.ssd_kv_offload_gb).toBeUndefined()
      // Hand-added keys and the whole `common` block survive the rewrite.
      expect(config.aidaptiv.offload_path).toBe(serviceDir)
      expect(config.common.gpu_layers).toBe('999')
    })

    it('repairs a debug log path pointing at a drive this machine does not have', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)

      filesystem.ensureDirSync(serviceDir)
      filesystem.writeJsonSync(configPath, { aidaptiv: { debug_log_path: 'Q:\\nope' } })

      await reconcileSsdOffloadConfig(configPath, serviceDir)

      expect(filesystem.readJsonSync(configPath).aidaptiv.debug_log_path).toBe(
        defaultAidaptivPath(serviceDir),
      )
    })

    // The state a build that seeded no `offload_path` at all left behind: the
    // key is absent rather than stale, and aiDAPTIV refuses the config outright.
    it('adds an offload path that is missing entirely', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)

      filesystem.ensureDirSync(serviceDir)
      filesystem.writeJsonSync(configPath, { aidaptiv: { debug_log_path: serviceDir } })

      await reconcileSsdOffloadConfig(configPath, serviceDir)

      expect(filesystem.readJsonSync(configPath).aidaptiv.offload_path).toBe(
        PHISON_DEFAULT_OFFLOAD_PATH,
      )
    })

    // An unmounted SSD or an unassigned drive letter must not be "repaired" into
    // a path on the system drive: the model would then load with nowhere to
    // spill and die on a Vulkan allocation instead, blaming the GPU.
    it('keeps an offload path that is currently unreachable, and warns', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)
      const warnings: string[] = []

      filesystem.ensureDirSync(serviceDir)
      filesystem.writeJsonSync(configPath, { aidaptiv: { offload_path: 'Q:\\nope' } })

      await reconcileSsdOffloadConfig(configPath, serviceDir, {
        warn: (message) => warnings.push(message),
      })

      expect(filesystem.readJsonSync(configPath).aidaptiv.offload_path).toBe('Q:\\nope')
      expect(warnings.some((w) => w.includes('Q:\\nope'))).toBe(true)
    })

    // Configs written before the default changed keep offload disabled, and now
    // survive reinstalls too — so the sentinel has to be repaired in place.
    it('raises a vram_experts_cached_gb of -1 to a value that offloads', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)

      filesystem.ensureDirSync(serviceDir)
      filesystem.writeJsonSync(configPath, {
        aidaptiv: {
          offload_path: serviceDir,
          debug_log_path: serviceDir,
          vram_experts_cached_gb: -1,
        },
      })

      await reconcileSsdOffloadConfig(configPath, serviceDir)

      expect(filesystem.readJsonSync(configPath).aidaptiv.vram_experts_cached_gb).toBe(
        PHISON_DEFAULT_VRAM_EXPERTS_CACHED_GB,
      )
    })

    it('leaves a vram_experts_cached_gb the user chose alone', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)

      filesystem.ensureDirSync(serviceDir)
      filesystem.writeJsonSync(configPath, {
        aidaptiv: {
          offload_path: serviceDir,
          debug_log_path: serviceDir,
          vram_experts_cached_gb: 12,
        },
      })

      await reconcileSsdOffloadConfig(configPath, serviceDir)

      expect(filesystem.readJsonSync(configPath).aidaptiv.vram_experts_cached_gb).toBe(12)
    })

    it('leaves an offload path the user pointed at a real drive alone', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)
      const userPath = path.join(serviceDir, 'fast-ssd')

      filesystem.ensureDirSync(userPath)
      filesystem.writeJsonSync(configPath, { aidaptiv: { offload_path: userPath } })

      await reconcileSsdOffloadConfig(configPath, serviceDir)

      expect(filesystem.readJsonSync(configPath).aidaptiv.offload_path).toBe(userPath)
    })

    it('leaves a debug log path that does exist alone', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)
      const userPath = path.join(serviceDir, 'logs')

      filesystem.ensureDirSync(userPath)
      filesystem.writeJsonSync(configPath, { aidaptiv: { debug_log_path: userPath } })

      await reconcileSsdOffloadConfig(configPath, serviceDir)

      expect(filesystem.readJsonSync(configPath).aidaptiv.debug_log_path).toBe(userPath)
    })

    it('is a no-op on a config it has nothing to repair', async () => {
      const serviceDir = createServiceDir()
      const configPath = getSsdOffloadConfigPath(serviceDir)

      ensureSsdOffloadConfigFileSync(serviceDir, configPath)
      const before = filesystem.readJsonSync(configPath)

      await reconcileSsdOffloadConfig(configPath, serviceDir)

      expect(filesystem.readJsonSync(configPath)).toEqual(before)
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
