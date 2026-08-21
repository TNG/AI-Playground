/**
 * The requests the speculative-decoding benchmark replays.
 *
 * They are one real Quick Coder run, taken apart: the brief the user sent,
 * the plan the model answered with, and the handoff the app sends back to start
 * the build. Every arm of the sweep sends these same bytes, so the only thing
 * that differs between arms is how fast the server produces the answer.
 *
 * The system prompt is built through Pi rather than pasted, because Quick is an
 * `ownSession` capability: `piAgentManager.createSession` hands Pi a
 * `systemPromptOverride` plus an empty `appendSystemPromptOverride` and turns
 * context files off, which strips Pi's own coding-agent preamble. Building the
 * session here the same way keeps the fixture honest if any of that changes.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type AgentSession,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { writeScaffold } from '../../../electron/gameScaffold.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../../..')
const QUICK_PRESET = path.join(REPO_ROOT, 'modes/base/presets/quick-coder.json')
const GAME_PRESET = path.join(REPO_ROOT, 'modes/base/presets/game-agent.json')

const PROVIDER = 'spec-bench'

/**
 * Recorded from `quick-split-20260819-1538`, brief `dodger`
 * (Pi session `2026-08-19T13-38-39-200Z_01a01a3e…`), verbatim including the
 * batch harness's sentence about image workflows — a shorter brief would be a
 * different workload, and the point is to replay traffic the app really sent.
 */
export const RECORDED = {
  brief:
    'A dodger where you slide a ship left and right to avoid falling rocks, with a score that ' +
    'counts survived seconds. For every image (cover and sprites), use only the "Draft Image" ' +
    'workflow.',
  plan: [
    '',
    '',
    '**Plan — Rockslide**',
    '',
    '- **Mechanic:** You slide a ship left/right along the bottom of the screen while rocks rain' +
      ' down from above; pure dodging, no shooting.',
    "- **Win:** There's no win state — the goal is the highest survived time; score is elapsed" +
      ' seconds, shown live.',
    '- **Lose:** Ship touches a rock → game over; press Space (or click/tap) to restart from' +
      ' score 0.',
    '- **Controls:** ← / → or A / D to move; pointer/touch drag to slide the ship too.',
    '- **Entities & state:**',
    '  - `player`: x, y, w, h, targetX (ship eases toward targetX for a smooth slide feel), tilt' +
      ' for visuals',
    '  - `rock` (array): x, y, r, vy, rotation, spin',
    '  - spawner: `timer`, interval that shrinks and base rock speed that grows with elapsed time',
    '  - `score`: seconds survived (float, displayed to 1 decimal); `best`: session best',
    '  - `state`: "ready" → "playing" → "gameover"',
    '- **Rendering:** Everything drawn with canvas calls (ship triangle, polygonal rocks,' +
      ' starfield backdrop) sized off `canvas.width`/`canvas.height`; delta-time movement in a' +
      ' `requestAnimationFrame` loop; single-file `index.html`, classic script, no network' +
      ' requests.',
    '- **Cover:** Generated via the Draft Image workflow as the library cover image; in-game' +
      ' sprites stay canvas-drawn.',
    '',
    'Waiting on approval before writing the game.',
  ].join('\n'),
  /** What `handOffToBuild` sends as the second prompt of the split turn. */
  handoff:
    'The plan is approved — build it. Send the whole game as one `write` to `index.html`, ' +
    'exactly as planned, then name it with the `game` tool. No restating the plan and no ' +
    'questions: the next thing you send is the file.',
}

/**
 * The `game` tool's schema, copied from
 * `electron/agentMode/capabilities/gameStudio.ts` (which cannot be imported here
 * — it pulls in `electron`). Only its size and shape matter, but keep it in sync.
 */
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

const GAME_DESCRIPTION =
  "Describe the game in this workspace for the user's game library: its title, a " +
  'one-sentence description, and a cover image you generated. Call it once the game runs.'

export type OpenAiTool = {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

export type QuickFixture = {
  systemPrompt: string
  tools: OpenAiTool[]
  brief: string
  plan: string
  handoff: string
}

function presetSystemPrompt(preset: string): string {
  const parsed = JSON.parse(fs.readFileSync(preset, 'utf8')) as { systemPrompt?: string }
  const prompt = parsed.systemPrompt?.trim()
  if (!prompt) throw new Error(`no systemPrompt in ${preset}`)
  return prompt
}

function toOpenAiTools(definitions: ToolDefinition[]): OpenAiTool[] {
  return definitions.map((definition) => ({
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description,
      // Pi parameters are TypeBox schemas, which ARE JSON Schema objects.
      parameters: definition.parameters as unknown,
    },
  }))
}

/** Pi keeps the composed prompt on the agent state; typed loosely on purpose. */
function systemPromptOf(session: AgentSession): string {
  const state = (session.agent as unknown as { state?: { systemPrompt?: string } }).state
  const prompt = state?.systemPrompt
  if (!prompt) throw new Error('Pi session exposed no system prompt')
  return prompt
}

/**
 * Build the session Quick runs in and read its prompt and tools back out.
 * Nothing is prompted through Pi; it is used only as the authority on what the
 * model actually sees.
 */
export async function buildQuickFixture(model: string): Promise<QuickFixture> {
  const built = await composePrompt({
    model,
    // Fixed rather than random: Pi ends the prompt with "Current working
    // directory: <cwd>", so a temp name with random characters in it would
    // change the prompt's token count from run to run.
    gameDir: 'rockslide',
    tools: (workspaceDir) => [
      // Quick's toolbox: Pi's `write` (kept by `ownSession.baseTools`) plus the
      // capability's own `game` tool.
      createWriteToolDefinition(workspaceDir) as ToolDefinition,
      gameTool(),
    ],
    // Quick is an `ownSession` capability, so its preset text replaces Pi's own
    // preamble rather than being appended to it.
    ownPrompt: presetSystemPrompt(QUICK_PRESET),
  })

  return {
    systemPrompt: built.systemPrompt,
    tools: built.tools,
    brief: RECORDED.brief,
    plan: RECORDED.plan,
    handoff: RECORDED.handoff,
  }
}

function gameTool(): ToolDefinition {
  return defineTool({
    name: 'game',
    label: 'game',
    description: GAME_DESCRIPTION,
    parameters: Type.Unsafe(GAME_INPUT_SCHEMA),
    execute: async () => ({ content: [{ type: 'text', text: '' }], details: undefined }),
  }) as ToolDefinition
}

/**
 * Build a Pi session the way `piAgentManager.createSession` does and read its
 * prompt and tools back out. Nothing is prompted through Pi; it is used only as
 * the authority on what the model actually sees.
 *
 * `ownPrompt` picks the two shapes the app has: an `ownSession` capability
 * (Quick) replaces Pi's preamble, while an ordinary preset (the regular Game
 * Agent) keeps it and appends its own instructions.
 */
async function composePrompt(options: {
  model: string
  gameDir: string
  tools: (workspaceDir: string) => ToolDefinition[]
  ownPrompt?: string
  appendPrompt?: string[]
  seed?: (workspaceDir: string) => void
}): Promise<{ systemPrompt: string; tools: OpenAiTool[] }> {
  const { model } = options
  const root = path.join(os.tmpdir(), 'aipg-spec-fixture')
  const workspaceDir = path.join(root, 'games', options.gameDir)
  const agentDir = path.join(root, 'agent')
  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  options.seed?.(workspaceDir)

  const models = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: null,
  })
  models.registerProvider(PROVIDER, {
    name: 'spec bench llama.cpp',
    baseUrl: 'http://127.0.0.1:1/v1',
    api: 'openai-completions',
    apiKey: 'unused',
    models: [
      {
        id: model,
        name: model,
        reasoning: false,
        input: ['text'],
        contextWindow: 32768,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      },
    ],
  })
  await models.setRuntimeApiKey(PROVIDER, 'unused')
  const registered = models.getModel(PROVIDER, model)
  if (!registered) throw new Error('failed to register the bench model with Pi')

  const tools = options.tools(workspaceDir)
  const { ownPrompt } = options
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir,
    noExtensions: true,
    noThemes: true,
    noPromptTemplates: true,
    noSkills: true,
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    ...(ownPrompt
      ? {
          systemPromptOverride: () => ownPrompt,
          appendSystemPromptOverride: () => [],
          noContextFiles: true,
        }
      : {}),
    ...(options.appendPrompt ? { appendSystemPrompt: options.appendPrompt } : {}),
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd: workspaceDir,
    agentDir,
    model: registered,
    modelRuntime: models,
    sessionManager: SessionManager.inMemory(workspaceDir),
    settingsManager: SettingsManager.inMemory(),
    noTools: 'builtin',
    customTools: tools,
    resourceLoader,
  })
  session.setActiveToolsByName(tools.map((tool) => tool.name))
  const systemPrompt = systemPromptOf(session)
  session.dispose()
  fs.rmSync(root, { recursive: true, force: true })

  return { systemPrompt, tools: toOpenAiTools(tools) }
}

// ── The edit workload ───────────────────────────────────────────────────────
//
// The regular Game Agent spends its turns replacing one `// === section ===`
// block of `game.js` at a time, so every `edit` call quotes a chunk of the file
// verbatim before writing the new version. That is the case n-gram drafting is
// supposed to win: the tokens it must produce are already sitting in the
// prompt. Quick's `write` workload has no such overlap, which is why MTP alone
// looked unbeatable there.
//
// The turns are *replayed*, not free-run: each measured step sends a recorded
// prefix and asks only for the next assistant turn. A free-running loop would
// let a faster arm wander into different work and make the arms
// incomparable — `ngram-simple` already showed it can produce different output
// from the same prompt.

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export type EditStep = {
  /** What the recorded turn edited, for the report. */
  label: string
  messages: ChatMessage[]
}

export type EditFixture = {
  systemPrompt: string
  tools: OpenAiTool[]
  steps: EditStep[]
}

export async function buildEditFixture(options: {
  model: string
  session: string
  steps: number
}): Promise<EditFixture> {
  const built = await composePrompt({
    model: options.model,
    gameDir: 'pong',
    // The scaffold is what the agent reads and edits, and Pi's read/edit tools
    // describe themselves relative to a real directory.
    seed: (workspaceDir) => writeScaffold(workspaceDir),
    tools: (workspaceDir) => [
      createReadToolDefinition(workspaceDir) as ToolDefinition,
      createWriteToolDefinition(workspaceDir) as ToolDefinition,
      createEditToolDefinition(workspaceDir) as ToolDefinition,
      gameTool(),
    ],
    // An ordinary preset: Pi's coding-agent preamble stays and the preset's
    // instructions are appended, the way `createSession` does it without
    // `ownSession`.
    appendPrompt: [presetSystemPrompt(GAME_PRESET)],
  })

  return {
    systemPrompt: built.systemPrompt,
    tools: built.tools,
    steps: editStepsFromSession(options.session, options.steps),
  }
}

/**
 * Turn a recorded Game Agent session into replayable prefixes: one per
 * assistant turn that called `edit`, containing everything the model had seen
 * up to that point.
 *
 * Recorded thinking is dropped, matching what the app sends back — the Qwen
 * template does not replay previous reasoning.
 */
export function editStepsFromSession(sessionFile: string, wanted: number): EditStep[] {
  type Part = {
    type: string
    text?: string
    id?: string
    name?: string
    arguments?: unknown
  }
  type Recorded = {
    role: string
    content?: Part[]
    toolCallId?: string
    toolName?: string
  }

  const recorded = fs
    .readFileSync(sessionFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { type?: string; message?: Recorded })
    .filter((entry) => entry.type === 'message' && entry.message !== undefined)
    .map((entry) => entry.message as Recorded)

  const steps: EditStep[] = []
  const sent: ChatMessage[] = []
  for (const message of recorded) {
    const parts = message.content ?? []
    const calls = parts.filter((part) => part.type === 'toolCall')
    const text = parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('')

    if (message.role === 'assistant') {
      const edits = calls.filter((call) => call.name === 'edit')
      if (edits.length > 0) {
        steps.push({ label: editLabel(edits[0]), messages: sent.map((entry) => ({ ...entry })) })
        if (steps.length >= wanted) return steps
      }
      sent.push({
        role: 'assistant',
        content: text,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((call) => ({
                id: call.id ?? '',
                type: 'function' as const,
                function: {
                  name: call.name ?? '',
                  arguments: JSON.stringify(call.arguments ?? {}),
                },
              })),
            }
          : {}),
      })
      continue
    }
    if (message.role === 'toolResult') {
      sent.push({ role: 'tool', tool_call_id: message.toolCallId ?? '', content: text })
      continue
    }
    if (message.role === 'user') sent.push({ role: 'user', content: text })
  }

  if (steps.length === 0) throw new Error(`${sessionFile} has no edit turns to replay`)
  return steps
}

function editLabel(call: { arguments?: unknown }): string {
  const args = (call.arguments ?? {}) as { path?: string; edits?: Array<{ oldText?: string }> }
  const first = args.edits?.[0]?.oldText ?? ''
  const section = /\/\/ === ([\w -]+) ===/.exec(first)?.[1]
  return section ? `${args.path ?? 'file'}:${section}` : (args.path ?? 'file')
}

/**
 * Re-derive brief/plan/handoff from another recorded Pi session, so a different
 * run can be replayed without editing this file.
 */
export function fixtureFromSession(
  sessionFile: string,
): Pick<QuickFixture, 'brief' | 'plan' | 'handoff'> {
  type Part = { type: string; text?: string }
  type Entry = { type?: string; message?: { role: string; content?: Part[] } }
  const messages = fs
    .readFileSync(sessionFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Entry)
    .filter((entry) => entry.type === 'message')
    .map((entry) => entry.message)
    .filter((message): message is NonNullable<Entry['message']> => message !== undefined)

  const textOf = (index: number): string =>
    (messages[index]?.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('')

  const brief = textOf(0)
  const plan = textOf(1)
  const handoff = textOf(2)
  if (!brief || !plan || !handoff) {
    throw new Error(`${sessionFile} does not look like a split Quick run (brief, plan, handoff)`)
  }
  return { brief, plan, handoff }
}
