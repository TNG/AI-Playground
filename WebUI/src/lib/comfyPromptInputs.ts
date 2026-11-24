import { z } from 'zod'
import type { ComfyInput, ComfyUiPreset } from './presetSchemas'

// Which ComfyUI workflow inputs a prompt may pick a value for. The renderer
// enumerates these in the media tool descriptions; main merges + validates
// the model's `dynamicInputs` against the same rule (inProcessComfy.ts).

/** Value-shaped inputs only: images, videos, masks and canvases arrive as sources, never as values. */
const PROMPT_VALUE_INPUT_TYPES = new Set(['number', 'string', 'boolean', 'model', 'stringList'])

/** The inference device stays the user's UI choice — never prompt-selectable. */
export function isDeviceInput(input: Pick<ComfyInput, 'nodeInput'>): boolean {
  return input.nodeInput.trim().toLowerCase() === 'device'
}

/** Whether the tool's `dynamicInputs` may pick this input's value. */
export function isPromptSelectableInput(input: ComfyInput): boolean {
  return (
    PROMPT_VALUE_INPUT_TYPES.has(input.type) &&
    input.displayed !== false &&
    input.modifiable !== false &&
    !isDeviceInput(input)
  )
}

/** One model-facing line describing a prompt-selectable input. */
export type PromptInputSummary = { label: string; detail: string }

export function summarizePromptInput(input: ComfyInput): PromptInputSummary {
  let detail: string
  if (input.options && input.options.length > 0) {
    detail = `one of: ${input.options.join(', ')}`
  } else if (input.type === 'number') {
    const range =
      input.min !== undefined && input.max !== undefined
        ? ` between ${input.min} and ${input.max}`
        : ''
    detail = `number${range}`
  } else if (input.type === 'model') {
    detail = 'model name (one of the models available to this workflow)'
  } else if (input.type === 'boolean') {
    detail = 'true or false'
  } else {
    detail = 'text'
  }
  if (input.defaultValue !== undefined && input.defaultValue !== '') {
    detail += `, default ${input.defaultValue}`
  }
  return { label: input.label, detail }
}

/** The prompt-selectable workflow inputs of a preset, in catalog order. */
export function promptSelectableInputs(preset: ComfyUiPreset): PromptInputSummary[] {
  return preset.settings
    .filter((s): s is ComfyInput => 'nodeTitle' in s && 'nodeInput' in s)
    .filter(isPromptSelectableInput)
    .map(summarizePromptInput)
}

/** The shared zod shape of the tools' `dynamicInputs` parameter. */
export const dynamicInputsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .describe(
    'Additional inputs of the chosen workflow that the user explicitly named, keyed by the ' +
      'label listed for that workflow (e.g. {"Guidance Scale": 7.5}). Only include inputs the ' +
      "user asked for; each value is validated against the input's allowed range or options. " +
      'The inference device cannot be set here.',
  )

/** The description block enumerating per-workflow inputs, or '' when no workflow has any. */
export function describeWorkflowInputs(
  workflows: Array<{ name: string; promptInputs?: PromptInputSummary[] }>,
): string {
  const withInputs = workflows.filter((w) => (w.promptInputs ?? []).length > 0)
  if (withInputs.length === 0) return ''
  const lines = [
    'WORKFLOW INPUTS: Some workflows expose additional inputs, listed per workflow below. When the',
    'user names one of them (e.g. a guidance scale, sampler or model choice), pass it in',
    'dynamicInputs keyed by its label — e.g. {"Guidance Scale": 7.5}. Only include inputs the user',
    'explicitly asked for; anything unlisted, and the inference device, cannot be requested.',
  ]
  for (const workflow of withInputs) {
    const listed = (workflow.promptInputs ?? [])
      .map((input) => `${input.label} (${input.detail})`)
      .join('; ')
    lines.push(`- ${workflow.name}: ${listed}`)
  }
  return lines.join('\n') + '\n\n'
}
