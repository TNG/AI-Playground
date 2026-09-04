import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  executeToolInRenderer,
  jsonResult,
  jsonSchemaParameters,
  saveGeneratedMediaToWorkspace,
  workspaceFileToDataUri,
} from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import type { AgentToolSpec, CapabilityHost } from './types.ts'

// ── media delegation tool ────────────────────────────────────────────────────
//
// The thin `media` tool: the model describes the desired result in natural
// language and a media specialist (a nested AI SDK run living renderer-side,
// agents/mediaAgent.ts) picks workflows and parameters and can chain steps.
// The specialist needs the renderer's chat model, tool catalog and stores, so
// unlike the direct media tools (mediaDirect.ts) this one stays a proxy: main
// resolves workspace paths to data URIs on the way in, dispatches over IPC,
// and saves generated media into the workspace on the way out.

/** Builds the renderer-backed `media` tool for one shipped spec. */
export async function buildDelegatedMediaTool(
  host: CapabilityHost,
  spec: AgentToolSpec,
): Promise<ToolDefinition> {
  const pi = await loadPi()
  const { workspaceDir } = host
  return pi.defineTool({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: jsonSchemaParameters(spec.inputSchema),
    execute: async (toolCallId, params, signal) => {
      const dispatchInput = { ...(params as Record<string, unknown>) }
      for (const key of spec.workspacePathInputs ?? []) {
        const value = dispatchInput[key]
        if (typeof value === 'string' && value !== '') {
          dispatchInput[key] = workspaceFileToDataUri(workspaceDir, value)
        }
      }
      const result = await executeToolInRenderer(
        spec.name,
        dispatchInput,
        toolCallId,
        signal ?? undefined,
      )
      return jsonResult(await saveGeneratedMediaToWorkspace(result, workspaceDir))
    },
  }) as ToolDefinition
}
