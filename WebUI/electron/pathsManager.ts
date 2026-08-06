import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { packagedResourcesRoot } from './aipgRoot.ts'
import type { ModelPaths, ModelLists } from '@/assets/js/store/models'
import { llmBackendTypes } from '../src/types/shared'
import {
  COMFYUI_MIRRORED_PATH_KEYS,
  MODEL_SCAN_TARGETS,
  type ModelLibraryScan,
  type ModelScanTarget,
  type ScannedModel,
} from '../src/assets/js/models/types'

/**
 * Base directory that relative model paths in `model_config.json` (e.g.
 * `"./resources/models/..."`) are anchored to. This is the app root — the parent
 * of the packaged `resources/` directory — NOT `process.cwd()`, which is
 * unreliable (e.g. an AppImage launched from an arbitrary folder). On Linux this
 * resolves under the writable resources root so downloads land exactly where the
 * backends (llama.cpp / OpenVINO) look for models.
 */
function modelPathResolveBaseDir(): string {
  return app.isPackaged ? path.dirname(packagedResourcesRoot()) : process.cwd()
}

// The single app-wide PathsManager, exposed so background services (e.g. the
// qwen3-tts sidecar) can resolve model directories without threading the
// instance through their constructors. Set when the manager is created in main.ts.
let sharedPathsManager: PathsManager | null = null

/** Absolute directory configured for a model type (e.g. 'TTS'), or undefined. */
export function getSharedModelDir(type: string): string | undefined {
  const paths = sharedPathsManager?.modelPaths as Record<string, string> | undefined
  return paths?.[type]
}

export class PathsManager {
  modelPaths: ModelPaths = {
    ggufLLM: '',
    openvinoLLM: '',
    embedding: '',
  }
  configPath: string

  constructor(configPath: string) {
    this.configPath = configPath
    this.loadConfig()
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- expose the single app-wide instance
    sharedPathsManager = this
  }
  loadConfig() {
    this.initModelPaths(JSON.parse(fs.readFileSync(this.configPath).toString()) as ModelPaths)
  }
  updateModelPaths(modelPaths: ModelPaths) {
    this.initModelPaths(modelPaths)
    const workDir = modelPathResolveBaseDir()
    const savePaths = Object.assign({}, this.modelPaths)
    Object.keys(savePaths).forEach((key) => {
      let modelPath = path.resolve(modelPaths[key])
      //if the path is in the workDir, save the relative path
      if (modelPath.startsWith(workDir)) {
        modelPath = path.relative(workDir, modelPath)
      }
      savePaths[key] = modelPath
    })
    fs.writeFileSync(this.configPath, JSON.stringify(savePaths, null, 4))
  }
  private initModelPaths(modelPaths: ModelPaths) {
    const baseDir = modelPathResolveBaseDir()
    // Initialize base paths
    Object.keys(this.modelPaths).forEach((key) => {
      if (key in modelPaths) {
        const modelPath = path.resolve(baseDir, modelPaths[key])
        this.modelPaths[key] = modelPath
      }
    })
    // Copy all other paths (ComfyUI paths like lora, checkpoints, vae, etc.)
    Object.keys(modelPaths).forEach((key) => {
      if (!(key in this.modelPaths)) {
        const modelPath = path.resolve(baseDir, modelPaths[key])
        this.modelPaths[key] = modelPath
      }
    })
  }
  scanAll(): ModelLists {
    try {
      const model_settings: ModelLists = {
        embedding: [],
      }
      return model_settings
    } catch (ex) {
      fs.appendFileSync(path.join(path.dirname(this.configPath), 'debug.log'), `${ex}\r\n`)
      throw ex
    }
  }
  /**
   * Ensure a model directory exists and can be scanned. Creates it when missing
   * and writable; on a read-only tree (a shared, admin-provisioned model folder
   * on an all-users install) creation fails, so this reports the directory
   * unusable and callers treat it as empty instead of throwing.
   */
  private ensureDirReadable(dir: string): boolean {
    if (fs.existsSync(dir)) return true
    try {
      fs.mkdirSync(dir, { recursive: true })
      return true
    } catch {
      return false
    }
  }

  scanGGUFLLMModels() {
    const dir = this.modelPaths.ggufLLM
    if (!this.ensureDirReadable(dir)) return []
    console.log('getting models', dir)
    const modelsSet = fs
      .readdirSync(dir, { encoding: 'utf-8', recursive: true })
      .filter((pathName) => pathName.endsWith('.gguf'))
      .map((path) => path.replace('---', '/'))
      // Replace ALL backslashes (Windows): split GGUF models live in a subfolder
      // (e.g. `repo/Q5_K_M/model-00001-of-00002.gguf`) so a single replace would
      // leave nested separators and break downloaded-model detection.
      .map((path) => path.replace(/\\/g, '/'))
      .reduce((acc, pathname) => acc.add(pathname), new Set<string>())

    return [...modelsSet]
  }
  scanOpenVINOModels() {
    const dir = this.modelPaths.openvinoLLM
    if (!this.ensureDirReadable(dir)) return []
    console.log('getting models', dir)
    const modelsSet = fs
      .readdirSync(dir)
      .filter((subDir) => {
        const fullpath = path.join(dir, subDir)
        return fs.statSync(fullpath).isDirectory() && fs.existsSync(path.join(fullpath))
      })
      .map((subDir) => subDir.replace('---', '/'))
      .reduce((set, modelName) => set.add(modelName), new Set<string>())

    return [...modelsSet]
  }
  /**
   * List available ComfyUI models for a given model type (e.g. checkpoints, loras).
   * Returns relative paths from the type directory, using OS path separator (e.g. "SubDir\\model.safetensors").
   */
  scanComfyUIModels(modelType: string): string[] {
    const dir = (this.modelPaths as Record<string, string>)[modelType]
    if (!dir || !fs.existsSync(dir)) {
      return []
    }
    const baseDir = path.resolve(dir)
    const seen = new Set<string>()
    const walk = (currentDir: string, relativePrefix: string): void => {
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true })
      } catch (error) {
        console.error(`Failed to read model directory "${currentDir}"`, error)
        return
      }
      for (const ent of entries) {
        const fullPath = path.join(currentDir, ent.name)
        const relativePath = relativePrefix ? `${relativePrefix}${path.sep}${ent.name}` : ent.name
        if (ent.isDirectory()) {
          walk(fullPath, relativePath)
        } else if (ent.isFile()) {
          const normalized = relativePath.replace(/\//g, path.sep)
          seen.add(normalized)
        }
      }
    }
    walk(baseDir, '')
    return [...seen].sort()
  }

  /** Absolute directory for a scan target, or undefined when unconfigured. */
  private scanTargetDir(target: ModelScanTarget): string | undefined {
    const base = (this.modelPaths as Record<string, string>)[target.pathKey]
    if (!base) return undefined
    return target.subDir ? path.join(base, target.subDir) : base
  }

  /**
   * Recursive size and newest mtime of a model. Directory models (OpenVINO IR,
   * HuggingFace snapshots) are many files, and the management view reports one
   * size and one "modified" per model, so both are accumulated in a single walk.
   */
  private statModel(target: string): { sizeBytes: number; modifiedAt: number } {
    let sizeBytes = 0
    let modifiedAt = 0
    const visit = (entryPath: string) => {
      let stats: fs.Stats
      try {
        stats = fs.statSync(entryPath)
      } catch {
        // A file can vanish mid-scan (a download finishing, a user deleting);
        // skip it rather than failing the whole directory.
        return
      }
      modifiedAt = Math.max(modifiedAt, stats.mtimeMs)
      if (!stats.isDirectory()) {
        sizeBytes += stats.size
        return
      }
      let children: string[] = []
      try {
        children = fs.readdirSync(entryPath)
      } catch {
        return
      }
      for (const child of children) visit(path.join(entryPath, child))
    }
    visit(target)
    return { sizeBytes, modifiedAt }
  }

  /**
   * Scan every configured model directory, reporting each model's absolute path,
   * size and mtime alongside its name.
   *
   * The absolute path matters as much as the name: on-disk layout is not
   * derivable from a model name without duplicating the downloader's rules from
   * `service/utils.py` (`owner---repo` roots, flat `---` names for
   * faceswap/facerestore, `vit-base-nsfw-detector`, files vs directories). Having
   * the scan report the path it actually found means the renderer never
   * reconstructs one, and destructive actions only ever act on a real path.
   */
  scanModelLibrary(): ModelLibraryScan {
    const models: ScannedModel[] = []
    const failedPathKeys: string[] = []

    for (const target of MODEL_SCAN_TARGETS) {
      const dir = this.scanTargetDir(target)
      if (!dir || !fs.existsSync(dir)) continue
      try {
        for (const relativePath of this.listModelEntries(dir, target)) {
          const absolutePath = path.join(dir, relativePath)
          const isDirectory = target.entryKind === 'directory'
          const { sizeBytes, modifiedAt } = this.statModel(absolutePath)
          models.push({
            pathKey: target.pathKey,
            useCase: target.useCase,
            serviceBackend: target.serviceBackend,
            name: relativePath.split(path.sep).join('/'),
            absolutePath,
            sizeBytes,
            modifiedAt,
            isDirectory,
          })
        }
      } catch (error) {
        // One unreadable directory must not blank the whole table.
        console.error(`Failed to scan model directory "${dir}"`, error)
        if (!failedPathKeys.includes(target.pathKey)) failedPathKeys.push(target.pathKey)
      }
    }

    return { models, failedPathKeys }
  }

  /** Relative paths of the models in one scan target's directory. */
  private listModelEntries(dir: string, target: ModelScanTarget): string[] {
    if (target.entryKind === 'directory') {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    }
    const found: string[] = []
    const walk = (currentDir: string, prefix: string) => {
      for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        const relativePath = prefix ? path.join(prefix, entry.name) : entry.name
        if (entry.isDirectory()) {
          walk(path.join(currentDir, entry.name), relativePath)
        } else if (entry.isFile()) {
          if (target.extension && !entry.name.endsWith(target.extension)) continue
          found.push(relativePath)
        }
      }
    }
    walk(dir, '')
    return found
  }

  /**
   * Resolve a path the renderer wants to reveal or delete, and refuse anything
   * that does not sit strictly inside a configured model directory.
   *
   * Deletion is permanent, so this guard is the only thing between a bad path and
   * unrelated user files. It resolves symlinks before comparing, so a link inside
   * a model directory cannot be used to escape it, and it rejects the model
   * directories themselves — deleting one model must never wipe the library.
   */
  resolveModelPath(targetPath: string): { path: string } | { error: string } {
    if (!targetPath) return { error: 'No path given.' }
    let resolved: string
    try {
      resolved = fs.realpathSync(path.resolve(targetPath))
    } catch {
      return { error: `Path does not exist: ${targetPath}` }
    }
    for (const configuredDir of Object.values(this.modelPaths)) {
      if (!configuredDir) continue
      let root: string
      try {
        root = fs.realpathSync(path.resolve(configuredDir))
      } catch {
        continue
      }
      if (resolved === root) continue
      const relative = path.relative(root, resolved)
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return { path: resolved }
      }
    }
    return { error: `Path is outside the configured model directories: ${targetPath}` }
  }

  /**
   * Extra copies of a model that must go when it is deleted. `faceswap` and
   * `facerestore` weights are copied into ComfyUI's own model tree so the reactor
   * node can load them, so deleting only the storage copy would leave the model
   * working and reclaim half the space.
   */
  mirroredModelPaths(deletedPath: string, comfyUiModelsRoot: string | undefined): string[] {
    if (!comfyUiModelsRoot) return []
    const mirrors: string[] = []
    for (const [pathKey, comfyDirName] of Object.entries(COMFYUI_MIRRORED_PATH_KEYS)) {
      const storageDir = (this.modelPaths as Record<string, string>)[pathKey]
      if (!storageDir) continue
      const relative = path.relative(path.resolve(storageDir), deletedPath)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
      mirrors.push(path.join(comfyUiModelsRoot, comfyDirName, relative))
    }
    return mirrors
  }

  /**
   * Whether new models can be written into the configured model directories.
   * False when models live on a read-only shared location — e.g. an all-users
   * install whose model folder is a shared, admin-provisioned directory — so
   * the UI can disable downloads instead of failing mid-transfer. Probes the
   * nearest existing ancestor of the primary (GGUF LLM) model directory.
   */
  isModelDirWritable(): boolean {
    let dir = this.modelPaths.ggufLLM
    while (dir && !fs.existsSync(dir)) {
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    const probe = path.join(dir, `.aipg-write-probe-${process.pid}`)
    try {
      fs.writeFileSync(probe, '')
      fs.rmSync(probe, { force: true })
      return true
    } catch {
      return false
    }
  }

  scanEmbedding(): Model[] {
    const embeddingModels: Model[] = []
    llmBackendTypes.forEach((backend) => {
      // Cloud Mode is a remote backend with no local embedding directory.
      if (backend === 'cloud') return
      const dir = path.join(this.modelPaths.embedding, backend)
      if (!this.ensureDirReadable(dir)) return

      if (backend === 'llamaCPP') {
        // For llamaCPP: scan for .gguf files recursively (file-based models)
        fs.readdirSync(dir, { encoding: 'utf-8', recursive: true })
          .filter((pathName) => pathName.endsWith('.gguf'))
          .map((filePath) => filePath.replace('---', '/').replace(/\\/g, '/'))
          .forEach((modelPath) => {
            embeddingModels.push({
              name: modelPath,
              downloaded: true,
              type: 'embedding',
              default: false,
              backend: backend,
            })
          })
      } else {
        // For openVINO: scan directories (directory-based models)
        fs.readdirSync(dir).forEach((item) => {
          embeddingModels.push({
            name: item.replace('---', '/'),
            downloaded: true,
            type: 'embedding',
            default: false,
            backend: backend,
          })
        })
      }
    })
    return embeddingModels
  }
}
