import { sortFavoritesFirst } from '@/assets/js/models/favorites'
import { modelMeetsPresetRequirements, type PresetModelGate } from '@/lib/presetModelFilter'
import type { LlmBackend } from '@/assets/js/store/textInference'

export type ChoiceModel = PresetModelGate & {
  name: string
  type: LlmBackend
  favorite?: boolean
  isPredefined?: boolean
  largeMoe?: boolean
  requiresPhison?: boolean
}

/** The preset fields that narrow the model picker; only a chat preset's apply. */
export type ModelChoicePreset = {
  type: string
  requiresVision?: boolean
  requiresToolCalling?: boolean
  requiresReasoning?: boolean
  requiresCoding?: boolean
  requiresAgentic?: boolean
  requiresNpuSupport?: boolean
  filterTxt2TxtOnly?: boolean
  filterLargeMoeOnly?: boolean
  advancedMode?: boolean
}

export type ModelChoiceContext = {
  backend: LlmBackend
  preset: ModelChoicePreset | null | undefined
  /** Whether the OpenVINO device the choice is for is an NPU. */
  onNpu: boolean
  phisonSsdDetected: boolean
}

function presetRequirements(preset: ModelChoicePreset | null | undefined) {
  const chat = preset?.type === 'chat' ? preset : undefined
  return {
    vision: chat?.requiresVision === true,
    toolCalling: chat?.requiresToolCalling === true,
    reasoning: chat?.requiresReasoning === true,
    coding: chat?.requiresCoding === true,
    agentic: chat?.requiresAgentic === true,
    npuSupport: chat?.requiresNpuSupport === true,
    txt2TxtOnly: chat?.filterTxt2TxtOnly === true,
    largeMoeOnly: chat?.filterLargeMoeOnly === true,
    advancedMode: chat?.advancedMode === true,
  }
}

/** The models a picker offers for a backend and preset, favorites first, before any user filter. */
export function llmModelChoices<T extends ChoiceModel>(
  models: readonly T[],
  { backend, preset, onNpu, phisonSsdDetected }: ModelChoiceContext,
): T[] {
  const forBackend = sortFavoritesFirst(models.filter((m) => m.type === backend))
  // Cloud models carry no capability metadata, so any requirement would drop them all.
  if (backend === 'cloud') return forBackend
  const requirements = presetRequirements(preset)
  return forBackend.filter((m) => {
    // Models too big for a normal GPU stay hidden until a Phison SSD is detected.
    if (m.requiresPhison && !phisonSsdDetected) return false
    if (requirements.largeMoeOnly && !m.largeMoe) return false
    if (!modelMeetsPresetRequirements(m, requirements)) return false
    if (backend === 'openVINO' && onNpu !== (m.npuSupport === true)) return false
    if (requirements.txt2TxtOnly && (m.supportsVision || m.supportsReasoning)) return false
    if (!requirements.advancedMode && !m.isPredefined) {
      const hasMatchingRequirement =
        (requirements.vision && m.supportsVision) ||
        (requirements.toolCalling && m.supportsToolCalling) ||
        (requirements.reasoning && m.supportsReasoning) ||
        (requirements.coding && m.supportsCoding) ||
        (requirements.agentic && m.supportsAgentic) ||
        (requirements.npuSupport && m.npuSupport)
      const qualifiesForTxt2Txt =
        requirements.txt2TxtOnly &&
        !m.supportsVision &&
        !m.supportsReasoning &&
        !m.supportsToolCalling &&
        !m.npuSupport
      if (!hasMatchingRequirement && !qualifiesForTxt2Txt) return false
    }
    return true
  })
}

/** Whether the named model's template honours `enable_thinking`. */
export function modelSupportsThinkingToggle(
  models: readonly (ChoiceModel & { supportsThinkingToggle?: boolean })[],
  backend: LlmBackend,
  modelName: string | undefined,
): boolean {
  return models.some(
    (m) => m.type === backend && m.name === modelName && m.supportsThinkingToggle === true,
  )
}
