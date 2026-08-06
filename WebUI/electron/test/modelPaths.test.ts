import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0-test' },
}))

const { PathsManager } = await import('../pathsManager')

let root: string
let configPath: string
let defaultsPath: string

const defaultConfig = () => ({
  ggufLLM: path.join(root, 'models', 'LLM', 'ggufLLM'),
  openvinoLLM: path.join(root, 'models', 'LLM', 'openvino'),
  embedding: path.join(root, 'models', 'LLM', 'embedding'),
  checkpoints: path.join(root, 'models', 'ComfyUI', 'checkpoints'),
  lora: path.join(root, 'models', 'ComfyUI', 'loras'),
})

const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, string>

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-paths-')))
  configPath = path.join(root, 'model_config.json')
  defaultsPath = path.join(root, 'model_config.defaults.json')
  fs.writeFileSync(configPath, JSON.stringify(defaultConfig()))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('PathsManager.updateModelPaths', () => {
  it('accepts a partial map and leaves the other directories alone', () => {
    const manager = new PathsManager(configPath)
    const before = { ...manager.modelPaths }

    // The old implementation read `modelPaths[key]` for every configured key, so
    // any partial map threw a TypeError on the first key it did not contain —
    // which is exactly what restorePathsSettings passed it.
    manager.updateModelPaths({ ggufLLM: path.join(root, 'elsewhere') })

    expect(manager.modelPaths.ggufLLM).toBe(path.join(root, 'elsewhere'))
    expect(manager.modelPaths.checkpoints).toBe(before.checkpoints)
    expect(readConfig().checkpoints).toBeDefined()
  })

  it('persists every configured directory, not just the changed one', () => {
    const manager = new PathsManager(configPath)

    manager.updateModelPaths({ lora: path.join(root, 'my-loras') })

    expect(Object.keys(readConfig()).sort()).toEqual(Object.keys(defaultConfig()).sort())
  })
})

describe('PathsManager default model paths', () => {
  it('snapshots the directories it first loaded', () => {
    new PathsManager(configPath)

    expect(fs.existsSync(defaultsPath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(defaultsPath, 'utf8'))).toEqual(defaultConfig())
  })

  it('does not overwrite an existing snapshot with edited paths', () => {
    const manager = new PathsManager(configPath)
    manager.updateModelPaths({ ggufLLM: path.join(root, 'moved') })

    // A second construction (app restart) must not capture the user's edits as
    // the new "defaults".
    new PathsManager(configPath)

    expect(JSON.parse(fs.readFileSync(defaultsPath, 'utf8')).ggufLLM).toBe(defaultConfig().ggufLLM)
  })

  it('restores every directory, including the ComfyUI ones', () => {
    const manager = new PathsManager(configPath)
    manager.updateModelPaths({
      ggufLLM: path.join(root, 'moved-gguf'),
      checkpoints: path.join(root, 'moved-checkpoints'),
      lora: path.join(root, 'moved-loras'),
    })

    manager.restoreDefaultModelPaths()

    // The old handler only ever reset the three LLM keys; the ComfyUI ones are
    // the reason it was worth fixing.
    expect(manager.modelPaths.ggufLLM).toBe(defaultConfig().ggufLLM)
    expect(manager.modelPaths.checkpoints).toBe(defaultConfig().checkpoints)
    expect(manager.modelPaths.lora).toBe(defaultConfig().lora)
  })

  it('leaves the paths untouched when there is no snapshot to restore', () => {
    const manager = new PathsManager(configPath)
    manager.updateModelPaths({ ggufLLM: path.join(root, 'moved') })
    fs.rmSync(defaultsPath)

    expect(manager.restoreDefaultModelPaths().ggufLLM).toBe(path.join(root, 'moved'))
  })
})
