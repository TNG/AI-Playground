import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { jsonSchemaParameters, textResult, type SkillSource } from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import { readGame, setGameIcon, updateGame } from '../../gameLibrary.ts'
import type { AgentCapability, CapabilityHost } from './types.ts'

// ── game-studio capability ───────────────────────────────────────────────────
//
// Mostly a workflow: write a playable HTML5 game with the file tools, illustrate
// it with `media`, then open it in the browser and fix what the console reports.
// Enabling it pulls `media` and `web-debug` in (see `requires`), because the
// procedure is worthless without them.
//
// Skills are the right shape for that part: only the name and description sit in
// the system prompt, and the model reads the body when a request actually calls
// for a game (see docs/agent-capability-benchmark.md on why that is the cheap
// direction).
//
// The one tool it does add is `game`, which writes the library card — title,
// description, icon. That is metadata about the folder the agent is working in, so
// no file tool can express it, and it is what the game library and the generated
// hub page display.

const GAME_STUDIO_SKILL: SkillSource = {
  name: 'html-game-studio',
  description:
    'Build a playable browser game (arcade, puzzle, platformer) as a single HTML file with ' +
    'generated art, then test it in the browser.',
  body: [
    'Build the game in the workspace as plain HTML + CSS + JavaScript — no build step, no',
    'package manager, no CDN: the preview server has no network access, so a script tag',
    'pointing at a CDN leaves you with a blank page.',
    '',
    '## Procedure',
    '',
    '1. Decide the mechanic first and write it down in one sentence (what the player does, how',
    '   they win, how they lose). Keep the first version small enough to finish.',
    '2. Build `index.html` in stages, never in one call. First `write` a skeleton that already',
    '   runs — a `<canvas>` (or DOM elements), a `requestAnimationFrame` loop, input handling and',
    '   one thing moving on screen — then grow it with `edit` calls that replace one function or',
    '   block at a time. Each reply has an output token limit, and a finished game written in a',
    '   single `write` gets cut off and rejected, costing you the whole attempt; a skeleton plus',
    '   edits never hits it. Handle keyboard AND pointer input so it is playable on a laptop and',
    '   a touchscreen.',
    '3. Use what the user attached before generating anything: files they add to the prompt are',
    '   saved under `attachments/` and referenced as `@attachments/<file>`. Art they brought is',
    '   the art they want, so reference it from the game (`<img src="attachments/ship.png">`)',
    '   instead of generating a replacement, and read a text file they attached before designing',
    '   around it.',
    '4. Generate any art they did not supply with the `media` tool, one call per asset group, and',
    '   use the',
    '   workspace-relative paths it reports under "savedFiles" (e.g.',
    '   `<img src="generated/AIPG_00001_.png">`). Ask for transparent-looking sprites on a plain',
    '   background; nothing here removes a background for you. Media calls are served one at a',
    '   time, so several calls at once finish no sooner than one after another — describe all the',
    '   sprites you need in a single request instead.',
    '5. Load images before the first frame and keep a plain-colour fallback for each, so a missing',
    '   asset degrades instead of throwing.',
    '6. Test it: `browser {"action":"open","url":"index.html"}`, then',
    '   `browser {"action":"console"}`. Fix every error, reload, repeat until the console is',
    '   clean. Use `browser {"action":"eval",...}` to poke at game state, and',
    '   `browser {"action":"screenshot"}` for a look at the result.',
    '7. Only then add polish: score, sound (WebAudio, generated in code — no audio files),',
    '   difficulty ramp, a title and game-over screen.',
    '8. Finish by filling in the library card, so the game shows up as a game and not as a',
    '   folder name:',
    '   - `game {"action":"set_metadata","name":"Space Dodger","description":"Dodge asteroids',
    '     for as long as you can."}` — a real title (2-4 words) and one sentence on how it plays.',
    '   - Generate a square cover image with the `media` tool, then',
    '     `game {"action":"set_icon","path":"generated/AIPG_00002_.png"}`.',
    '   Then tell the user the game is ready to play and can be saved to their library.',
    '',
    '## Pitfalls',
    '',
    '- Blank page: an uncaught error in the first frame. Read the console before changing code.',
    '- Do not `alert()` or `prompt()`: they block the page and the browser tool with it.',
    '- Scale drawing off `canvas.width/height`, never hard-coded pixel sizes, or the game breaks',
    '  in a different window.',
    '- Delta-time the movement (`dt` between frames); frame-count movement runs at a different',
    '  speed on every machine.',
    '- Media generation takes minutes. Write and test the game logic with placeholder rectangles',
    '  first, then swap in the generated art.',
    '- "The response hit the output token limit" means that one tool call was too long, not that',
    '  the game is too ambitious. Re-issue it as a smaller `write` followed by `edit` calls.',
  ].join('\n'),
}

const GAME_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['set_metadata', 'set_icon', 'get'],
      description:
        'set_metadata: set the title and/or description shown in the library; ' +
        'set_icon: use a generated image as the cover; get: read the current card.',
    },
    name: { type: 'string', description: 'Title of the game (action=set_metadata).' },
    description: {
      type: 'string',
      description: 'One sentence on how the game plays (action=set_metadata).',
    },
    path: {
      type: 'string',
      description:
        'Workspace-relative image to use as the cover, e.g. "generated/AIPG_00001_.png" ' +
        '(action=set_icon).',
    },
  },
  required: ['action'],
}

type GameToolParams = {
  action: 'set_metadata' | 'set_icon' | 'get'
  name?: string
  description?: string
  path?: string
}

async function buildGameTool(host: CapabilityHost): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  return [
    pi.defineTool({
      name: 'game',
      label: 'game',
      description:
        "Describe the game in this workspace for the user's game library: its title, a " +
        'one-sentence description, and a cover image you generated. Call it once the game runs.',
      parameters: jsonSchemaParameters(GAME_INPUT_SCHEMA),
      execute: async (_toolCallId, params) => {
        const { action, name, description, path: iconPath } = params as GameToolParams
        // The workspace IS the game folder for the Game Maker preset. Any other
        // workspace has no card to write, and saying so is more useful than a
        // filesystem error.
        if (!readGame(host.workspaceDir)) {
          return textResult(
            'This workspace is not a game folder, so it has no library card. Select the Game ' +
              'Maker preset to work on a game.',
          )
        }
        switch (action) {
          case 'set_metadata': {
            if (!name?.trim() && description === undefined) {
              return textResult('Provide a name and/or a description.')
            }
            const game = updateGame(host.workspaceDir, {
              ...(name?.trim() ? { name: name.trim() } : {}),
              ...(description !== undefined ? { description } : {}),
            })
            return textResult(`Library card updated: ${game.name} — ${game.description}`)
          }
          case 'set_icon': {
            if (!iconPath) return textResult('Provide the path of the image to use as the cover.')
            try {
              const game = setGameIcon(host.workspaceDir, iconPath)
              return textResult(`Cover image set to ${game.icon}.`)
            } catch (error) {
              return textResult(error instanceof Error ? error.message : String(error))
            }
          }
          default: {
            const game = readGame(host.workspaceDir)
            return textResult(
              `name: ${game?.name}\ndescription: ${game?.description || '(none)'}\nicon: ${
                game?.icon ?? '(none)'
              }\nsaved to library: ${game?.published ? 'yes' : 'not yet'}`,
            )
          }
        }
      },
    }) as ToolDefinition,
  ]
}

export const gameStudioCapability: AgentCapability = {
  id: 'game-studio',
  label: 'Game studio',
  summary:
    'Build playable browser games with generated art, then test them in the browser. Needs ' +
    'media generation and web debugging.',
  requires: ['media', 'web-debug'],
  skills: [GAME_STUDIO_SKILL],
  buildTools: buildGameTool,
  // The procedure is written around the `media` tool, so without media workflows
  // it would send the agent after a tool that is not there.
  unavailableReason: (host) =>
    host.toolSpecs.length === 0
      ? 'Needs media generation — install a ComfyUI image workflow first.'
      : undefined,
  // Nothing worth deferring: a skill costs one name + description line, and the
  // `game` tool is one small schema the closing step needs anyway.
  lazyEligible: false,
}
