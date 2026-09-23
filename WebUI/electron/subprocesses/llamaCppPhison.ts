import path from 'node:path'
import * as filesystem from 'fs-extra'
import { binary } from './tools.ts'

export type LlamaCppBuildVariant = 'standard' | 'ssd-offload'

type PhisonLogger = {
  info?: (message: string) => void
  warn?: (message: string) => void
}

export const LLAMACPP_SSD_OFFLOAD_DOWNLOAD_URL_TEMPLATE =
  'https://phisonbucket.s3.ap-northeast-1.amazonaws.com/aiDAPTIV_NXWVB306.1_x64.zip'
export const LLAMACPP_SSD_OFFLOAD_CONFIG_NAME = 'aidaptiv_config.json'
export const LLAMACPP_SSD_OFFLOAD_LEGACY_CONFIG_NAME = 'aidaptiv(303G0B).json'
export const LLAMACPP_SSD_OFFLOAD_EMBEDDING_CONFIG_NAME = 'aidaptiv_embedding_config.json'
export const LLAMACPP_SSD_OFFLOAD_DELETE_SERVICE_SCRIPT = 'wService_delete.bat'
export const LLAMACPP_SSD_OFFLOAD_CREATE_SERVICE_SCRIPT = 'wService_create.bat'
export const LLAMACPP_SSD_OFFLOAD_PROCESS_NAME = 'ada.exe'

const CONFIG_FILE_FLAG = '--config-file'

/**
 * Context window the aiDAPTIV embedding server is started with.
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

/**
 * Where aiDAPTIV parks the weights and KV cache it spills off the GPU.
 *
 * The aiDAPTIV SSD, which these systems mount at `R:`, and deliberately not a
 * path under the install directory: offloading is the entire reason the
 * ssd-offload build exists. A `largeMoe` model is chosen precisely because it
 * does not fit in VRAM, so sending its spill to the system drive does not merely
 * make it slow — the weights never reach the fast device the runtime is built
 * around, and loading fails with a Vulkan out-of-device-memory abort that reads
 * like the model simply being too big for the GPU.
 *
 * `R:\` is Phison's own shipped default and matches what their service scripts
 * (`wService_create.bat`) provision, so it is the right guess on a machine that
 * has the hardware. `debug_log_path` is a different matter and keeps its
 * service-directory default: a log is not offload traffic and has to land
 * somewhere that exists even when the SSD does not.
 *
 * Not repaired away when it is missing — see `reconcileSsdOffloadConfig`.
 */
export const PHISON_DEFAULT_OFFLOAD_PATH = 'R:\\'

/**
 * How much VRAM aiDAPTIV may hold experts in before it spills them to the SSD.
 *
 * A positive cap, because the `-1` this shipped as turns the offload off. That
 * is not a reading of the documentation — there is none for this key — but of
 * two runs differing in nothing else: at `-1` the daemon wrote not one byte to
 * the SSD while llama.cpp tried to place all of a 35B MoE on an 18 GiB card and
 * died doing it; at `4` the same model loaded and ran. Whatever `-1` denotes to
 * the runtime, shipping it means shipping the ssd-offload build with its reason
 * for existing disabled, and the failure it produces names neither the setting
 * nor the SSD — only a Vulkan allocation that came up short.
 *
 * `4` is validated, not derived: one machine, an Arc B390 with 18 GiB and a
 * ~21 GiB model. A value scaled to the GPU would likely serve a range of
 * hardware better, but scaling a number whose units are inferred would be
 * arithmetic dressed up as understanding. A constant known to work is the
 * honest version of what is actually known, until Phison says what the key
 * means and what it should be.
 */
export const PHISON_DEFAULT_VRAM_EXPERTS_CACHED_GB = 4

/**
 * Default for the aiDAPTIV config's `debug_log_path`.
 *
 * The service directory, not a fixed drive letter: the app created it, writes
 * the config file itself into it, and it exists on every machine. A hardcoded
 * `D:\` does not. Trailing separator kept: the previous values were drive roots
 * (`R:\`, `D:\`), so aiDAPTIV is given a path in the shape it already expected.
 */
export function defaultAidaptivPath(serviceDir: string): string {
  return path.resolve(serviceDir) + path.sep
}

function ssdOffloadDefaultConfig(serviceDir: string) {
  return {
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
      offload_path: PHISON_DEFAULT_OFFLOAD_PATH,
      debug_log_path: defaultAidaptivPath(serviceDir),
      dram_kv_offload_gb: 0,
      cache_kv_offload_gb: -1,
      kv_cache_resume_policy: true,
      vram_experts_cached_gb: PHISON_DEFAULT_VRAM_EXPERTS_CACHED_GB,
    },
  }
}

/**
 * The embedding server's own aiDAPTIV config.
 *
 * Deliberately nothing but the aiDAPTIV block. There is no `common` block: the
 * embedding server is launched from the same startup-parameter string as the LLM,
 * so the llama.cpp side is already on its argv, and a copy of the LLM config's
 * `common` here would only be a second place to keep in sync. The offload
 * budgets (`cache_kv_offload_gb`, `vram_experts_cached_gb`) are left out too: an
 * embedding pass has no KV cache worth parking on the SSD and no experts worth
 * pinning in VRAM, so inheriting the LLM config's reservations would withhold
 * them from the LLM server for nothing.
 *
 * `offload_path` is not one of those optional budgets: the embedding server is
 * the same aiDAPTIV runtime and rejects the config without it exactly as the
 * LLM server does, so it is seeded here too.
 */
function ssdOffloadEmbeddingDefaultConfig(serviceDir: string) {
  return {
    aidaptiv: {
      offload_path: PHISON_DEFAULT_OFFLOAD_PATH,
      debug_log_path: defaultAidaptivPath(serviceDir),
    },
  }
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
  filesystem.writeJsonSync(configPath, ssdOffloadDefaultConfig(serviceDir), { spaces: 2 })
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
  await filesystem.writeJson(configPath, ssdOffloadDefaultConfig(serviceDir), { spaces: 2 })
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
  filesystem.writeJsonSync(configPath, ssdOffloadEmbeddingDefaultConfig(serviceDir), { spaces: 2 })
}

export async function ensureSsdOffloadEmbeddingConfigFile(
  serviceDir: string,
  configPath: string,
): Promise<void> {
  if (await filesystem.pathExists(configPath)) {
    return
  }

  await filesystem.ensureDir(serviceDir)
  await filesystem.writeJson(configPath, ssdOffloadEmbeddingDefaultConfig(serviceDir), {
    spaces: 2,
  })
}

/**
 * Bring an existing aiDAPTIV config up to date without disturbing the user's
 * own edits.
 *
 * Three repairs, all idempotent:
 *
 * - the legacy `ssd_kv_offload_gb` key becomes `cache_kv_offload_gb` (the
 *   `--ssd-kv-offload-gb` flag was renamed to `--cache-kv-offload-gb`);
 * - a `debug_log_path` pointing at a directory that no longer exists is reset to
 *   the service directory. Configs seeded by older builds name a drive that was
 *   only ever valid on the machine that picked it, and aiDAPTIV cannot log to a
 *   path that is not there;
 * - an `offload_path` that is *absent* is restored to the shipped default, since
 *   aiDAPTIV rejects a config without the key outright. One that is present but
 *   currently unreachable is left exactly as it is, and only warned about.
 *
 * That asymmetry is deliberate. A `debug_log_path` can be pointed anywhere that
 * exists, because losing the log costs a log. `offload_path` cannot: redirecting
 * it to whatever directory happens to be available sends spill to the system
 * drive instead of the aiDAPTIV SSD, and the model then fails to load with a
 * Vulkan allocation error that says nothing about the path. An offload path that
 * is merely temporarily missing — an SSD not yet mounted, a drive letter not yet
 * assigned — is worth preserving and reporting, not silently overwriting with a
 * value that will quietly fail to do the one thing it is for.
 *
 * Anything else the app does not know about survives this read-modify-write via
 * the spreads below.
 */
export async function reconcileSsdOffloadConfig(
  configPath: string,
  serviceDir: string,
  logger?: PhisonLogger,
): Promise<void> {
  if (!filesystem.existsSync(configPath)) {
    return
  }

  try {
    const config = await filesystem.readJson(configPath)
    const aidaptiv = { ...(config.aidaptiv ?? {}) }
    const changes: string[] = []

    if ('ssd_kv_offload_gb' in aidaptiv) {
      if (!('cache_kv_offload_gb' in aidaptiv)) {
        aidaptiv.cache_kv_offload_gb = aidaptiv.ssd_kv_offload_gb
      }
      delete aidaptiv.ssd_kv_offload_gb
      changes.push('renamed ssd_kv_offload_gb to cache_kv_offload_gb')
    }

    const debugLogPath = aidaptiv.debug_log_path
    if (typeof debugLogPath !== 'string' || !filesystem.existsSync(debugLogPath)) {
      aidaptiv.debug_log_path = defaultAidaptivPath(serviceDir)
      changes.push(`reset unusable debug_log_path to ${aidaptiv.debug_log_path}`)
    }

    const offloadPath = aidaptiv.offload_path
    if (typeof offloadPath !== 'string' || offloadPath.trim() === '') {
      aidaptiv.offload_path = PHISON_DEFAULT_OFFLOAD_PATH
      changes.push(`restored missing offload_path to ${aidaptiv.offload_path}`)
    } else if (!filesystem.existsSync(offloadPath)) {
      // Left in place on purpose: this is the aiDAPTIV SSD, and pointing it
      // anywhere else would load the model without the offload it exists for.
      logger?.warn?.(
        `aiDAPTIV offload_path ${offloadPath} is not reachable — the SSD offload build cannot spill to it, and large models will fail to load with a GPU memory error. Mount the drive or correct offload_path in ${path.basename(configPath)}.`,
      )
    }

    // The `-1` that shipped as the default, repaired wherever it is still on
    // disk. Changing the seeded value only reaches configs written from now on,
    // so without this every existing install keeps offload switched off until
    // someone reinstalls the backend or edits the JSON by hand — having first
    // worked out, from a Vulkan allocation error that mentions neither this key
    // nor the SSD, that it was the cause. Only the known-bad sentinel is
    // touched; any other number is a deliberate choice and is left alone.
    if (aidaptiv.vram_experts_cached_gb === -1) {
      aidaptiv.vram_experts_cached_gb = PHISON_DEFAULT_VRAM_EXPERTS_CACHED_GB
      changes.push(
        `raised vram_experts_cached_gb from -1 (offload disabled) to ${PHISON_DEFAULT_VRAM_EXPERTS_CACHED_GB}`,
      )
    }

    if (changes.length === 0) {
      return
    }

    await filesystem.writeJson(configPath, { ...config, aidaptiv }, { spaces: 2 })
    logger?.info?.(`Reconciled ${path.basename(configPath)}: ${changes.join('; ')}`)
  } catch (error) {
    logger?.warn?.(`Failed to reconcile SSD offload config: ${error}`)
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
