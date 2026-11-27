// ── Tool-availability block appended to chat / agent system prompts ──────────
//
// Enabled tools are visible to the model as schemas; disabled ones are simply
// omitted, so the model has no way to know they exist. This module turns the
// same gates that resolve a turn's tool set (resolveBuiltinTools in
// openAiCompatibleChat.ts, agentToolSpecsFor in agentBridge.ts and the media
// capability in electron/agent/capabilities/media.ts) into a short prompt
// section: what exists, what is unavailable and why, plus the standing
// instruction to suggest enabling one when the user's request matches.
//
// The wording is written for weak instruction-followers (small local models):
// the directive is imperative and leads the section, and every entry spells out
// "disabled" and where to enable it as its main clause — the model relays what
// it reads, so a passive parenthetical is never acted on.
//
// Keep the gate conditions here in sync with those resolvers: a tool listed as
// unavailable must not resolve into the turn's tool set, and vice versa.

import { builtinToolsCatalog, speechToolsCatalog, type BuiltinToolInfo } from './builtinToolCatalog'

export type ToolAvailabilitySurface = 'chat' | 'agent'

export type ToolAvailabilityInput = {
  /** Chat and Agent Mode name the place to enable a tool differently. */
  surface: ToolAvailabilitySurface
  /**
   * False (when known) collapses the block to a "this model cannot call tools"
   * note; undefined leaves that branch out.
   */
  modelSupportsToolCalling?: boolean
  /** Chat's built-in tools master switch; Agent Mode has no such switch. */
  builtinToolsEnabled: boolean
  /** Per-tool enablement (the active preset's, or a stored turn's). */
  isToolEnabled: (toolName: string) => boolean
  /** Media specialist delegation folds the two comfy tools into one `media` tool. */
  delegationEnabled: boolean
  modelSupportsVision: boolean
  /**
   * Agent only: a model not marked `supportsAgentic` loses the heavy
   * capabilities (files, shell, Game Studio) at session build — main gates
   * on exactly this (`catalogModelToolUse`). Explicit false; unset means
   * not restricted (chat has no agentic concept).
   */
  modelSupportsAgentic?: boolean
  /**
   * Agent only: only a preset that owns its prompt (the built-in agent
   * harnesses) loses the file and shell builtins with the heavy capabilities
   * when the model is not agentic; custom-prompt sessions keep them, so the
   * entry claims just Game Studio there. Unset reads as owned (the common
   * agent shape).
   */
  presetOwnsPrompt?: boolean
  /** Any enabled generation workflow exists (comfyUI). */
  generateWorkflowsAvailable: boolean
  /** Any enabled edit workflow exists (comfyUiImageEdit). */
  editWorkflowsAvailable: boolean
  /** Chat only: a window is bound to the screenshot tool. */
  screenshotWindowSelected?: boolean
  ttsAvailable: boolean
  transcriptionAvailable: boolean
  /** Agent only: the session's media capability gates every tool below. */
  mediaCapabilityEnabled?: boolean
  /** Chat's MCP master switch; agents attach servers per-session. */
  mcpEnabled: boolean
  /** Every configured MCP server, id + display name. */
  mcpServers: readonly { id: string; name: string }[]
  /** The servers this turn actually uses. */
  mcpSelectedIds: readonly string[]
}

// Tools the Pi harness does not offer an agent (browsing is the `web`
// capability's own skill; detections have no Agent Mode executor).
const CHAT_ONLY_TOOLS = new Set(['browseWeb', 'visualizeObjectDetections'])

/** Where the reasons tell the user to flip a tool back on. */
const toolSettingsWhere: Record<ToolAvailabilitySurface, string> = {
  chat: "the preset's Built-in tools settings",
  agent: "the session's media tools settings",
}

/** Where the user switches to a model with a missing capability. */
const modelSwitchWhere: Record<ToolAvailabilitySurface, string> = {
  chat: 'the model selector',
  agent: "the session's model settings",
}

const disabledReason = (input: ToolAvailabilityInput): string =>
  `disabled — the user can enable it in ${toolSettingsWhere[input.surface]}`

type ToolStatus = { info: BuiltinToolInfo; reason: string; announce?: string }

const MEDIA_PAIR_INFO: BuiltinToolInfo = {
  name: 'media',
  label: 'Media generation',
  description:
    'Create images, videos, or 3D models from text prompts, or transform an existing image ' +
    'into a new image, video, or 3D model.',
}

/**
 * The two comfy tools as one entry, as the `media` delegation tool presents
 * them; null when the `media` tool resolves into the turn's tool set.
 */
function mediaPairStatus(input: ToolAvailabilityInput): ToolStatus | null {
  if (!input.builtinToolsEnabled) {
    return { info: MEDIA_PAIR_INFO, reason: MASTER_OFF_REASON }
  }
  if (input.mediaCapabilityEnabled === false) {
    return { info: MEDIA_PAIR_INFO, reason: MEDIA_CAPABILITY_OFF_REASON }
  }
  const generateOn = input.isToolEnabled('comfyUI')
  const editOn = input.isToolEnabled('comfyUiImageEdit')
  // Neither tool on, or neither has a workflow left: no `media` tool at all.
  if (
    (generateOn && input.generateWorkflowsAvailable) ||
    (editOn && input.editWorkflowsAvailable)
  ) {
    return null
  }
  return {
    info: MEDIA_PAIR_INFO,
    reason: !(generateOn || editOn)
      ? disabledReason(input)
      : `no workflows are enabled for them — the user can enable one in ${toolSettingsWhere[input.surface]}`,
  }
}

/** Why the tool is unavailable this turn; null means available (or not offered here). */
function toolStatus(tool: BuiltinToolInfo, input: ToolAvailabilityInput): ToolStatus | null {
  if (input.surface === 'agent' && CHAT_ONLY_TOOLS.has(tool.name)) return null
  if (!input.builtinToolsEnabled) return { info: tool, reason: MASTER_OFF_REASON }
  if (input.mediaCapabilityEnabled === false) {
    return { info: tool, reason: MEDIA_CAPABILITY_OFF_REASON }
  }
  switch (tool.name) {
    case 'comfyUI':
    case 'comfyUiImageEdit': {
      const enabled = input.isToolEnabled(tool.name)
      const workflows =
        tool.name === 'comfyUI' ? input.generateWorkflowsAvailable : input.editWorkflowsAvailable
      if (!enabled) return { info: tool, reason: disabledReason(input) }
      if (!workflows) {
        return {
          info: tool,
          reason: `no workflows are enabled for it — the user can enable one in ${toolSettingsWhere[input.surface]}`,
        }
      }
      return null
    }
    case 'captureScreenshot': {
      if (!input.isToolEnabled(tool.name)) return { info: tool, reason: disabledReason(input) }
      if (!input.modelSupportsVision) {
        return {
          info: tool,
          reason: `requires a vision-capable model — the user can enable it in ${toolSettingsWhere[input.surface]} after switching to a vision model`,
        }
      }
      if (input.surface === 'chat' && input.screenshotWindowSelected === false) {
        return {
          info: tool,
          reason:
            "requires a window to be selected for capture — the user can pick one in the preset's Built-in tools settings",
        }
      }
      return null
    }
    case 'synthesizeTextToSpeech': {
      if (!input.isToolEnabled(tool.name)) return { info: tool, reason: disabledReason(input) }
      if (!input.ttsAvailable) {
        return {
          info: tool,
          reason:
            "no text-to-speech engine is configured — the user can set one up in the app's Speech settings",
        }
      }
      return null
    }
    case 'transcribeAudio': {
      if (!input.isToolEnabled(tool.name)) return { info: tool, reason: disabledReason(input) }
      if (!input.transcriptionAvailable) {
        return {
          info: tool,
          reason:
            "no speech-to-text engine is available — the user can set one up in the app's Speech settings",
        }
      }
      return null
    }
    default:
      return input.isToolEnabled(tool.name) ? null : { info: tool, reason: disabledReason(input) }
  }
}

const MASTER_OFF_REASON =
  "built-in tools are turned off for this preset — the user can turn them back on in the preset's Built-in tools settings"

const MEDIA_CAPABILITY_OFF_REASON =
  "the Media generation capability is turned off for this session — the user can enable it in the session's Default Settings"

/** What the current model is missing; every entry proposes the model switch. */
function modelLimitations(input: ToolAvailabilityInput): ToolStatus[] {
  const limitations: ToolStatus[] = []
  if (!input.modelSupportsVision) {
    limitations.push({
      info: {
        name: 'vision',
        label: 'Vision',
        description: 'see and analyze images or screenshots',
      },
      reason: `this model cannot process images — the user can switch to a vision-capable model in ${modelSwitchWhere[input.surface]}`,
    })
  }
  if (input.surface === 'agent' && input.modelSupportsAgentic === false) {
    const consequence =
      input.presetOwnsPrompt === false
        ? 'so Game Studio is unavailable this session'
        : 'so the session runs without the file and shell tools and Game Studio'
    limitations.push({
      info: { name: 'agentic', label: 'Agentic work', description: '' },
      reason:
        `This model is not agentic (not reliable at multi-step tool use), ${consequence} — ` +
        `the user can switch to an agentic-capable model in ${modelSwitchWhere.agent}`,
      announce:
        'In your first reply of the session, tell the user this model is not agentic ' +
        '(not reliable at multi-step tool use) and that they can switch to an agentic-capable ' +
        `model in ${modelSwitchWhere.agent}`,
    })
  }
  return limitations
}

/**
 * The section's one behavioral rule, stated up front: models act on a leading
 * imperative far more reliably than on a trailing conditional, so this leads
 * and never offers an excuse to stay silent.
 */
const DIRECTIVE =
  'When the user asks for something an unavailable tool or MCP server could do, do not just ' +
  'say you cannot do it: tell them the app supports it, that it is unavailable, and how they ' +
  'can enable it — by switching the tool on, or by switching to a model with the missing ' +
  'capability.'

const NO_TOOL_CALLING_NOTE =
  'Tool availability: this app has built-in tools — media generation (create images, videos or ' +
  '3D models), image transformation, web browsing, screenshot capture, text-to-speech and ' +
  'speech-to-text — plus optional MCP servers, but this model does not support tool calling, ' +
  'so none of them can be used in this conversation. If the user asks for such a task, tell ' +
  'them the app supports it and that it needs a model with tool-calling support to use it.'

/** A catalog description as it reads inside a bullet's parentheses. */
function parenthetical(description: string): string {
  const text = description.trim().replace(/\.$/, '')
  return text ? ` (${text.charAt(0).toLowerCase()}${text.slice(1)})` : ''
}

/**
 * The availability block for a turn's system prompt; empty when every tool is
 * available and every configured MCP server is in use, so fully-enabled setups
 * pay nothing (the schemas already tell the model what it can call).
 */
export function toolAvailabilitySection(input: ToolAvailabilityInput): string {
  if (input.modelSupportsToolCalling === false) return NO_TOOL_CALLING_NOTE
  const limitations = modelLimitations(input)

  const catalog =
    input.surface === 'agent'
      ? [...builtinToolsCatalog, ...speechToolsCatalog].filter(
          (tool) => !CHAT_ONLY_TOOLS.has(tool.name),
        )
      : [...builtinToolsCatalog, ...speechToolsCatalog]

  const unavailable: ToolStatus[] = []
  const available: string[] = []
  for (const tool of catalog) {
    // With delegation on, the comfy pair folds into one `media` tool below.
    if (input.delegationEnabled && (tool.name === 'comfyUI' || tool.name === 'comfyUiImageEdit')) {
      continue
    }
    const status = toolStatus(tool, input)
    if (status === null) {
      available.push(tool.label)
      continue
    }
    unavailable.push(status)
  }
  if (input.delegationEnabled) {
    const pair = mediaPairStatus(input)
    if (pair) {
      unavailable.unshift(pair)
    } else {
      available.push('Media generation')
    }
  }

  const serverName = (id: string) => input.mcpServers.find((server) => server.id === id)?.name ?? id
  if (input.mcpEnabled) {
    for (const id of input.mcpSelectedIds) available.push(`MCP server ${serverName(id)}`)
  }

  if (input.mcpServers.length > 0 && !input.mcpEnabled && input.surface === 'chat') {
    unavailable.push({
      info: { name: 'mcp', label: 'MCP servers', description: '' },
      reason:
        "MCP tools are turned off for this preset — the user can turn them on in the preset's MCP settings",
    })
  } else if (input.mcpEnabled) {
    for (const server of input.mcpServers) {
      if (input.mcpSelectedIds.includes(server.id)) continue
      unavailable.push({
        info: { name: `mcp:${server.id}`, label: `MCP server ${server.name}`, description: '' },
        reason:
          input.surface === 'chat'
            ? "configured but not selected for this preset — the user can select it in the preset's MCP settings"
            : "configured but not attached to this session — the user can attach it in the session's Default Settings",
      })
    }
  }

  if (unavailable.length === 0 && limitations.length === 0) return ''

  const entries = [...limitations, ...unavailable]
  const lines = ['Tool availability:', DIRECTIVE]
  for (const { info, reason } of entries) {
    lines.push(`- ${info.label}${parenthetical(info.description)}: ${reason}.`)
  }
  // Model limitations the user cannot see anywhere else get a standing
  // first-reply instruction, so the session never starts silently crippled.
  for (const { announce } of entries) {
    if (announce) lines.push(announce + '.')
  }
  if (available.length > 0) lines.push(`Tools you can call right now: ${available.join('; ')}.`)
  return lines.join('\n')
}

/** Appends a built availability section to a system prompt; empty adds nothing. */
export function withToolAvailability(systemPrompt: string, section: string): string {
  if (!section) return systemPrompt
  const base = systemPrompt.trimEnd()
  return base ? `${base}\n\n${section}` : section
}
