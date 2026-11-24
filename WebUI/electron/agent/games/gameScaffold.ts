import fs from 'node:fs'
import path from 'node:path'

// ── The starting point every game is built from ──────────────────────────────
//
// A new game folder does not start empty: it starts with a page that already
// runs. The agent's first act is then an `edit`, not a 500-line `write` that
// competes with its own output-token budget — the failure mode that used to
// cost whole attempts, and the reason its games came out smaller than the ones
// a plain chat writes in one reply.
//
// Two files, not one. `edit` matches on unique text, and a short file gives it
// far less to be ambiguous about; the sections below are marked so a model can
// replace one whole block at a time. Splitting is only safe because both are
// loaded with a CLASSIC script tag: the finished game is opened through
// `shell.openPath` as a file:// page, where ES modules and `fetch()` of a
// sibling file are blocked, so `type="module"` would work in the agent's
// preview (served over HTTP) and break the moment the user hits Play.
//
// `window.__game` at the bottom is what the play-test probe reads
// (`browser {"action":"probe"}`); it degrades to generic checks when a game
// drops it.

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>New game</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b1020; overflow: hidden; }
  canvas { display: block; width: 100vw; height: 100vh; touch-action: none; }
</style>
</head>
<body>
<canvas id="game"></canvas>
<!-- A classic script on purpose: this page is opened as a file:// page when the
     user plays it, and there ES modules and fetch() of a sibling file are blocked. -->
<script src="game.js"></script>
</body>
</html>
`

const GAME_JS = `// This game already runs: a canvas, an animation loop, keyboard and pointer
// input, and one thing moving on screen. Grow it by replacing a whole section
// between the "// === name ===" markers rather than rewriting the file.

// === config ===
const CONFIG = {
  background: '#0b1020',
  accent: '#4f8cff',
  playerSpeed: 420, // pixels per second, so movement is frame-rate independent
}

// === state ===
const canvas = document.getElementById('game')
const ctx = canvas.getContext('2d')

const game = {
  phase: 'playing', // 'title' | 'playing' | 'gameover'
  score: 0,
  time: 0,
  player: { x: 0, y: 0, radius: 16 },
  entities: [], // everything else the game moves and draws
}

function resize() {
  canvas.width = canvas.clientWidth
  canvas.height = canvas.clientHeight
}

function reset() {
  game.phase = 'playing'
  game.score = 0
  game.time = 0
  game.entities = []
  game.player.x = canvas.width / 2
  game.player.y = canvas.height / 2
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

// === input ===
const keys = new Set()
const pointer = { x: 0, y: 0, active: false }
const HELD_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ']

window.addEventListener('keydown', (event) => {
  keys.add(event.key)
  // Arrows and space scroll the page otherwise, which fights the game.
  if (HELD_KEYS.includes(event.key)) event.preventDefault()
})
window.addEventListener('keyup', (event) => keys.delete(event.key))

function trackPointer(event) {
  const bounds = canvas.getBoundingClientRect()
  pointer.x = event.clientX - bounds.left
  pointer.y = event.clientY - bounds.top
}

canvas.addEventListener('pointerdown', (event) => {
  pointer.active = true
  trackPointer(event)
})
canvas.addEventListener('pointermove', trackPointer)
window.addEventListener('pointerup', () => {
  pointer.active = false
})

// === update ===
function update(dt) {
  game.time += dt
  const step = CONFIG.playerSpeed * dt
  if (keys.has('ArrowLeft') || keys.has('a')) game.player.x -= step
  if (keys.has('ArrowRight') || keys.has('d')) game.player.x += step
  if (keys.has('ArrowUp') || keys.has('w')) game.player.y -= step
  if (keys.has('ArrowDown') || keys.has('s')) game.player.y += step
  // Touch and mouse: drift towards where the finger is, so it plays on a laptop
  // and on a touchscreen without a second control scheme.
  if (pointer.active) {
    const follow = Math.min(1, dt * 8)
    game.player.x += (pointer.x - game.player.x) * follow
    game.player.y += (pointer.y - game.player.y) * follow
  }
  const edge = game.player.radius
  game.player.x = clamp(game.player.x, edge, canvas.width - edge)
  game.player.y = clamp(game.player.y, edge, canvas.height - edge)
  game.score = Math.floor(game.time * 10)
}

// === draw ===
function draw() {
  ctx.fillStyle = CONFIG.background
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.fillStyle = CONFIG.accent
  ctx.beginPath()
  ctx.arc(game.player.x, game.player.y, game.player.radius, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#f2f4f8'
  ctx.font = '16px system-ui, sans-serif'
  ctx.fillText('Score ' + game.score, 16, 28)
}

// === loop ===
let lastFrame = performance.now()

function frame(now) {
  // Clamped at both ends: a hidden tab hands back a dt of several seconds, which
  // teleports everything through everything else on the first frame back, and
  // the first frame's timestamp can predate this script, giving a negative one.
  const dt = Math.min(Math.max((now - lastFrame) / 1000, 0), 0.05)
  lastFrame = now
  if (game.phase === 'playing') update(dt)
  draw()
  requestAnimationFrame(frame)
}

window.addEventListener('resize', resize)
resize()
reset()
requestAnimationFrame(frame)

// === debug hook ===
// Read by the app when it play-tests this game. Keep these pointing at the real
// state as the game grows; nothing the player sees depends on them.
window.__game = {
  get state() {
    return game.phase
  },
  get score() {
    return game.score
  },
  get entities() {
    return game.entities.length
  },
  reset,
}
`

// The same starting point for a 3D game, swapped in by the game tool's
// add_threejs while the 2D scaffold is still untouched. Getting from the 2D page
// to a working three.js one is where models went wrong: a canvas keeps the first
// kind of context it is asked for, so a leftover getContext('2d') leaves WebGL
// failing with "existing context of a different type".

const INDEX_HTML_3D = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>New game</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b1020; overflow: hidden; }
  canvas { display: block; width: 100vw; height: 100vh; touch-action: none; }
  #hud { position: fixed; top: 12px; left: 16px; color: #f2f4f8; font: 16px system-ui, sans-serif;
    pointer-events: none; text-shadow: 0 1px 2px #000; }
</style>
</head>
<body>
<canvas id="game"></canvas>
<div id="hud"></div>
<!-- Classic scripts on purpose: this page is opened as a file:// page when the
     user plays it, and there ES modules and fetch() of a sibling file are blocked. -->
<script src="lib/three-game.js"></script>
<!-- models: one <script src="models/<name>.js"></script> or sprites/<name>.js per import, here -->
<script src="game.js"></script>
</body>
</html>
`

const GAME_JS_3D = `// This game already runs in 3D: a three.js scene with a camera, lights and a
// ground, an animation loop, keyboard and pointer input, and a placeholder box
// for the player. Grow it by replacing a whole section between the
// "// === name ===" markers rather than rewriting the file.

// === config ===
const CONFIG = {
  background: 0x0b1020,
  ground: 0x1d2b3a,
  accent: 0x4f8cff,
  playerSpeed: 6, // world units per second, so movement is frame-rate independent
  arena: 10, // half the width of the playable ground
}

// === scene ===
const canvas = document.getElementById('game')
const hud = document.getElementById('hud')
// This canvas holds a WebGL context, so it can never have a 2D one: draw text in
// #hud. preserveDrawingBuffer is what lets the play-test probe see the frame.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
const scene = new THREE.Scene()
scene.background = new THREE.Color(CONFIG.background)
// Generated models have metallic materials that render black without this.
THREE.addGameEnvironment(renderer, scene)
const sun = new THREE.DirectionalLight(0xffffff, 1.5)
sun.position.set(5, 10, 5)
scene.add(sun)
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200)
camera.position.set(0, 12, 12)
camera.lookAt(0, 0, 0)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(CONFIG.arena * 2, CONFIG.arena * 2),
  new THREE.MeshStandardMaterial({ color: CONFIG.ground }),
)
ground.rotation.x = -Math.PI / 2
scene.add(ground)

function resize() {
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

// === models ===
// One entry per kind of object. name: a 3D model imported with the game tool's
// import_model; sprite: an image imported with import_sprite, drawn facing the
// camera. Add the script tag each import names to index.html. With neither, the
// kind is a box. size: its largest side in world units.
const MODELS = {
  player: { name: null, sprite: null, size: 1.5, color: CONFIG.accent },
}
const templates = {}
const missingSprites = new Set()

function loadModels() {
  return Promise.all(
    Object.entries(MODELS).map(([kind, spec]) =>
      spec.name
        ? THREE.loadGameModel(spec.name)
            .then((gltf) => {
              templates[kind] = THREE.fitGameModel(gltf.scene, spec.size)
            })
            .catch((error) => console.warn('Model ' + spec.name + ' failed, keeping a box:', error))
        : null,
    ),
  )
}

// A new object of this kind, standing on the ground at its origin. Wrapped in a
// group so setting its position never undoes the model's own centring.
function makeObject(kind) {
  const holder = new THREE.Group()
  const spec = MODELS[kind]
  if (templates[kind]) {
    holder.add(templates[kind].clone())
  } else if (spec && spec.sprite && window.GAME_SPRITES && window.GAME_SPRITES[spec.sprite]) {
    const sprite = THREE.makeGameSprite(spec.sprite, spec.size)
    sprite.position.y = spec.size / 2
    holder.add(sprite)
  } else {
    if (spec && spec.sprite && !missingSprites.has(spec.sprite)) {
      missingSprites.add(spec.sprite)
      console.warn('Sprite ' + spec.sprite + ' is not imported yet, using a box')
    }
    const size = spec ? spec.size : 1
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(size, size, size),
      new THREE.MeshStandardMaterial({ color: spec ? spec.color : 0xffffff }),
    )
    box.position.y = size / 2
    holder.add(box)
  }
  scene.add(holder)
  return holder
}

// === state ===
const game = {
  phase: 'playing', // 'title' | 'playing' | 'gameover'
  score: 0,
  time: 0,
  player: { x: 0, z: 0, object: null },
  entities: [], // everything else: { x, z, object }
}

function reset() {
  for (const entity of game.entities) scene.remove(entity.object)
  if (game.player.object) scene.remove(game.player.object)
  game.phase = 'playing'
  game.score = 0
  game.time = 0
  game.entities = []
  game.player.x = 0
  game.player.z = 0
  game.player.object = makeObject('player')
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

// === input ===
const keys = new Set()
const pointer = { x: 0, z: 0, active: false } // where it points on the ground
const HELD_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ']
const raycaster = new THREE.Raycaster()
const screenPoint = new THREE.Vector2()

window.addEventListener('keydown', (event) => {
  keys.add(event.key)
  // Arrows and space scroll the page otherwise, which fights the game.
  if (HELD_KEYS.includes(event.key)) event.preventDefault()
})
window.addEventListener('keyup', (event) => keys.delete(event.key))

function trackPointer(event) {
  const bounds = canvas.getBoundingClientRect()
  screenPoint.set(
    ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
    -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
  )
  raycaster.setFromCamera(screenPoint, camera)
  const hit = raycaster.intersectObject(ground)[0]
  if (hit) {
    pointer.x = hit.point.x
    pointer.z = hit.point.z
  }
}

canvas.addEventListener('pointerdown', (event) => {
  pointer.active = true
  trackPointer(event)
})
canvas.addEventListener('pointermove', trackPointer)
window.addEventListener('pointerup', () => {
  pointer.active = false
})

// === update ===
function update(dt) {
  game.time += dt
  const step = CONFIG.playerSpeed * dt
  if (keys.has('ArrowLeft') || keys.has('a')) game.player.x -= step
  if (keys.has('ArrowRight') || keys.has('d')) game.player.x += step
  if (keys.has('ArrowUp') || keys.has('w')) game.player.z -= step
  if (keys.has('ArrowDown') || keys.has('s')) game.player.z += step
  // Touch and mouse: drift towards where the pointer is on the ground.
  if (pointer.active) {
    const follow = Math.min(1, dt * 8)
    game.player.x += (pointer.x - game.player.x) * follow
    game.player.z += (pointer.z - game.player.z) * follow
  }
  game.player.x = clamp(game.player.x, -CONFIG.arena, CONFIG.arena)
  game.player.z = clamp(game.player.z, -CONFIG.arena, CONFIG.arena)
  game.score = Math.floor(game.time * 10)
}

// === draw ===
function draw() {
  game.player.object.position.set(game.player.x, 0, game.player.z)
  for (const entity of game.entities) entity.object.position.set(entity.x, 0, entity.z)
  renderer.render(scene, camera)
  hud.textContent = 'Score ' + game.score
}

// === loop ===
let lastFrame = performance.now()

function frame(now) {
  // Clamped at both ends: a hidden tab hands back a dt of several seconds, which
  // teleports everything through everything else on the first frame back, and
  // the first frame's timestamp can predate this script, giving a negative one.
  const dt = Math.min(Math.max((now - lastFrame) / 1000, 0), 0.05)
  lastFrame = now
  if (game.phase === 'playing') update(dt)
  draw()
  requestAnimationFrame(frame)
}

window.addEventListener('resize', resize)
resize()
loadModels().then(() => {
  reset()
  requestAnimationFrame(frame)
})

// === debug hook ===
// Read by the app when it play-tests this game. Keep these pointing at the real
// state as the game grows; nothing the player sees depends on them.
window.__game = {
  get state() {
    return game.phase
  },
  get score() {
    return game.score
  },
  get entities() {
    return game.entities.length
  },
  get models() {
    return Object.keys(templates)
  },
  // Whether the camera sees them: a scene can be drawn and animated with the
  // player out of view, and the probe has no other way to tell.
  get playerOnScreen() {
    return game.player.object ? onScreen(game.player.object) : false
  },
  get entitiesOnScreen() {
    const shown = game.entities.filter((entity) => onScreen(entity.object)).length
    return shown + ' of ' + game.entities.length
  },
  reset,
}

function onScreen(object) {
  camera.updateMatrixWorld()
  const view = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  return new THREE.Frustum().setFromProjectionMatrix(view).intersectsBox(new THREE.Box3().setFromObject(object))
}
`

/** The section markers `edit` calls are expected to aim at. */
export const SCAFFOLD_ANCHORS = [
  '// === config ===',
  '// === state ===',
  '// === input ===',
  '// === update ===',
  '// === draw ===',
  '// === loop ===',
  '// === debug hook ===',
] as const

export const SCAFFOLD_FILES: Record<string, string> = {
  'index.html': INDEX_HTML,
  'game.js': GAME_JS,
}

export const SCAFFOLD_3D_ANCHORS = [
  '// === config ===',
  '// === scene ===',
  '// === models ===',
  '// === state ===',
  '// === input ===',
  '// === update ===',
  '// === draw ===',
  '// === loop ===',
  '// === debug hook ===',
] as const

export const SCAFFOLD_3D_FILES: Record<string, string> = {
  'index.html': INDEX_HTML_3D,
  'game.js': GAME_JS_3D,
}

/**
 * Swap the untouched 2D scaffold for the 3D one. Only an untouched one: a file
 * that differs from what writeScaffold put there is work, and the agent turning
 * a game it already built into a 3D one has to do that by editing it.
 */
export function writeScaffold3d(dir: string): 'written' | 'already-3d' | 'kept' {
  const current = (name: string) => {
    try {
      return fs.readFileSync(path.join(dir, name), 'utf-8')
    } catch {
      return null
    }
  }
  const files = Object.keys(SCAFFOLD_FILES)
  if (files.every((name) => current(name) === SCAFFOLD_3D_FILES[name])) return 'already-3d'
  if (!files.every((name) => current(name) === SCAFFOLD_FILES[name])) return 'kept'
  for (const name of files) {
    fs.writeFileSync(path.join(dir, name), SCAFFOLD_3D_FILES[name], 'utf-8')
  }
  return 'written'
}

/**
 * Put the starting game into a folder. Never overwrites: a folder that already
 * holds an `index.html` is a game someone worked on, and replacing it with the
 * skeleton would throw that work away.
 */
export function writeScaffold(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, contents] of Object.entries(SCAFFOLD_FILES)) {
    const target = path.join(dir, name)
    if (fs.existsSync(target)) continue
    fs.writeFileSync(target, contents, 'utf-8')
  }
}
