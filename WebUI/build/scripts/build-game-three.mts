// Builds external/game-libs/three-game.js: three.js, its GLTFLoader and a few
// helpers as one classic script, which is what a Game Agent game can load. Games are played as
// file:// pages, where ES modules and fetch() of a sibling file are blocked, so
// neither the npm package nor a CDN module build would run there. Rerun after
// bumping `three` in package.json.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const webUiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const version = JSON.parse(
  readFileSync(path.join(webUiDir, 'node_modules', 'three', 'package.json'), 'utf-8'),
).version as string

const entry = `
import * as core from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

const THREE = Object.assign({}, core, { GLTFLoader, RoomEnvironment })

// Generated models carry metallic PBR materials, which reflect nothing and
// render black under plain lights; an environment map is what makes them read.
THREE.addGameEnvironment = function addGameEnvironment(renderer, scene) {
  const pmrem = new core.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  pmrem.dispose()
  return scene.environment
}

// Scales an object so its largest side is \`size\`, centred on x/z, feet on y = 0.
THREE.fitGameModel = function fitGameModel(object, size) {
  const box = new core.Box3().setFromObject(object)
  const extent = box.getSize(new core.Vector3())
  object.scale.multiplyScalar((size || 1) / Math.max(extent.x, extent.y, extent.z, 1e-6))
  box.setFromObject(object)
  const centre = box.getCenter(new core.Vector3())
  object.position.x -= centre.x
  object.position.z -= centre.z
  object.position.y -= box.min.y
  return object
}

// Models are shipped as models/<name>.js scripts that set GAME_MODELS[name] to
// base64 GLB bytes (the game tool's import_model action writes them).
THREE.loadGameModel = function loadGameModel(name) {
  const encoded = window.GAME_MODELS && window.GAME_MODELS[name]
  if (!encoded) {
    return Promise.reject(new Error('No model "' + name + '": is models/' + name + '.js loaded?'))
  }
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new GLTFLoader().parseAsync(bytes.buffer, '')
}

window.THREE = THREE
`

await build({
  stdin: { contents: entry, resolveDir: webUiDir, loader: 'js' },
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  legalComments: 'none',
  banner: {
    js: `/* three.js r${version.split('.')[1]} with GLTFLoader and RoomEnvironment, as a classic script. MIT License, Copyright 2010-2025 three.js authors. Built by build/scripts/build-game-three.mts. */`,
  },
  outfile: path.join(webUiDir, 'external', 'game-libs', 'three-game.js'),
})

console.log(`external/game-libs/three-game.js built from three ${version}`)
