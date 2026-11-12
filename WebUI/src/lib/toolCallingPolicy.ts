export type ToolCallingPolicyInput = {
  isDemoModeEnabled: boolean
  productMode?: string | null
}

/** A tool call reaches image generation past the curated presets' safety settings. */
export function allowsToolCalling(input: ToolCallingPolicyInput): boolean {
  return !input.isDemoModeEnabled && input.productMode !== 'essentials'
}
