// Pure core of the comfy tool-call repair (see tools/comfyUi.ts /
// tools/comfyUiImageEdit.ts for the renderer wrappers). The workflow lists and
// the resolved default live in renderer state, so they travel as data — which
// also lets the main-process turn engine run the same repair with the lists
// shipped on the turn request.

export type WorkflowRepairData = {
  /** Every enabled workflow name the tool accepts. */
  names: string[]
  /**
   * The resolved default workflow name (user preference, initial preset, first
   * available — the wrapper owns the full fallback chain). Applied verbatim.
   */
  defaultWorkflow: string
}

/**
 * Coerce a malformed `workflow` field, or return null when the input needs no
 * repair — or must not be repaired. A missing/blank/non-string `workflow` is
 * filled with the default. A named workflow that is unknown but near-matches an
 * enabled one (case/whitespace) is repaired to that name, never to the default.
 * Any other named workflow returns null: the validation error then reaches the
 * model (with the valid names listed), so it retries with a workflow the user
 * actually asked for instead of silently running the default. `rawInput` is the
 * model's tool-call input as a JSON string; the return value is the repaired
 * JSON string. Shared by the create and edit repairs — they differ only in the
 * workflow data they pass.
 */
export function repairWorkflowToolInput(rawInput: string, data: WorkflowRepairData): string | null {
  if (data.names.length === 0) return null
  let obj: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(rawInput || '{}')
    obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    obj = {}
  }
  if (typeof obj.workflow === 'string' && data.names.includes(obj.workflow)) return null
  if (typeof obj.workflow === 'string' && obj.workflow.trim() !== '') {
    const wanted = obj.workflow.trim().toLowerCase()
    const matches = data.names.filter((name) => name.trim().toLowerCase() === wanted)
    if (matches.length === 1) {
      obj.workflow = matches[0]
      return JSON.stringify(obj)
    }
    return null
  }
  obj.workflow = data.defaultWorkflow
  return JSON.stringify(obj)
}
