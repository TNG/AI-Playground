import { asSchema } from 'ai'
import { z } from 'zod'
import { comfyUIFor, getAvailableWorkflows, resolveDefaultImageWorkflow } from './comfyUi'
import { comfyUiImageEditFor, getAvailableEditWorkflows } from './comfyUiImageEdit'
import { synthesizeTextToSpeech } from './synthesizeTextToSpeech'
import { transcribeAudio } from './transcribeAudio'
import { captureScreenshot } from './captureScreenshot'
import { mediaAgentHasTools } from '../agents/mediaAgent'
import { useTextInference } from '../store/textInference'
import type { AgentToolSpec } from '@/types/agentIpc'
import type { ToolsForTurn } from '@/lib/storedSessionInference'
import {
  storeMediaToolSettings,
  turnMediaToolSettings,
  type MediaToolSettings,
} from '@/lib/mediaToolSettings'

// ── Agent Mode tool specs (renderer side) ────────────────────────────────────
//
// Pi runs in the Electron main process. Media / generateImage / editImage and
// the speech tools execute there. This module only serializes the live catalog
// (name, description, JSON schema, workspacePathInputs) onto the turn config.
// Renderer execute for Agent Mode is storeTools in agentModeTurn
// (offer_game_agent), not this file.

const GENERATED_FILES_NOTE =
  '\n\nFILES: Generated media is automatically saved into your workspace. The tool result' +
  ' lists the workspace-relative paths in "savedFiles". The ' +
  'generator names those files, so a path exists only once a call has reported it — never ' +
  'guess one, and never create the image file yourself.'

const SOURCE_IMAGE_NOTE =
  '\n\nAGENT MODE: There is no conversation image history here. You MUST pass the image to ' +
  'edit via the required "sourceImagePath" parameter — a workspace-relative path an earlier ' +
  'call reported under "savedFiles", or a file the user attached under "attachments/".'

function editImageInputSchema(editInputSchema: unknown): z.ZodTypeAny {
  // The edit tool's zod schema is preset-dependent (workflow enum), so extend
  // it lazily at spec-build time.
  const base = editInputSchema as z.ZodObject
  return base.extend({
    sourceImagePath: z
      .string()
      .describe(
        'Workspace-relative path of the source image file to edit: one an earlier call ' +
          'reported under "savedFiles", or a file under "attachments/".',
      ),
  })
}

const MEDIA_SPEC_DESCRIPTION =
  'Create or transform media (images, videos, 3D models) via a media specialist. Describe the ' +
  'desired result in natural language; the specialist picks the workflow and parameters and ' +
  'can chain steps in one call (e.g. "generate an image of a castle and turn it into a 3D ' +
  'model"). To transform an existing image, pass its workspace-relative path in ' +
  '"sourceImagePath".' +
  GENERATED_FILES_NOTE

function mediaSpecInputSchema(): z.ZodTypeAny {
  return z.object({
    request: z
      .string()
      .describe(
        'The media request in natural language. Include everything relevant: subject, style, ' +
          'aspect ratio or size wishes, quality level, and any follow-up transformation ' +
          '(edit / animate / convert to 3D).',
      ),
    sourceImagePath: z
      .string()
      .optional()
      .describe(
        'Workspace-relative path of a source image to transform: one an earlier call ' +
          'reported under "savedFiles", or a file under "attachments/". Omit for pure ' +
          'text-to-media generation.',
      ),
  })
}

const TTS_FILES_NOTE =
  '\n\nFILES: The clip is written into the "generated/" folder of your workspace; the result ' +
  'gives its workspace-relative path in "savedFilePath". Reference that path in files you write ' +
  '(e.g. an <audio src="generated/....wav"> on an HTML page).'

const STT_SOURCE_NOTE =
  '\n\nAGENT MODE: There is no conversation audio history here. Name the file to transcribe with ' +
  'the required "sourceAudioPath" parameter — a workspace-relative path (e.g. ' +
  '"attachments/voice-note.m4a").'

function transcribeInputSchema(): z.ZodTypeAny {
  return z.object({
    sourceAudioPath: z
      .string()
      .describe(
        'Workspace-relative path of the audio file to transcribe (e.g. "attachments/note.m4a").',
      ),
  })
}

/** The speech tools, per the same per-preset toggles Chat reads. */
function speechToolSpecs(enabled: (name: string) => boolean): AgentToolSpec[] {
  const specs: AgentToolSpec[] = []
  if (enabled('synthesizeTextToSpeech')) {
    specs.push({
      name: 'synthesizeTextToSpeech',
      description: (synthesizeTextToSpeech.description ?? '') + TTS_FILES_NOTE,
      inputSchema: asSchema(synthesizeTextToSpeech.inputSchema).jsonSchema as Record<
        string,
        unknown
      >,
    })
  }
  if (enabled('transcribeAudio')) {
    specs.push({
      name: 'transcribeAudio',
      description: (transcribeAudio.description ?? '') + STT_SOURCE_NOTE,
      inputSchema: asSchema(transcribeInputSchema()).jsonSchema as Record<string, unknown>,
    })
  }
  return specs
}

/** Opt-in like Chat's; main drops it again for a model without vision. */
function screenshotToolSpecs(enabled: (name: string) => boolean): AgentToolSpec[] {
  if (!enabled('captureScreenshot')) return []
  return [
    {
      name: 'captureScreenshot',
      description:
        typeof captureScreenshot.description === 'string' ? captureScreenshot.description : '',
      inputSchema: asSchema(captureScreenshot.inputSchema).jsonSchema as Record<string, unknown>,
    },
  ]
}

/** `tools` are the settings stored on a session; the live ones are read when absent. */
export function getAgentToolSpecs(tools?: ToolsForTurn): AgentToolSpec[] {
  return agentToolSpecsFor(
    tools ? turnMediaToolSettings(tools) : storeMediaToolSettings(useTextInference()),
  )
}

/** The tool specs a set of media tool settings yields: a turn's, or a draft Settings Template's. */
export function agentToolSpecsFor(settings: MediaToolSettings): AgentToolSpec[] {
  return [
    ...mediaToolSpecs(settings),
    ...speechToolSpecs(settings.isToolEnabled),
    ...screenshotToolSpecs(settings.isToolEnabled),
  ]
}

function mediaToolSpecs(settings: MediaToolSettings): AgentToolSpec[] {
  // With tool delegation on (the default), the agent sees a single thin
  // `media` tool backed by the nested media agent (agents/mediaAgent.ts).
  // NOTE: the tool set is part of the Pi session's configKey, so flipping the
  // toggle starts a new Pi session on the next turn.
  if (settings.delegationEnabled()) {
    if (!mediaAgentHasTools(settings)) return []
    return [
      {
        name: 'media',
        description: MEDIA_SPEC_DESCRIPTION,
        inputSchema: asSchema(mediaSpecInputSchema()).jsonSchema as Record<string, unknown>,
        workspacePathInputs: ['sourceImagePath'],
      },
    ]
  }
  const specs: AgentToolSpec[] = []
  const workflows = getAvailableWorkflows(settings.isWorkflowEnabled)
  if (settings.isToolEnabled('comfyUI') && workflows.length > 0) {
    const imageNames = workflows.filter((w) => w.mediaType !== 'video').map((w) => w.name)
    const generate = comfyUIFor(settings)
    specs.push({
      name: 'generateImage',
      description: generate.description + GENERATED_FILES_NOTE,
      inputSchema: asSchema(generate.inputSchema).jsonSchema as Record<string, unknown>,
      // Main executes this in-process and can't see the enabled-workflow list;
      // the default is what the description already tells the model to use.
      defaultWorkflow: resolveDefaultImageWorkflow(imageNames, settings),
      allowedWorkflows: workflows.map((w) => w.name),
    })
  }
  const editWorkflows = getAvailableEditWorkflows(settings.isWorkflowEnabled)
  if (settings.isToolEnabled('comfyUiImageEdit') && editWorkflows.length > 0) {
    const edit = comfyUiImageEditFor(settings)
    specs.push({
      name: 'editImage',
      description: (edit.description ?? '') + SOURCE_IMAGE_NOTE + GENERATED_FILES_NOTE,
      inputSchema: asSchema(editImageInputSchema(edit.inputSchema)).jsonSchema as Record<
        string,
        unknown
      >,
      workspacePathInputs: ['sourceImagePath'],
      allowedWorkflows: editWorkflows.map((w) => w.name),
    })
  }
  return specs
}
