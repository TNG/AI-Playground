import { asSchema } from 'ai'
import { z } from 'zod'
import { comfyUI, getAvailableWorkflows, resolveDefaultImageWorkflow } from './comfyUi'
import { comfyUiImageEdit } from './comfyUiImageEdit'
import { mediaAgentHasTools } from '../agents/mediaAgent'
import { useTextInference } from '../store/textInference'
import type { AgentToolSpec } from '@/types/agentIpc'

// ── Agent Mode tool specs (renderer side) ────────────────────────────────────
//
// Pi runs in the Electron main process. Media / generateImage / editImage
// execute in-process there. This module only serializes the live catalog
// (name, description, JSON schema, workspacePathInputs) onto the turn config.
// Renderer execute for Agent Mode is storeTools in agentModeTurn
// (offer_game_agent), not this file.

const GENERATED_FILES_NOTE =
  '\n\nFILES: Generated media is automatically saved into the "generated/" folder of your ' +
  'workspace. The tool result lists the workspace-relative paths in "savedFiles".'

const SOURCE_IMAGE_NOTE =
  '\n\nAGENT MODE: There is no conversation image history here. You MUST pass the image to ' +
  'edit via the required "sourceImagePath" parameter — a workspace-relative path to an ' +
  'existing image file (e.g. "generated/AIPG_00001_.png" from a previous generateImage call, ' +
  'or any image file in the workspace).'

function editImageInputSchema(): z.ZodTypeAny {
  // The edit tool's zod schema is preset-dependent (workflow enum), so extend
  // it lazily at spec-build time.
  const base = comfyUiImageEdit.inputSchema as unknown as z.ZodObject
  return base.extend({
    sourceImagePath: z
      .string()
      .describe(
        'Workspace-relative path of the source image file to edit (e.g. "generated/AIPG_00001_.png").',
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
        'Workspace-relative path of a source image to transform (e.g. ' +
          '"generated/AIPG_00001_.png"). Omit for pure text-to-media generation.',
      ),
  })
}

export function getAgentToolSpecs(): AgentToolSpec[] {
  // With tool delegation on (the default), the agent sees a single thin
  // `media` tool backed by the nested media agent (agents/mediaAgent.ts).
  // NOTE: the tool set is part of the Pi session's configKey, so flipping the
  // toggle starts a new Pi session on the next turn.
  if (useTextInference().toolDelegationEnabled) {
    if (!mediaAgentHasTools()) return []
    return [
      {
        name: 'media',
        description: MEDIA_SPEC_DESCRIPTION,
        inputSchema: asSchema(mediaSpecInputSchema()).jsonSchema as Record<string, unknown>,
        workspacePathInputs: ['sourceImagePath'],
      },
    ]
  }
  const imageWorkflowNames = getAvailableWorkflows()
    .filter((w) => w.mediaType !== 'video')
    .map((w) => w.name)
  return [
    {
      name: 'generateImage',
      description: comfyUI.description + GENERATED_FILES_NOTE,
      inputSchema: asSchema(comfyUI.inputSchema).jsonSchema as Record<string, unknown>,
      // Main executes this in-process and can't see the enabled-workflow list;
      // the default is what the description already tells the model to use.
      defaultWorkflow: resolveDefaultImageWorkflow(imageWorkflowNames),
    },
    {
      name: 'editImage',
      description: (comfyUiImageEdit.description ?? '') + SOURCE_IMAGE_NOTE + GENERATED_FILES_NOTE,
      inputSchema: asSchema(editImageInputSchema()).jsonSchema as Record<string, unknown>,
      workspacePathInputs: ['sourceImagePath'],
    },
  ]
}
