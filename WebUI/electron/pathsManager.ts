import fs from 'node:fs'
import path from 'node:path'
import type { ModelPaths, ModelLists } from '@/assets/js/store/models'
import { llmBackendTypes } from '../src/types/shared'

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
  }
  loadConfig() {
    this.initModelPaths(JSON.parse(fs.readFileSync(this.configPath).toString()) as ModelPaths)
  }
  updateModelPaths(modelPaths: ModelPaths) {
    this.initModelPaths(modelPaths)
    const workDir = process.cwd()
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
    // Initialize base paths
    Object.keys(this.modelPaths).forEach((key) => {
      if (key in modelPaths) {
        const modelPath = path.resolve(modelPaths[key])
        this.modelPaths[key] = modelPath
      }
    })
    // Copy all other paths (ComfyUI paths like lora, checkpoints, vae, etc.)
    Object.keys(modelPaths).forEach((key) => {
      if (!(key in this.modelPaths)) {
        const modelPath = path.resolve(modelPaths[key])
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
  scanGGUFLLMModels() {
    const dir = this.modelPaths.ggufLLM
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    console.log('getting models', dir)
    const modelsSet = fs
      .readdirSync(dir, { encoding: 'utf-8', recursive: true })
      .filter((pathName) => pathName.endsWith('.gguf'))
      .map((path) => path.replace('---', '/'))
      .map((path) => path.replace('\\', '/'))
      .reduce((acc, pathname) => acc.add(pathname), new Set<string>())

    return [...modelsSet]
  }
  scanOpenVINOModels() {
    const dir = this.modelPaths.openvinoLLM
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
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
  scanEmbedding(): Model[] {
    const embeddingModels: Model[] = []
    llmBackendTypes.forEach((backend) => {
      const dir = path.join(this.modelPaths.embedding, backend)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
        return
      }

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

  /**
   * Get mmproj files for a specific GGUF model
   * @param modelName - The model name (e.g., "namespace/repo/model.gguf")
   * @returns Array of mmproj file names found in the model's folder
   */
  getMmprojFilesForModel(modelName: string): string[] {
    const dir = this.modelPaths.ggufLLM

    if (!fs.existsSync(dir)) {
      console.error(`[PathsManager] ggufLLM directory ${dir} does not exist`)
      return []
    }

    // Model names use "/" as separator in the store, but on filesystem they might use "---" or OS separators
    // We need to find the actual file/folder structure
    // Strategy: recursively scan and find the actual file, then look for mmproj files in its folder

    try {
      const allFiles = fs.readdirSync(dir, { encoding: 'utf-8', recursive: true }) as string[]

      // Try multiple normalization strategies to match the file
      // Strategy 1: Replace / with OS separator
      const normalizedModelName1 = modelName.replace(/\//g, path.sep)
      // Strategy 2: Replace / with --- (HuggingFace repo naming convention)
      const normalizedModelName2 = modelName.replace(/\//g, '---')
      // Strategy 3: For Windows, replace / with \
      const normalizedModelName3 = modelName.replace(/\//g, '\\')

      let actualFilePath: string | undefined
      for (const file of allFiles) {
        // Normalize file path for comparison (use forward slashes)
        const normalizedFile = file.replace(/\\/g, '/')
        const modelNameWithSlash = modelName.replace(/\\/g, '/')

        // Try matching with various separators
        if (
          normalizedFile === modelNameWithSlash ||
          file === normalizedModelName1 ||
          file === normalizedModelName2 ||
          file === normalizedModelName3 ||
          // Also try matching after converting --- to /
          normalizedFile === modelNameWithSlash.replace(/---/g, '/') ||
          file.replace(/---/g, path.sep) === normalizedModelName1
        ) {
          actualFilePath = file
          break
        }
      }

      if (!actualFilePath) {
        console.error(`[PathsManager] Could not find model file: ${modelName}`)
        return []
      }

      // Get the folder containing the model file
      const fullPath = path.join(dir, actualFilePath)
      const modelFolder = path.dirname(fullPath)

      if (!fs.existsSync(modelFolder)) {
        return []
      }

      const files = fs.readdirSync(modelFolder)
      const mmprojFiles = files.filter(
        (file) => file.toLowerCase().includes('mmproj') && file.endsWith('.gguf'),
      )
      return mmprojFiles
    } catch (error) {
      console.error(`Error scanning mmproj files for ${modelName}:`, error)
      return []
    }
  }
}
