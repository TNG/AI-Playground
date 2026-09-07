import path from 'node:path'
import * as filesystem from 'fs-extra'
import { binary } from './tools.ts'

export type LlamaCppBuildVariant = 'standard' | 'ssd-offload'

type PhisonLogger = {
  info?: (message: string) => void
  warn?: (message: string) => void
}

export const LLAMACPP_SSD_OFFLOAD_DOWNLOAD_URL_TEMPLATE =
  'https://phisonbucket.s3.ap-northeast-1.amazonaws.com/aiDAPTIV_vNXWVB_3_05.0.zip'
export const LLAMACPP_SSD_OFFLOAD_CONFIG_NAME = 'aidaptiv_config.json'
export const LLAMACPP_SSD_OFFLOAD_LEGACY_CONFIG_NAME = 'aidaptiv(303G0B).json'
export const LLAMACPP_SSD_OFFLOAD_EMBEDDING_CONFIG_NAME = 'aidaptiv_embedding_config.json'
export const LLAMACPP_SSD_OFFLOAD_DELETE_SERVICE_SCRIPT = 'wService_delete.bat'
export const LLAMACPP_SSD_OFFLOAD_CREATE_SERVICE_SCRIPT = 'wService_create.bat'
export const LLAMACPP_SSD_OFFLOAD_PROCESS_NAME = 'ada.exe'

const CONFIG_FILE_FLAG = '--config-file'

/**
 * Context window the aiDAPTIV+ embedding server is started with.
 *
 * Scoped to the ssd-offload build on purpose: the standard llama.cpp build keeps
 * llama-server's own default and is not affected by this value.
 *
 * RAG chunks are 512 *characters* (SPLITTER_PARAMS in langchain.ts), which is not
 * 512 tokens: CJK text tokenizes at roughly one token per character, so a full
 * chunk lands around 512 tokens plus the model's two special tokens. 768 gives
 * that headroom without reserving a window the embedding pass never uses.
 *
 * Deliberately one value for every model rather than a per-model table:
 * llama-server caps `--ctx-size` at the model's own `n_ctx_train` and logs that it
 * did, so a model trained on a shorter window still gets exactly its maximum.
 * bge-small-en-v1.5 (n_ctx_train 512) therefore runs at 512, the same window it
 * already ran at before this flag existed — llama-server capped its previous
 * default the same way — while nomic-embed (8192) and Qwen3-Embedding (32768)
 * get 768.
 *
 * Must stay <= the embedding server's `-ub`: embedding is non-causal and pooled,
 * so the whole sequence has to fit in a single physical batch.
 */
export const PHISON_EMBEDDING_CONTEXT_SIZE = 768

const LLAMA_CPP_SUBDIR_STANDARD = 'llama-cpp'
const LLAMA_CPP_SUBDIR_PHISON = 'llama-cpp-phison'

const LLAMACPP_SSD_OFFLOAD_DEFAULT_CONFIG = {
  common: {
    seed: '0',
    flash_attn: 'on',
    swa_full: true,
    threads: 10,
    mmap: false,
    fit: 'off',
    context_shift: false,
    verbose: true,
    split_mode: 'none',
    parallel: 1,
    gpu_layers: '999',
  },
  aidaptiv: {
    debug_log_path: 'D:\\',
    dram_kv_offload_gb: 0,
    cache_kv_offload_gb: -1,
    kv_cache_resume_policy: true,
    vram_experts_cached_gb: -1,
  },
}

/**
 * The embedding server's own aiDAPTIV+ config.
 *
 * The llama.cpp `common` block is shared with the LLM config, but every
 * aiDAPTIV+ offload budget is zeroed: an embedding pass has no KV cache worth
 * parking on the SSD and no experts worth pinning in VRAM, so the LLM config's
 * reservations would be withheld from the LLM server for nothing.
 */
const LLAMACPP_SSD_OFFLOAD_EMBEDDING_DEFAULT_CONFIG = {
  common: { ...LLAMACPP_SSD_OFFLOAD_DEFAULT_CONFIG.common },
  aidaptiv: {
    debug_log_path: 'D:\\',
  },
}

export function isSsdOffloadVariant(variant: LlamaCppBuildVariant): boolean {
  return variant === 'ssd-offload'
}

export function getLlamaCppDirForVariant(
  serviceDir: string,
  variant: LlamaCppBuildVariant,
): string {
  const subdir = isSsdOffloadVariant(variant) ? LLAMA_CPP_SUBDIR_PHISON : LLAMA_CPP_SUBDIR_STANDARD
  return path.resolve(path.join(serviceDir, subdir))
}

export function getActiveLlamaCppExePath(
  serviceDir: string,
  variant: LlamaCppBuildVariant,
): string {
  return path.resolve(
    path.join(getLlamaCppDirForVariant(serviceDir, variant), binary('llama-server')),
  )
}

export function getZipPathForVariant(
  serviceDir: string,
  variant: LlamaCppBuildVariant,
  platformExtension: string,
): string {
  const suffix = isSsdOffloadVariant(variant) ? '-phison' : ''
  return path.resolve(path.join(serviceDir, `llama-cpp${suffix}.${platformExtension}`))
}

export function getSsdOffloadConfigPath(serviceDir: string): string {
  return path.resolve(path.join(serviceDir, LLAMACPP_SSD_OFFLOAD_CONFIG_NAME))
}

export function getLegacySsdOffloadConfigPath(serviceDir: string): string {
  return path.resolve(path.join(serviceDir, LLAMACPP_SSD_OFFLOAD_LEGACY_CONFIG_NAME))
}

export function getSsdOffloadEmbeddingConfigPath(serviceDir: string): string {
  return path.resolve(path.join(serviceDir, LLAMACPP_SSD_OFFLOAD_EMBEDDING_CONFIG_NAME))
}

export function getRelativeSsdOffloadConfigPath(
  serviceDir: string,
  variant: LlamaCppBuildVariant,
  configPath: string,
): string {
  const relativePath = path.relative(getLlamaCppDirForVariant(serviceDir, variant), configPath)
  return relativePath || path.basename(configPath)
}

/**
 * Point an argv at `configPath` for `--config-file`.
 *
 * The startup-parameter string is a single setting shared by the LLM and the
 * embedding server, so in ssd-offload mode both inherit the `--config-file`
 * the renderer put there. This rewrites just that flag's value for the
 * embedding server, keeping every other flag the user typed. Both spellings
 * llama-server accepts are handled, and the flag is appended when the user
 * removed it.
 */
export function withConfigFileArg(args: string[], configPath: string): string[] {
  const out: string[] = []
  let replaced = false

  const emit = (token: string) => {
    if (replaced) return
    out.push(token, configPath)
    replaced = true
  }

  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === CONFIG_FILE_FLAG) {
      const value = args[i + 1]
      if (value !== undefined && !value.startsWith('-')) i++
      emit(CONFIG_FILE_FLAG)
      continue
    }
    if (token.startsWith(`${CONFIG_FILE_FLAG}=`)) {
      if (!replaced) {
        out.push(`${CONFIG_FILE_FLAG}=${configPath}`)
        replaced = true
      }
      continue
    }
    out.push(token)
  }

  if (!replaced) out.push(CONFIG_FILE_FLAG, configPath)
  return out
}

export function computeStandardArtifactsReady(serviceDir: string): boolean {
  const standardDir = getLlamaCppDirForVariant(serviceDir, 'standard')
  const exe = path.join(standardDir, binary('llama-server'))
  if (!filesystem.existsSync(exe)) return false
  return !filesystem.existsSync(path.join(standardDir, LLAMACPP_SSD_OFFLOAD_PROCESS_NAME))
}

export function computePhisonArtifactsReady(serviceDir: string): boolean {
  const phisonDir = getLlamaCppDirForVariant(serviceDir, 'ssd-offload')
  const exe = path.join(phisonDir, binary('llama-server'))
  if (!filesystem.existsSync(exe)) return false
  return filesystem.existsSync(path.join(phisonDir, LLAMACPP_SSD_OFFLOAD_PROCESS_NAME))
}

export function computeVariantArtifactsReady(
  serviceDir: string,
  variant: LlamaCppBuildVariant,
): boolean {
  return isSsdOffloadVariant(variant)
    ? computePhisonArtifactsReady(serviceDir)
    : computeStandardArtifactsReady(serviceDir)
}

export function normalizeOffloadDrivePath(offloadDrive?: string | null): string | null {
  if (!offloadDrive) {
    return null
  }

  const trimmed = offloadDrive.trim()
  const driveMatch = trimmed.match(/^([A-Za-z]):/)
  if (!driveMatch) {
    return trimmed
  }

  return `${driveMatch[1].toUpperCase()}:\\`
}

export function migrateLegacySsdOffloadConfigFile(serviceDir: string, configPath: string): void {
  const legacyConfigPath = getLegacySsdOffloadConfigPath(serviceDir)
  if (filesystem.existsSync(legacyConfigPath) && !filesystem.existsSync(configPath)) {
    filesystem.moveSync(legacyConfigPath, configPath)
  }
}

export function ensureSsdOffloadConfigFileSync(serviceDir: string, configPath: string): void {
  migrateLegacySsdOffloadConfigFile(serviceDir, configPath)
  if (filesystem.existsSync(configPath)) {
    return
  }

  filesystem.ensureDirSync(serviceDir)
  filesystem.writeJsonSync(configPath, LLAMACPP_SSD_OFFLOAD_DEFAULT_CONFIG, { spaces: 2 })
}

export async function ensureSsdOffloadConfigFile(
  serviceDir: string,
  configPath: string,
): Promise<void> {
  migrateLegacySsdOffloadConfigFile(serviceDir, configPath)
  if (await filesystem.pathExists(configPath)) {
    return
  }

  await filesystem.ensureDir(serviceDir)
  await filesystem.writeJson(configPath, LLAMACPP_SSD_OFFLOAD_DEFAULT_CONFIG, { spaces: 2 })
}

/**
 * Create the embedding server's config on first use. Unlike the LLM config
 * there is no legacy filename to migrate from — this file only ever existed
 * under its current name.
 */
export function ensureSsdOffloadEmbeddingConfigFileSync(
  serviceDir: string,
  configPath: string,
): void {
  if (filesystem.existsSync(configPath)) {
    return
  }

  filesystem.ensureDirSync(serviceDir)
  filesystem.writeJsonSync(configPath, LLAMACPP_SSD_OFFLOAD_EMBEDDING_DEFAULT_CONFIG, { spaces: 2 })
}

export async function ensureSsdOffloadEmbeddingConfigFile(
  serviceDir: string,
  configPath: string,
): Promise<void> {
  if (await filesystem.pathExists(configPath)) {
    return
  }

  await filesystem.ensureDir(serviceDir)
  await filesystem.writeJson(configPath, LLAMACPP_SSD_OFFLOAD_EMBEDDING_DEFAULT_CONFIG, {
    spaces: 2,
  })
}

export async function updateSsdOffloadConfig(
  configPath: string,
  offloadDrive: string | null,
  logger?: PhisonLogger,
): Promise<void> {
  if (!filesystem.existsSync(configPath) || !offloadDrive) {
    return
  }

  try {
    const config = await filesystem.readJson(configPath)
    const aidaptiv = { ...(config.aidaptiv ?? {}) }

    // Migrate the legacy `ssd_kv_offload_gb` key to `cache_kv_offload_gb`
    // (the `--ssd-kv-offload-gb` flag was renamed to `--cache-kv-offload-gb`).
    if ('ssd_kv_offload_gb' in aidaptiv) {
      if (!('cache_kv_offload_gb' in aidaptiv)) {
        aidaptiv.cache_kv_offload_gb = aidaptiv.ssd_kv_offload_gb
      }
      delete aidaptiv.ssd_kv_offload_gb
    }

    // `offload_path` is deliberately absent. The app no longer manages it: it is
    // not seeded into the default config and never written here, so a value a user
    // adds to the file by hand survives this read-modify-write (as does any other
    // key the app doesn't know about, via the spreads above). aiDAPTIV+ still
    // honours it — it is simply the user's to set now, not ours.
    const updatedConfig = {
      ...config,
      aidaptiv: {
        ...aidaptiv,
        debug_log_path: offloadDrive,
      },
    }
    await filesystem.writeJson(configPath, updatedConfig, { spaces: 2 })
    logger?.info?.(`Updated SSD offload config debug log path to ${offloadDrive}`)
  } catch (error) {
    logger?.warn?.(`Failed to update SSD offload config: ${error}`)
  }
}

export function migrateLegacyPhisonIntoSeparateDirectory(
  serviceDir: string,
  logger?: PhisonLogger,
): void {
  const standardDir = getLlamaCppDirForVariant(serviceDir, 'standard')
  const phisonDir = getLlamaCppDirForVariant(serviceDir, 'ssd-offload')
  if (filesystem.existsSync(phisonDir)) return

  const adaPath = path.join(standardDir, LLAMACPP_SSD_OFFLOAD_PROCESS_NAME)
  if (!filesystem.existsSync(adaPath)) return

  try {
    filesystem.moveSync(standardDir, phisonDir)
    filesystem.mkdirSync(standardDir, { recursive: true })
    logger?.info?.(
      `Migrated Phison Llama.cpp from ${LLAMA_CPP_SUBDIR_STANDARD}/ to ${LLAMA_CPP_SUBDIR_PHISON}/`,
    )
  } catch (error) {
    logger?.warn?.(`Phison directory migration skipped: ${error}`)
  }
}

export function resolveLlamaCppDownloadUrl(
  version: string,
  variant: LlamaCppBuildVariant,
  platformExtension: string,
  platformArch: string,
): string {
  if (isSsdOffloadVariant(variant)) {
    return LLAMACPP_SSD_OFFLOAD_DOWNLOAD_URL_TEMPLATE.replace('{version}', version)
      .replace('{platformArch}', platformArch)
      .replace('{extension}', platformExtension)
  }

  return `https://github.com/ggml-org/llama.cpp/releases/download/${version}/llama-${version}-bin-${platformArch}.${platformExtension}`
}

export function getModelServerEnvAdditions(
  variant: LlamaCppBuildVariant,
): Partial<NodeJS.ProcessEnv> {
  return isSsdOffloadVariant(variant) ? { GGML_VK_DISABLE_F16: '1' } : {}
}
