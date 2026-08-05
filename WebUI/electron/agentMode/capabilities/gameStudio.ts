import type { SkillSource } from '../piCustomTools.ts'
import type { AgentCapability } from './types.ts'

// ── game-studio capability ───────────────────────────────────────────────────
//
// No tools of its own: it teaches the workflow that ties the other capabilities
// together — write a playable HTML5 game with the file tools, illustrate it with
// `media`, then open it in the browser and fix what the console reports. Enabling
// it pulls `media` and `web-debug` in (see `requires`), because the procedure is
// worthless without them.
//
// Skills are the right shape for this: only the name and description sit in the
// system prompt, and the model reads the body when a request actually calls for a
// game (see docs/agent-capability-benchmark.md on why that is the cheap direction).

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
    '2. Write `index.html` with the whole game inside it: a `<canvas>` (or DOM elements), the',
    '   loop, input handling and drawing. `requestAnimationFrame` for the loop, keyboard AND',
    '   pointer input so it is playable on a laptop and a touchscreen.',
    '3. Generate the art with the `media` tool, one call per asset group, and use the',
    '   workspace-relative paths it reports under "savedFiles" (e.g.',
    '   `<img src="generated/AIPG_00001_.png">`). Ask for transparent-looking sprites on a plain',
    '   background; nothing here removes a background for you.',
    '4. Load images before the first frame and keep a plain-colour fallback for each, so a missing',
    '   asset degrades instead of throwing.',
    '5. Test it: `browser {"action":"open","url":"index.html"}`, then',
    '   `browser {"action":"console"}`. Fix every error, reload, repeat until the console is',
    '   clean. Use `browser {"action":"eval",...}` to poke at game state, and',
    '   `browser {"action":"screenshot"}` for a look at the result.',
    '6. Only then add polish: score, sound (WebAudio, generated in code — no audio files),',
    '   difficulty ramp, a title and game-over screen.',
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
  ].join('\n'),
}

export const gameStudioCapability: AgentCapability = {
  id: 'game-studio',
  label: 'Game studio',
  summary:
    'Build playable browser games with generated art, then test them in the browser. Needs ' +
    'media generation and web debugging.',
  requires: ['media', 'web-debug'],
  skills: [GAME_STUDIO_SKILL],
  // The procedure is written around the `media` tool, so without media workflows
  // it would send the agent after a tool that is not there.
  unavailableReason: (host) =>
    host.toolSpecs.length === 0
      ? 'Needs media generation — install a ComfyUI image workflow first.'
      : undefined,
  // Nothing to defer: a skills-only capability costs one name + description line.
  lazyEligible: false,
}
