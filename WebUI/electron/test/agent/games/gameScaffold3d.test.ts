import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SCAFFOLD_3D_ANCHORS,
  SCAFFOLD_3D_FILES,
  SCAFFOLD_FILES,
  writeScaffold,
  writeScaffold3d,
} from '../../../agent/games/gameScaffold.ts'

// The 3D scaffold is what a 3D game starts from once the agent asks for three.js:
// a page that already renders, so the model edits sections instead of working out
// how to turn the 2D canvas page into a WebGL one.

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-scaffold3d-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('3D game scaffold', () => {
  it('marks every section the agent is told to edit against', () => {
    const script = SCAFFOLD_3D_FILES['game.js']
    for (const anchor of SCAFFOLD_3D_ANCHORS) {
      expect(script.split(anchor), `${anchor} is not a unique edit target`).toHaveLength(2)
    }
  })

  // A canvas keeps the first kind of context it is asked for, and the probe can
  // only read a WebGL frame whose drawing buffer is preserved.
  it('renders through WebGL the probe can read, with no 2D context', () => {
    const script = SCAFFOLD_3D_FILES['game.js']
    expect(script).toContain('preserveDrawingBuffer: true')
    expect(script).not.toMatch(/getContext\(\s*['"]2d/)
    expect(script).toContain('THREE.addGameEnvironment(renderer, scene)')
  })

  it('loads three.js, then the models, then the game, as classic scripts', () => {
    const page = SCAFFOLD_3D_FILES['index.html']
    const lib = page.indexOf('<script src="lib/three-game.js"></script>')
    const models = page.indexOf('<!-- models:')
    const game = page.indexOf('<script src="game.js"></script>')
    expect(lib).toBeGreaterThan(-1)
    expect(lib).toBeLessThan(models)
    expect(models).toBeLessThan(game)
    expect(page).not.toContain('type="module"')
  })

  it('replaces only the untouched 2D scaffold', () => {
    writeScaffold(dir)
    expect(writeScaffold3d(dir)).toBe('written')
    expect(fs.readFileSync(path.join(dir, 'game.js'), 'utf-8')).toBe(SCAFFOLD_3D_FILES['game.js'])
    expect(writeScaffold3d(dir)).toBe('already-3d')
  })

  it('leaves a game the agent already changed alone', () => {
    writeScaffold(dir)
    fs.appendFileSync(path.join(dir, 'game.js'), '\n// the agent was here\n')
    expect(writeScaffold3d(dir)).toBe('kept')
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf-8')).toBe(
      SCAFFOLD_FILES['index.html'],
    )
  })
})
