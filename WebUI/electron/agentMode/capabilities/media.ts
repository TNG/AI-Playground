import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentCapability, CapabilityHost } from './types.ts'
import { buildDelegatedMediaTool } from './mediaDelegation.ts'
import { buildDirectMediaTools } from './mediaDirect.ts'

// ── media capability ─────────────────────────────────────────────────────────
//
// The AIPG media tools (image/video/3D generation and editing). Which tools
// exist is decided by the renderer and shipped with the turn as `toolSpecs`:
// one thin `media` delegation tool when tool delegation is on, else
// generateImage + editImage. The delegation tool proxies the renderer's media
// specialist (mediaDelegation.ts); the direct tools execute in-process
// against the main-side artifact runner (mediaDirect.ts) — step 5 of
// architecture-target §8 — so this module only routes specs to their executor.

const MEDIA_GENERATION_SKILL = {
  name: 'media-generation',
  description:
    'Create or transform images, videos and 3D models with the `media` tool; results are ' +
    'saved into the workspace.',
  body: [
    'The `media` tool hands your request to a media specialist that picks the right generation',
    'workflow and parameters. Use it like this:',
    '',
    '1. Describe the desired result in ONE natural-language request: subject, style, aspect',
    '   ratio / size wishes, and quality level. Terse prompts are expanded automatically.',
    '2. Multi-step requests belong in a single call — e.g. "generate an image of a castle and',
    '   turn it into a 3D model" or "animate this photo into a short video". Do not split them',
    '   into separate calls; the specialist chains the steps itself.',
    '3. To transform an image that already exists in the workspace, pass its workspace-relative',
    '   path as sourceImagePath (e.g. "generated/AIPG_00001_.png").',
    '4. The result lists what was created plus "savedFiles": the workspace-relative paths of the',
    '   generated media under "generated/". Reference those paths in your reply or in files you',
    '   write (e.g. an <img src="generated/...png"> in an HTML page).',
    '',
    'Media generation takes minutes — call the tool once, then wait for its result. Do not',
    'retry while a call is running.',
  ].join('\n'),
} as const

const DELEGATION_TOOL_NAME = 'media'
const DIRECT_TOOL_NAMES = new Set(['generateImage', 'editImage'])

/** Routes each shipped spec to its executor: delegation proxy or in-process run. */
async function buildMediaTools(host: CapabilityHost): Promise<ToolDefinition[]> {
  const delegationSpecs = host.toolSpecs.filter((spec) => spec.name === DELEGATION_TOOL_NAME)
  const directSpecs = host.toolSpecs.filter((spec) => DIRECT_TOOL_NAMES.has(spec.name))
  return [
    ...(await buildDirectMediaTools(host, directSpecs)),
    ...(await Promise.all(delegationSpecs.map((spec) => buildDelegatedMediaTool(host, spec)))),
  ]
}

export const mediaCapability: AgentCapability = {
  id: 'media',
  label: 'Media generation',
  summary:
    'Generate and transform images, videos and 3D models; results are saved into the workspace.',
  skills: [MEDIA_GENERATION_SKILL],
  buildTools: buildMediaTools,
  unavailableReason: (host) =>
    host.toolSpecs.length === 0
      ? 'No image or video workflows are installed — install a ComfyUI workflow first.'
      : undefined,
  lazyEligible: true,
}
