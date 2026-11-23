import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  executeToolInRenderer,
  jsonResult,
  jsonSchemaParameters,
  textResult,
  type SkillSource,
} from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import { readGame, setGameIcon, updateGame } from '../games/gameLibrary.ts'
import { writeScaffold3d } from '../games/gameScaffold.ts'
import {
  ensureThreeLib,
  importGameModel,
  THREE_LIB_PATH,
  type ImportedModel,
} from '../games/gameModels.ts'
import { isGeneratedMedia, normalizeWorkspacePath } from '../generatedMedia.ts'
import { mediaToolNames } from './media.ts'
import type { AgentCapability, CapabilityHost } from './types.ts'
import {
  GAME_STUDIO_ID,
  GAME_STUDIO_QUICK_ID,
  OFFER_GAME_AGENT_TOOL,
} from '@/types/agentCapabilities'

// ── game-studio capability ───────────────────────────────────────────────────
//
// Mostly a workflow: grow the scaffold the game folder was created with
// (gameScaffold.ts) into a playable HTML5 game, illustrate it with `media`, and
// check each step with the browser tool's play-test probe. Enabling it pulls
// `media` and `web-debug` in (see `requires`), because the procedure is
// worthless without them.
//
// Skills are the right shape for that part: only the name and description sit in
// the system prompt, and the model reads the body when a request actually calls
// for a game.
//
// The one tool it does add is `game`, which writes the library card — title,
// description, icon. That is metadata about the folder the agent is working in, so
// no file tool can express it, and it is what the game library and the generated
// arcade page display.

// The media tools are named rather than assumed: with tool delegation off the
// turn ships `generateImage` / `editImage`, and a procedure that says to call
// `media` then sends the agent after a tool it does not have.
function gameStudioSkill(mediaTools: string[]): SkillSource {
  const MEDIA_TOOL = mediaTools.map((name) => `\`${name}\``).join(' / ')
  return {
    name: 'html-game-studio',
    description:
      'Turn the running scaffold in this workspace into a playable browser game (arcade, puzzle, ' +
      'platformer, 2D or 3D) with generated sprites and 3D models, play-testing it as you go.',
    body: [
      'The workspace already holds a game that runs:',
      '',
      '- `index.html` — the page: a full-window `<canvas id="game">` and a plain',
      '  `<script src="game.js">`.',
      '- `game.js` — a config block, game state, keyboard + pointer input, `update(dt)`, `draw()`,',
      '  a `requestAnimationFrame` loop, and a `window.__game` hook. Each part sits behind a',
      '  `// === name ===` marker: config, state, input, update, draw, loop, debug hook.',
      '',
      'Your job is to turn that into the game the user asked for, one section at a time. You are',
      'never writing a game from a blank file, and you should not try to.',
      '',
      'One workspace looks different: **no `game.js`**. Then `index.html` is a whole game already —',
      'written in one shot elsewhere and handed to you — and the request is a change to something',
      'that plays, not a game to build. The hand-over message that opens the conversation is all',
      'you are told about it; the file is the truth, so `read index.html` first, change it with',
      '`edit`, play-test. Keep it a single file, skip `design.md` unless what they want is big',
      'enough to need a plan, and do not lay the scaffold down over it or start the game again.',
      '',
      'Work in short cycles: one section, one `edit`, keep going. Do not compose code while you',
      'think — nothing you write there can be play-tested, and it is code you have to write twice.',
      'Think about *which* section to change next; write the code in the `edit` call itself.',
      '',
      'Your plan lives in `design.md`, not in your head. You write it first and keep it current,',
      'because thinking is switched off for the rest of the run as soon as that file exists: from',
      'then on the checklist in it is the only thing carrying the plan between steps.',
      '',
      'If the user asks for a single HTML file, build it here as `index.html` + `game.js` anyway,',
      'and inline the script into the page as your last step. Editing one section at a time is what',
      'makes the game come out working; a single file is a delivery format, not a way to work.',
      '',
      '## Procedure',
      '',
      '1. `read game.js`. It is short, and every edit below aims at one of its sections. (A 3D game',
      '   calls `game {"action":"add_threejs"}` first — see "3D games" below.)',
      '2. `write design.md` before any code, in this shape and under 40 lines:',
      '   - **Pitch** — the game in one sentence.',
      '   - **Mechanic** — what the player does, how they win, how they lose.',
      '   - **Controls** — key or pointer, one line.',
      '   - **Entities** — each one and the state it needs (player: x, y, vx, vy, angle; …).',
      '   - **Build order** — a `- [ ]` checklist, one line per `// === section ===` edit, in the',
      '     order you will make them.',
      '   - **Art** — the sprites and 3D models to generate at the end, one line each.',
      '   Then edit that checklist as you go: tick items off, add what you discover. It is the only',
      '   memory you keep between steps, so a stale checklist is a lost plan.',
      '3. Name it now, not at the end:',
      '   `game {"action":"set_metadata","name":"Space Dodger","description":"Dodge asteroids for',
      '   as long as you can."}` — a real title (2-4 words) and one sentence on how it plays. This',
      '   is the card the library shows, and doing it first means a run that stops early still',
      '   leaves a named game.',
      '4. Work down the build order in `design.md` with `edit` calls that replace one',
      '   `// === section ===` block at a time — the markers make the old text easy to match',
      '   exactly. Start with state and update (the mechanic), then draw. One section per call: a',
      '   reply carries one section comfortably and a whole file not at all.',
      '5. Play-test after every substantial edit: `browser {"action":"open","url":"index.html"}`,',
      '   then `browser {"action":"probe"}`. The probe answers in words — uncaught errors, whether',
      '   the loop is running, how much of the canvas is drawn on, which input events the page',
      '   listens for, what a keypress changes, and your `window.__game` values. Fix what its',
      '   verdict names before adding anything new.',
      '6. Keep `window.__game` pointing at the real state (phase/score/entity count) as you go: it',
      '   is how the probe can tell "something is drawn" from "the game is being played".',
      '7. Art last, once the mechanic plays. Use what the user attached before generating anything:',
      '   their files are under `attachments/` and referenced as `@attachments/<file>`, and art',
      '   they brought is the art they want (`<img src="attachments/ship.png">`). Generate the',
      `   rest with ${MEDIA_TOOL} — one call describing every sprite you need, since media calls`,
      '   are served one at a time — and then use the workspace-relative paths that call reports',
      '   under "savedFiles". Ask for sprites on a plain background, and when the tool lists a',
      '   Remove Background workflow, pass each sprite through it for a transparent PNG. Load',
      '   images before the first frame and keep the placeholder shape as a fallback, so a',
      '   missing asset degrades instead of throwing.',
      '8. Polish only then: score, sound (WebAudio, generated in code — no audio files), a',
      '   difficulty ramp, a title and game-over screen.',
      '9. Finish: a clean probe verdict, one `browser {"action":"screenshot"}` so the user can see',
      `   it, a square cover image — generate it with ${MEDIA_TOOL}, then pass a path from that`,
      '   result to `game {"action":"set_icon","path":"<the path it reported>"}` — and a sentence',
      '   telling the user the game is ready to play and can be saved to their library.',
      '',
      '## 3D games',
      '',
      'When the user asks for a 3D game, or for a 3D character, enemy or prop, render the game with',
      'three.js and make a generated 3D model its centrepiece. Generated images still fit next to it:',
      'sprites for towers or pickups, textures for the ground, a background, the cover.',
      '',
      '- Before your first edit, `game {"action":"add_threejs"}`. While `game.js` is still the',
      '  scaffold, it becomes a 3D one that already runs: renderer, camera, lights, a ground, input',
      '  as a point on the ground, an HTML `#hud` for text, and a `models` section. Then `read',
      '  game.js` and plan against those sections. Entities live on the ground as `{ x, z, object }`,',
      '  and `makeObject(kind)` gives you the object for one — a box until that kind has a model.',
      "- The canvas holds a WebGL context, so it can never get a 2D one: no `getContext('2d')`. Score,",
      '  lives and buttons go in HTML over it.',
      '- Play-test the mechanic with the boxes before any model exists.',
      `- The model comes once the game plays: concept art first, with ${MEDIA_TOOL} — one object,`,
      '  whole and centred, in a three-quarter view on a plain light background, with no ground,',
      '  shadow or text. Then the image-to-3D workflow the tool lists (for example Pixel3D-Trellis),',
      '  with that image as the source: no prompt needed, the game-ready variant is chosen for you,',
      '  and it takes several minutes. Then',
      '  `game {"action":"import_model","path":"<the .glb from savedFiles>","modelName":"enemy"}`',
      '  and do what it answers: a script tag at the `models:` comment in `index.html` and the name',
      '  on that kind in the `MODELS` map. Every `makeObject` of that kind is then the model.',
      '- One or two models per game: every conversion holds the GPU for minutes.',
      '- Keep `window.__game` on the game state (wave, lives, enemies alive): the probe can see that',
      '  pixels changed, but only your hook says whether the game is being played.',
      '',
      '## Rules of this workspace',
      '',
      '- One `edit` call per section. Every `oldText` in a call is matched against the file as it is',
      '  right now, all at once — a block cannot match text that another block in the same call',
      '  introduces, and a single block that misses rejects the whole call, including the blocks that',
      '  did match. To amend something you just wrote, read it back and send a new call.',
      '- Plain HTML, CSS and JavaScript. No build step, no package manager, no CDN: the preview',
      '  server has no internet, so a script tag pointing at a CDN leaves you with a blank page.',
      '  The one library on offer is three.js, which the `game` tool copies into the folder.',
      '- Classic scripts only — no `type="module"`, and no `fetch()` of a local file. The finished',
      '  game is opened as a `file://` page, where both are blocked: they would work in your',
      '  preview and break the moment the user hits Play.',
      '- Splitting further is fine (`enemies.js`, `style.css`) as long as `index.html` pulls them',
      '  in with a plain `<script src>` or `<link rel="stylesheet">`. Smaller files are easier to',
      '  edit precisely.',
      '',
      '## Pitfalls',
      '',
      '- Blank page: an uncaught error, usually in the first frame. Probe before changing code.',
      '- Do not read a screenshot back as an image. It is for the user; the probe already told you',
      '  what is on the page, in words, for a fraction of the cost.',
      '- Do not `alert()` or `prompt()`: they block the page and the browser tool with it.',
      '- Scale drawing off `canvas.width/height`, never hard-coded pixel sizes, or the game breaks',
      '  in a different window.',
      '- Delta-time the movement (the `dt` the loop already passes you); frame-count movement runs',
      '  at a different speed on every machine.',
      '- Media generation takes minutes. Play-test the mechanic with the placeholder shapes first.',
      `- Sprites and the cover come from ${MEDIA_TOOL} and from nowhere else. A path you did not`,
      '  get back from a call does not exist, and an image "written" with the shell is not a',
      '  picture — `set_icon` refuses both.',
      '- "The response hit the output token limit" means that one tool call was too long, not that',
      '  the game is too ambitious. Re-issue it as smaller `edit` calls.',
    ].join('\n'),
  }
}

const GAME_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['set_metadata', 'set_icon', 'add_threejs', 'import_model', 'get'],
      description:
        'set_metadata: set the title and/or description shown in the library; ' +
        'set_icon: use a generated image as the cover; add_threejs: copy three.js into the ' +
        'game for a 3D scene; import_model: make a generated .glb loadable by the game (adds ' +
        'three.js too); get: read the current card.',
    },
    name: { type: 'string', description: 'Title of the game (action=set_metadata).' },
    description: {
      type: 'string',
      description: 'One sentence on how the game plays (action=set_metadata).',
    },
    path: {
      type: 'string',
      description:
        'Workspace-relative file: the image to use as the cover (action=set_icon) or the .glb ' +
        'model to import (action=import_model). A path a media call reported under ' +
        '"savedFiles", or a file the user attached under "attachments/".',
    },
    modelName: {
      type: 'string',
      description:
        'What the game calls the model, e.g. "enemy" (action=import_model): lowercase letters, ' +
        'digits, - and _. The game loads it with THREE.loadGameModel("<modelName>").',
    },
  },
  required: ['action'],
}

type GameToolParams = {
  action: 'set_metadata' | 'set_icon' | 'add_threejs' | 'import_model' | 'get'
  name?: string
  description?: string
  path?: string
  modelName?: string
}

/**
 * Why this cover cannot be used, or nothing. A cover is a picture, and the only
 * things in a game folder that are pictures are what a media call produced and
 * what the user attached — so a path that is neither is a filename the model
 * made up, or a file it wrote itself after the first attempt failed. Saying so
 * is what turns that dead end back into the missing media call.
 */
function coverRefusal(host: CapabilityHost, iconPath: string): string | undefined {
  const normalized = normalizeWorkspacePath(iconPath)
  if (normalized.startsWith('attachments/')) return undefined
  if (isGeneratedMedia(host.workspaceDir, normalized)) return undefined
  const tools = mediaToolNames(host)
  const how =
    tools.length > 0
      ? `Generate one with ${tools.map((name) => `\`${name}\``).join(' / ')} and pass a path from its "savedFiles".`
      : 'This session has no media tool, so only a file the user attached can be the cover.'
  return (
    `'${iconPath}' is not an image this session produced. ${how} ` +
    'A file written with `write` or the shell is not a picture and cannot be the cover.'
  )
}

/** Why this model cannot be imported, or nothing — the same test as a cover. */
function modelRefusal(host: CapabilityHost, modelPath: string): string | undefined {
  const normalized = normalizeWorkspacePath(modelPath)
  if (normalized.startsWith('attachments/')) return undefined
  if (isGeneratedMedia(host.workspaceDir, normalized)) return undefined
  return (
    `'${modelPath}' is not a model this session produced. Convert concept art to 3D with the ` +
    'image-to-3D workflow of the media tool and pass the .glb path from its "savedFiles".'
  )
}

function threeSetupText(scaffold: 'written' | 'already-3d' | 'kept'): string {
  if (scaffold === 'kept') {
    return (
      `three.js is at ${THREE_LIB_PATH}. index.html and game.js were already changed, so they ` +
      `were left as they are: load it with <script src="${THREE_LIB_PATH}"></script> before ` +
      "game.js, and replace the canvas's getContext('2d') with new THREE.WebGLRenderer({ canvas, " +
      'antialias: true, preserveDrawingBuffer: true }) — a canvas cannot hold both kinds of context.'
    )
  }
  return [
    scaffold === 'written'
      ? 'The workspace now holds the 3D scaffold, already running: `read game.js` before editing it.'
      : 'The workspace already holds the 3D scaffold.',
    `three.js is loaded from ${THREE_LIB_PATH}. The sections: config; scene (renderer, camera, ` +
      'lights, ground, resize); models (the MODELS map, loaded before the first frame, and ' +
      'makeObject(kind), a box until the kind has a model); state; input (pointer is a point on ' +
      'the ground); update; draw (positions objects, renders, writes the #hud text); loop; debug ' +
      'hook. Entities live on the ground plane as { x, z, object }.',
  ].join('\n')
}

function importedModelText(imported: ImportedModel): string {
  const megabytes = (imported.bytes / 1048576).toFixed(1)
  return [
    `Imported '${imported.name}' (${megabytes} MB) as ${imported.modelScriptPath}; three.js is at ${imported.libPath}.`,
    `In the 3D scaffold: add <script src="${imported.modelScriptPath}"></script> to index.html at`,
    'its "models:" comment, then set name to ' +
      `'${imported.name}' on the matching entry of the MODELS map in game.js (add an entry if the`,
    'kind is new). makeObject(kind) then hands out fitted copies of the model instead of boxes.',
    `Without the scaffold: load ${imported.libPath} and then ${imported.modelScriptPath} with plain`,
    `script tags; THREE.loadGameModel('${imported.name}') resolves to the parsed glTF — fit it with`,
    'THREE.fitGameModel(gltf.scene, size), clone it per copy, and call',
    'THREE.addGameEnvironment(renderer, scene) once, or its metallic materials render black.',
  ].join('\n')
}

async function buildGameTool(host: CapabilityHost): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  return [
    pi.defineTool({
      name: 'game',
      label: 'game',
      description:
        "Describe the game in this workspace for the user's game library: its title, a " +
        'one-sentence description, and a cover image you generated. Also imports a generated ' +
        '3D model (.glb) so the game can load it with three.js.',
      parameters: jsonSchemaParameters(GAME_INPUT_SCHEMA),
      execute: async (_toolCallId, params) => {
        const { action, name, description, path: iconPath, modelName } = params as GameToolParams
        // The workspace IS the game folder for the Game Agent preset. Any other
        // workspace has no card to write, and saying so is more useful than a
        // filesystem error.
        if (!readGame(host.workspaceDir)) {
          return textResult(
            'This workspace is not a game folder, so it has no library card. Select the Game ' +
              'Agent preset to work on a game.',
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
            const refusal = coverRefusal(host, iconPath)
            if (refusal) return textResult(refusal)
            try {
              const game = setGameIcon(host.workspaceDir, iconPath)
              return textResult(`Cover image set to ${game.icon}.`)
            } catch (error) {
              return textResult(error instanceof Error ? error.message : String(error))
            }
          }
          case 'add_threejs': {
            let scaffold: ReturnType<typeof writeScaffold3d>
            try {
              ensureThreeLib(host.workspaceDir)
              scaffold = writeScaffold3d(host.workspaceDir)
            } catch (error) {
              return textResult(error instanceof Error ? error.message : String(error))
            }
            return textResult(threeSetupText(scaffold))
          }
          case 'import_model': {
            if (!iconPath || !modelName) {
              return textResult('Provide the path of the .glb and a modelName for the game.')
            }
            const refusal = modelRefusal(host, iconPath)
            if (refusal) return textResult(refusal)
            try {
              return textResult(
                importedModelText(importGameModel(host.workspaceDir, iconPath, modelName)),
              )
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
  id: GAME_STUDIO_ID,
  label: 'Game studio',
  summary:
    'Build playable browser games with generated art, then test them in the browser. Needs ' +
    'media generation and web debugging.',
  requires: ['media', 'web-debug'],
  buildSkills: (host) => [gameStudioSkill(mediaToolNames(host))],
  buildTools: buildGameTool,
  // The procedure is written around the media tool, so without one it would send
  // the agent after a tool that is not there. Speech specs ship separately, so
  // "any spec at all" is not the question — whether a media tool is among them is.
  unavailableReason: (host) =>
    mediaToolNames(host).length === 0
      ? 'Needs media generation — enable an image tool, or install a ComfyUI image workflow.'
      : undefined,
  // Nothing worth deferring: a skill costs one name + description line, and the
  // `game` tool is one small schema the closing step needs anyway.
  lazyEligible: false,
  planningEnd: 'plan-file',
}

// ── game-studio-quick capability ─────────────────────────────────────────────
//
// The other end of the trade: instead of growing a scaffold over dozens of steps
// the model writes the whole game once, into one file. Everything that makes the
// iterative path good — a skill to read, a browser to probe with, generated art
// — is context and wall clock the quick path spends on nothing, so it has none
// of it. What is left is a prompt, `write` and the same library card tool.
//
// It owns the session (`ownSession`): Pi's coding-agent prompt and its file and
// shell toolbox would each be larger than the instructions this run needs. That
// is also why it is not in the settings list — enabled next to a general agent
// it would silently take that agent's prompt and tools away.

export { GAME_STUDIO_QUICK_ID }

// The way out of a one-shot run. Quick Coder writes the game and cannot come
// back to it: with `write` as its only file tool it cannot read what it wrote,
// try it, or draw for it, and a "fix the collision" request can only be answered
// by writing the whole file again from memory. So it offers the switch instead,
// and the user decides — the offer is a question, not a preset change, because
// the two presets are a real trade (minutes against art and play-testing).

const OFFER_GAME_AGENT_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: {
      type: 'string',
      description:
        'What the user asked for, in one sentence and in their terms. It is shown to them on ' +
        'the offer, e.g. "the ship keeps moving after you let go of the key".',
    },
    summary: {
      type: 'string',
      description:
        'Two or three sentences for the agent taking over, which never sees this conversation: ' +
        'the game you wrote, its controls, the entities and their state, and anything you left ' +
        'unfinished or know to be shaky.',
    },
  },
  required: ['reason', 'summary'],
}

async function buildQuickTools(host: CapabilityHost): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  return [
    ...(await buildGameTool(host)),
    pi.defineTool({
      name: 'offer_game_agent',
      label: 'offer_game_agent',
      description:
        'Offer to hand this game over to Game Agent, which keeps the same folder but can read ' +
        'and edit the file you wrote, play-test it in a browser and generate art for it. Call ' +
        'this when the user reports a bug, asks to change a game that is already written, or ' +
        'asks for something you have no tool for. If they accept, Game Agent starts on their ' +
        'request itself, from the summary you send. The result says whether they accepted.',
      parameters: jsonSchemaParameters(OFFER_GAME_AGENT_INPUT_SCHEMA),
      execute: async (toolCallId, params, signal) => {
        const { reason, summary } = params as { reason?: string; summary?: string }
        // The offer is a card in the renderer's transcript and the switch is
        // Pinia state, so both live there (`storeTools` in agentModeTurn.ts).
        const result = await executeToolInRenderer(
          host.sessionId,
          OFFER_GAME_AGENT_TOOL,
          { reason: reason ?? '', summary: summary ?? '' },
          toolCallId,
          signal ?? undefined,
        )
        return jsonResult(result)
      },
    }) as ToolDefinition,
  ]
}

export const gameStudioQuickCapability: AgentCapability = {
  id: GAME_STUDIO_QUICK_ID,
  label: 'Game studio (one shot)',
  summary:
    'Write a whole browser game into a single HTML file in one step, then name it in the ' +
    'library. No art, no play-testing.',
  buildTools: buildQuickTools,
  // `write` puts the game on disk; nothing else in the builtin toolbox has a
  // part in a run that is one file long. `writableFiles` is what makes "one
  // file" true rather than merely asked for: the prompt says to put everything
  // in `index.html`, and a small model writes it and then a `game.js` beside it
  // anyway — leaving a game whose code never loads (the written page has no
  // `<script src>` for it) and a hand-off summary telling Game Agent the whole
  // game is in one file. Refusing the second write turns that into a correction
  // the model can act on inside the same turn.
  ownSession: { baseTools: ['write'], writableFiles: ['index.html'] },
  // The plan and the game arrive in one breath unless the turn is cut in two, and
  // a thinking switch that flips after the game is written has nothing left to
  // pay for. So the plan is asked for on its own and this approves it.
  planHandoff:
    'The plan is approved — build it. Send the whole game as one `write` to `index.html`, ' +
    'exactly as planned, then name it with the `game` tool. No restating the plan and no ' +
    'questions: the next thing you send is the file.',
  planningEnd: 'first-write',
  lazyEligible: false,
}
