import fs from 'fs'
import path from 'path'
import { test, expect } from './fixtures'
import { AppDriver } from './appDriver'
import { type GameSummary } from './pages/AgentModePage'
import { SCAFFOLD_FILES } from '../electron/gameScaffold'

// The two game-building agent presets, one test each. Both run on the Pi agent
// harness (not the chat harness the "Assistant" specs cover) and both own a
// managed game folder, so each test drives one real build turn and then asserts
// against the folder that turn produced — the agent's actual output, rather than
// whatever it said about it in the transcript.
//
// Scope: these prove a game gets BUILT, not that it plays well. Both presets are
// pinned to Qwen3.5-4B (AppDriver.AGENT_GAME_MODEL) rather than the big models
// they prefer, so the run stays cheap; a 4B model writes a rough game, and that
// is fine here. Nothing below inspects gameplay.
//
// What separates the two tests is what "built" means for each preset:
//
//  - Quick Coder gets an EMPTY folder (`scaffold: false` in agentMode.generate) and
//    `write` as its only file tool. So `index.html` existing at all is the proof,
//    and there is no `game.js`.
//  - Game Agent starts from the running scaffold (index.html + game.js) and edits it
//    section by section. So the proof is that the scaffold has *changed*.
//
// Each runs on llama.cpp or OpenVINO at random (AppDriver.pickRandomBackend);
// OpenVINO isn't offered in NVIDIA product mode, where the run falls back to
// llama.cpp. A preset not offered at all in the running product mode skips itself.

/** The one-line request both presets get — small enough for a 4B model to finish. */
const GAME_REQUEST = 'Make a one-button endless runner where I dodge asteroids.'

/** Read a file inside the produced game folder; '' when the agent never wrote it. */
function readGameFile(game: GameSummary, name: string): string {
  try {
    return fs.readFileSync(path.join(game.dir, name), 'utf-8')
  } catch {
    return ''
  }
}

test.describe('Game agent presets', () => {
  test('"Quick Coder" writes a game into one HTML file', async ({ app }) => {
    // Backend install plus one multi-step agent turn.
    test.setTimeout(AppDriver.AGENT_GAME_TIMEOUT + 20 * 60_000)

    await app.installAllBackends()

    const built = await app.runAgentGamePreset({ preset: 'Quick Coder', prompt: GAME_REQUEST })
    test.skip(built === null, 'Preset "Quick Coder" is not available in this product mode')
    const game = built as GameSummary

    const index = readGameFile(game, 'index.html')

    expect(
      index,
      'Quick Coder starts from an empty folder, so index.html exists only if it wrote one',
    ).not.toEqual('')
    expect(index, 'the written page should be an HTML document').toMatch(/<html[\s>]/i)
    expect(
      readGameFile(game, 'game.js'),
      'Quick Coder writes a single file — a game.js would mean it got the scaffold flow',
    ).toEqual('')

    await app.agent.expectGameBarNamed(game.name)
  })

  test('"Game Agent" turns the scaffold into a game', async ({ app }) => {
    // The longer one: this turn plans, edits and play-tests in a browser.
    test.setTimeout(AppDriver.AGENT_GAME_TIMEOUT + 20 * 60_000)

    await app.installAllBackends()

    const built = await app.runAgentGamePreset({ preset: 'Game Agent', prompt: GAME_REQUEST })
    test.skip(built === null, 'Preset "Game Agent" is not available in this product mode')
    const game = built as GameSummary

    const gameJs = readGameFile(game, 'game.js')
    const index = readGameFile(game, 'index.html')

    expect(gameJs, "the scaffold's game.js should still be there").not.toEqual('')
    expect(
      gameJs,
      'game.js is still the untouched scaffold — the agent never turned it into a game',
    ).not.toEqual(SCAFFOLD_FILES['game.js'])
    expect(index, 'the scaffold page should still load the game script').toMatch(/game\.js/)

    // Generated art is this preset's other headline capability, but it needs a
    // whole image generation on top of the build, so it is recorded rather than
    // required — the subject here is that a game was built.
    test.info().annotations.push({
      type: 'thumbnail',
      description: game.iconPath ? `generated: ${game.iconPath}` : 'none generated this run',
    })

    await app.agent.expectGameBarNamed(game.name)
  })
})
