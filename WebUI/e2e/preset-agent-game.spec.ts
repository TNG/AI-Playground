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
// The two differ in exactly the way their assertions do:
//
//  - Quick Coder gets an EMPTY folder (`scaffold: false` in agentMode.generate) and
//    `write` as its only file tool. So `index.html` existing at all is proof it
//    wrote the game, and there is no `game.js`.
//  - Game Agent starts from the running scaffold (index.html + game.js), edits it
//    section by section, play-tests it and draws a thumbnail. So the proof is that
//    the scaffold has *changed* and that art was generated and adopted.
//
// Each runs on llama.cpp or OpenVINO at random (AppDriver.pickRandomBackend);
// OpenVINO isn't offered in NVIDIA product mode, where the run falls back to
// llama.cpp. A preset not offered at all in the running product mode skips itself.

/** The one-line request both presets get — small enough to finish, real enough to need code. */
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
  test('"Quick Coder" writes a whole game into one HTML file', async ({ app }) => {
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
    expect(index, 'the written page should be a real HTML document').toMatch(/<html[\s>]/i)
    expect(index, 'a game written in one shot carries its own code, not just markup').toMatch(
      /<script[\s>]/i,
    )
    expect(
      readGameFile(game, 'game.js'),
      'Quick Coder writes a single file — a game.js would mean it got the scaffold flow',
    ).toEqual('')

    // The library card is the agent's own doing (the `game` tool's set_metadata);
    // the folder is minted under a provisional name taken from the request.
    expect(game.name.trim(), 'the agent should title the game in the library').not.toEqual('')
    await app.agent.expectGameBarNamed(game.name)
  })

  test('"Game Agent" builds on the scaffold and draws a thumbnail', async ({ app }) => {
    // The long one: this turn plans, edits, play-tests in a browser and generates art.
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
      'game.js is still the untouched scaffold — the agent never turned it into the requested game',
    ).not.toEqual(SCAFFOLD_FILES['game.js'])
    expect(index, 'the scaffold page should still load the game script').toMatch(/game\.js/)

    // Generated art is what separates this preset from Quick Coder: the media
    // capability draws the thumbnail and the `game` tool adopts it as the icon,
    // which is only reported once the file is really on disk (gameLibrary.toEntry).
    expect(
      game.iconPath,
      'Game Agent should generate a thumbnail and adopt it as the library icon',
    ).toBeTruthy()
    expect(fs.existsSync(String(game.iconPath)), 'the adopted icon should exist on disk').toBe(true)

    expect(game.name.trim(), 'the agent should title the game in the library').not.toEqual('')
    await app.agent.expectGameBarNamed(game.name)
  })
})
