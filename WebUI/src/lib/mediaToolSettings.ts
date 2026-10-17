/**
 * The media tools' settings — delegation, built-in tool enablement, per-workflow
 * enablement and default workflows — behind one interface, so the media tools panel
 * can edit the chat store's live values.
 */
export type MediaToolSettings = {
  delegationEnabled(): boolean
  setDelegationEnabled(enabled: boolean): void
  isToolEnabled(toolName: string): boolean
  setToolEnabled(toolName: string, enabled: boolean): void
  isWorkflowEnabled(presetName: string): boolean
  setWorkflowEnabled(presetName: string, enabled: boolean): void
  /** The default for a "<toolName>:<mediaType>" slot among the enabled `available` workflows. */
  defaultWorkflow(slot: string, available: string[]): string | null
  setDefaultWorkflow(slot: string, presetName: string): void
}

// The workflows the tool descriptions used to hard-code, kept as the out-of-the-box default.
const INITIAL_DEFAULT_WORKFLOWS: Record<string, string> = {
  'comfyUI:image': 'Draft Image',
  'comfyUiImageEdit:image': 'Edit By Prompt',
}

/** The stored choice if still available, else the initial default, else the first available. */
export function resolveDefaultWorkflow(
  stored: Record<string, string>,
  slot: string,
  available: string[],
): string | null {
  const choice = stored[slot]
  if (choice && available.includes(choice)) return choice
  const initial = INITIAL_DEFAULT_WORKFLOWS[slot]
  if (initial && available.includes(initial)) return initial
  return available[0] ?? null
}

export function isWorkflowEnabled(
  enablement: Record<string, boolean>,
  presetName: string,
): boolean {
  return enablement[presetName] ?? true
}

type MediaToolStore = {
  toolDelegationEnabled: boolean
  isBuiltinToolEnabled(toolName: string): boolean
  setBuiltinToolEnabled(toolName: string, enabled: boolean): void
  isWorkflowPresetEnabled(presetName: string): boolean
  setWorkflowPresetEnabled(presetName: string, enabled: boolean): void
  getDefaultWorkflow(slot: string, available: string[]): string | null
  setDefaultWorkflow(slot: string, presetName: string): void
}

/** Reads and writes the chat store's live values: the active preset's, or the Open Session's. */
export function storeMediaToolSettings(store: MediaToolStore): MediaToolSettings {
  return {
    delegationEnabled: () => store.toolDelegationEnabled,
    setDelegationEnabled: (enabled) => {
      store.toolDelegationEnabled = enabled
    },
    isToolEnabled: (toolName) => store.isBuiltinToolEnabled(toolName),
    setToolEnabled: (toolName, enabled) => store.setBuiltinToolEnabled(toolName, enabled),
    isWorkflowEnabled: (presetName) => store.isWorkflowPresetEnabled(presetName),
    setWorkflowEnabled: (presetName, enabled) =>
      store.setWorkflowPresetEnabled(presetName, enabled),
    defaultWorkflow: (slot, available) => store.getDefaultWorkflow(slot, available),
    setDefaultWorkflow: (slot, presetName) => store.setDefaultWorkflow(slot, presetName),
  }
}
