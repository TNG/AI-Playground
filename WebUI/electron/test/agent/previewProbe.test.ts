import { describe, expect, it } from 'vitest'
import {
  formatProbeReport,
  injectProbe,
  PROBE_PATH,
  PROBE_SCRIPT,
  probeCall,
  type ProbeReport,
} from '../../agent/previewProbe.ts'

const TAG = `<script src="${PROBE_PATH}"></script>`

describe('injectProbe', () => {
  it('installs the probe before the page runs its own scripts', () => {
    const page = injectProbe('<html><head><title>Game</title></head><body></body></html>')

    expect(page.indexOf(TAG)).toBeLessThan(page.indexOf('<title>'))
  })

  it('copes with a page that has no head', () => {
    expect(injectProbe('<html><body><canvas></canvas></body></html>')).toContain(TAG)
    expect(injectProbe('<canvas></canvas>')).toContain(TAG)
  })

  it('injects exactly once, however the page is served again', () => {
    const once = injectProbe('<html><head></head></html>')

    expect(injectProbe(once)).toBe(once)
    expect(once.split(TAG)).toHaveLength(2)
  })

  it('keeps the page it was given', () => {
    const original = '<!doctype html>\n<html><head></head><body>hi</body></html>'

    expect(injectProbe(original).replace(`\n${TAG}`, '')).toBe(original)
  })
})

describe('the probe script', () => {
  // It is a string until a page evaluates it, so nothing else would catch a
  // typo in it before the agent's first play-test fails.
  it('is valid JavaScript', () => {
    expect(() => new Function(PROBE_SCRIPT)).not.toThrow()
  })

  it('installs itself only once per page', () => {
    expect(PROBE_SCRIPT).toContain('if (window.__aipgProbe) return')
  })

  // Key listeners are wrapped to count calls; a game that removes one must still
  // be able to, or a title-screen handler would keep firing during play.
  it('lets the game remove a key listener it added', () => {
    const rawAdd = EventTarget.prototype.addEventListener
    const rawRemove = EventTarget.prototype.removeEventListener
    try {
      const page = Object.assign(new EventTarget(), { requestAnimationFrame: () => 0 })
      new Function('window', PROBE_SCRIPT)(page)
      let calls = 0
      const onKey = () => calls++
      page.addEventListener('keydown', onKey)
      page.dispatchEvent(new Event('keydown'))
      page.removeEventListener('keydown', onKey)
      page.dispatchEvent(new Event('keydown'))
      expect(calls).toBe(1)
    } finally {
      EventTarget.prototype.addEventListener = rawAdd
      EventTarget.prototype.removeEventListener = rawRemove
    }
  })
})

const HEALTHY: ProbeReport = {
  installed: true,
  title: 'Space Dodger',
  frames: 31,
  seconds: 0.5,
  canvas: { count: 1, width: 1280, height: 800, ink: 0.12 },
  listeners: ['keydown', 'keyup', 'pointerdown', 'resize'],
  keys: [{ key: 'ArrowLeft', delta: 0.031 }],
  game: { state: 'playing', score: 42, entities: 7 },
  errors: [],
  errorCount: 0,
}

describe('probeCall', () => {
  it('presses the keys the agent chose, and the defaults otherwise', () => {
    expect(probeCall([' ', 'ArrowRight'])).toContain('__aipgProbe({"keys":[" ","ArrowRight"]})')
    expect(probeCall()).toContain('__aipgProbe({})')
  })
})

describe('formatProbeReport', () => {
  it('reports a working game as working', () => {
    const text = formatProbeReport(HEALTHY)

    expect(text).toContain('Errors: none')
    expect(text).toContain('31 frames in 0.5s (~62 fps)')
    expect(text).toContain('1280x800, 12.0% of pixels drawn on')
    expect(text).toContain('Input listeners: keydown, keyup, pointerdown')
    expect(text).toContain('Game hook: state=playing score=42 entities=7')
    expect(text).toContain('Verdict: running, drawing and listening for input.')
  })

  // A title screen that Space starts reads as "nothing happened" without this.
  it('says what each key press changed in the game hook', () => {
    const text = formatProbeReport({
      ...HEALTHY,
      game: { state: 'title', score: 0, entities: 0 },
      keys: [
        { key: ' ', delta: 0.4, game: { state: 'playing', score: 0, entities: 2 } },
        { key: 'ArrowLeft', delta: 0.02, game: { state: 'playing', score: 0, entities: 2 } },
      ],
    })
    expect(text).toContain(
      'Pressed Space: 40.0% of pixels changed; game hook state title→playing, entities 0→2',
    )
    expect(text).toMatch(/Pressed ArrowLeft: 2\.0% of pixels changed\n/)
    expect(text).toContain('Game hook: state=playing score=0 entities=2')
  })

  // A model that saw "0.0% changed" concluded the probe could not press keys and
  // stopped play-testing; saying the handler ran points it at the game instead.
  it('says when keys reached the game and changed nothing', () => {
    const text = formatProbeReport({
      ...HEALTHY,
      listeners: ['keydown', 'keyup'],
      game: { state: 'title', score: 0 },
      keys: [{ key: ' ', delta: 0, handled: 2, game: { state: 'title', score: 0 } }],
    })
    expect(text).toContain("Pressed Space: 0.0% of pixels changed; the page's key listeners ran 2×")
    expect(text).toMatch(/Verdict: Space reached the game's key listeners and changed nothing/)
    expect(text).toContain('if they should do something in state=title')
  })

  // A tower defence's Start button was wired by a <script> inside innerHTML,
  // which never runs; the agent started the game from eval and never noticed.
  it('calls out a Start button that does nothing', () => {
    const title = { state: 'title', score: 0 }
    const text = formatProbeReport({
      ...HEALTHY,
      game: title,
      keys: [{ key: ' ', delta: 0, handled: 1, game: title }],
      click: { label: 'Start Game', delta: 0, game: title },
    })
    expect(text).toContain('Clicked "Start Game": nothing changed')
    expect(text).toMatch(
      /Verdict: the "Start Game" button does nothing when clicked \(state stays title\)/,
    )
  })

  it('reports what a working Start button changed', () => {
    const text = formatProbeReport({
      ...HEALTHY,
      game: { state: 'title', score: 0 },
      keys: [{ key: ' ', delta: 0, handled: 1, game: { state: 'title', score: 0 } }],
      click: { label: 'Start Game', delta: 0.4, game: { state: 'playing', score: 0 } },
    })
    expect(text).toContain(
      'Clicked "Start Game": 40.0% of pixels changed; game hook state title→playing',
    )
    expect(text).toContain('Game hook: state=playing score=0')
    expect(text).toContain('Verdict: running, drawing and listening for input.')
  })

  it('does not fault a pointer game for ignoring keys', () => {
    const text = formatProbeReport({
      ...HEALTHY,
      listeners: ['keydown', 'pointerdown'],
      game: { state: 'playing', score: 0 },
      keys: [{ key: ' ', delta: 0, handled: 1, game: { state: 'playing', score: 0 } }],
    })
    expect(text).toMatch(/Verdict: running and drawing\. Space reached the key listeners/)
    expect(text).toContain('fine if the game is played with the pointer there')
  })

  it('does not call keys ignored when one of them did something', () => {
    const text = formatProbeReport({
      ...HEALTHY,
      game: { state: 'title', score: 0 },
      keys: [
        { key: 'ArrowLeft', delta: 0, handled: 2, game: { state: 'title', score: 0 } },
        { key: ' ', delta: 0, handled: 2, game: { state: 'playing', score: 0 } },
      ],
    })
    expect(text).toContain('Verdict: running, drawing and listening for input.')
  })

  // The tower-defence run's enemies bobbed by Math.sin(undefined): invisible, and
  // the canvas still read as 68% drawn because the ground filled it.
  it('calls out 3D objects three.js cannot draw', () => {
    const text = formatProbeReport({
      ...HEALTHY,
      scene: { objects: 12, broken: 4, inView: 8 },
    })
    expect(text).toContain(
      "3D scene: 12 objects, 8 in the camera's view, 4 with NaN in their transform or geometry",
    )
    expect(text).toMatch(/Verdict: 4 3D objects have NaN in their position, rotation, scale/)
  })

  // A 3D scene can be drawn and animated with the player behind the camera.
  it('calls out a player the camera does not see', () => {
    const text = formatProbeReport({
      ...HEALTHY,
      game: { state: 'playing', score: 3, entities: 4, playerOnScreen: false },
    })
    expect(text).toMatch(/Verdict: the player is outside the camera's view/)
  })

  it('leaves out the resize listener, which says nothing about playability', () => {
    expect(formatProbeReport(HEALTHY)).not.toContain('resize')
  })

  // The verdict names one thing to fix, and the order matters: an exception
  // explains a frozen loop, and a frozen loop explains a blank canvas, so
  // reporting the symptom first sends the model after the wrong bug.
  it('puts an exception ahead of everything it caused', () => {
    const text = formatProbeReport({
      ...HEALTHY,
      frames: 0,
      canvas: { count: 1, width: 1280, height: 800, ink: 0 },
      errors: ['TypeError: ship is undefined'],
      errorCount: 1,
    })

    expect(text).toContain('TypeError: ship is undefined')
    expect(text).toContain('Verdict: the page is throwing.')
  })

  it('calls out a loop that never ticked', () => {
    const text = formatProbeReport({ ...HEALTHY, frames: 0 })

    expect(text).toContain('no frames in 0.5s')
    expect(text).toContain('Verdict: nothing is animating.')
  })

  it('calls out a page that draws nothing', () => {
    const text = formatProbeReport({
      ...HEALTHY,
      canvas: { count: 1, width: 1280, height: 800, ink: 0 },
    })

    expect(text).toContain('Verdict: the canvas is effectively blank.')
  })

  it('calls out a game nobody can play', () => {
    const text = formatProbeReport({ ...HEALTHY, listeners: ['resize'] })

    expect(text).toContain('Input listeners: none')
    expect(text).toContain('Verdict: nothing listens for the keyboard.')
  })

  it('does not fault a game for skipping the optional hook', () => {
    const text = formatProbeReport({ ...HEALTHY, game: null })

    expect(text).toContain('window.__game is not defined')
    expect(text).toContain('Verdict: running, drawing and listening for input.')
  })

  it('says how to get a probe when the page was opened around the preview server', () => {
    expect(formatProbeReport({ installed: false })).toContain('preview server')
  })

  // WebGL pixels cannot be read back, and a game is not blank just because the
  // probe could not look.
  it('does not call an unreadable canvas blank', () => {
    const text = formatProbeReport({
      ...HEALTHY,
      canvas: { count: 1, width: 1280, height: 800, ink: null },
    })

    expect(text).toContain('pixels unreadable')
    expect(text).toContain('Verdict: running, drawing and listening for input.')
  })
})
