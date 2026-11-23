import fs from 'node:fs'
import path from 'node:path'
import { externalResourcesDir } from '../../kernel/aipgRoot.ts'
import { normalizeWorkspacePath } from '../generatedMedia.ts'

// A generated 3D model, made loadable by a game that is played as a file:// page.
// Neither half works there as shipped: three.js is published as ES modules, and
// GLTFLoader fetch()es the .glb — both blocked on file://. So the game gets
// three.js as one classic script (built by build/scripts/build-game-three.mts)
// and each model as a classic script carrying the GLB bytes, which
// `THREE.loadGameModel(name)` decodes.

export const THREE_LIB_PATH = 'lib/three-game.js'
const BUNDLED_LIB = path.join('game-libs', 'three-game.js')
const MODEL_NAME = /^[a-z][a-z0-9_-]{0,39}$/
// Base64 grows a model by a third, and every byte is decoded before the first frame.
const MAX_MODEL_BYTES = 40 * 1024 * 1024

export type ImportedModel = {
  name: string
  modelScriptPath: string
  libPath: string
  bytes: number
}

function bundledThreeLib(): string {
  return path.join(externalResourcesDir(), BUNDLED_LIB)
}

function insideWorkspace(workspaceDir: string, relativePath: string): string {
  const root = path.resolve(workspaceDir)
  const target = path.resolve(root, relativePath)
  const relative = path.relative(root, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`'${relativePath}' is outside the game folder.`)
  }
  return target
}

/** Copies three.js into the game unless it already holds this exact build. */
export function ensureThreeLib(workspaceDir: string): void {
  const source = bundledThreeLib()
  if (!fs.existsSync(source)) {
    throw new Error('three.js is not bundled with this build of AI Playground.')
  }
  const target = path.join(workspaceDir, THREE_LIB_PATH)
  const current = fs.existsSync(target) ? fs.statSync(target).size : -1
  if (current === fs.statSync(source).size) return
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

export function importGameModel(
  workspaceDir: string,
  modelPath: string,
  name: string,
): ImportedModel {
  if (!MODEL_NAME.test(name)) {
    throw new Error(
      `'${name}' cannot be a model name: use lowercase letters, digits, - and _, starting with a letter.`,
    )
  }
  const normalized = normalizeWorkspacePath(modelPath)
  if (path.posix.extname(normalized).toLowerCase() !== '.glb') {
    throw new Error(`'${modelPath}' is not a .glb model.`)
  }
  const source = insideWorkspace(workspaceDir, normalized)
  if (!fs.existsSync(source)) throw new Error(`'${modelPath}' does not exist.`)
  const glb = fs.readFileSync(source)
  if (glb.length > MAX_MODEL_BYTES) {
    throw new Error(
      `'${modelPath}' is ${Math.round(glb.length / 1048576)} MB, too large to load in a game. ` +
        'Generate it again with the game-ready (Fast) variant of the 3D workflow.',
    )
  }

  ensureThreeLib(workspaceDir)
  const modelScriptPath = `models/${name}.js`
  const target = path.join(workspaceDir, modelScriptPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(
    target,
    `// ${normalized}, embedded so THREE.loadGameModel('${name}') works on a file:// page.\n` +
      `;(window.GAME_MODELS = window.GAME_MODELS || {})[${JSON.stringify(name)}] =\n` +
      `  '${glb.toString('base64')}'\n`,
  )
  return { name, modelScriptPath, libPath: THREE_LIB_PATH, bytes: glb.length }
}
