// Single source of truth for the chat model capabilities surfaced in the UI:
// the icon row next to the selected model, the filter row in the model picker,
// and the prompt-area banner. Keep this list in sync with the model capability
// flags in `store/models.ts` / `store/textInference.ts`.
import { Eye, Brain, Wrench, type LucideIcon } from 'lucide-vue-next'

export type CapabilityKey = 'vision' | 'reasoning' | 'tools' | 'npu'

/** The subset of a model's flags that the capability UI reads. */
export type CapabilityFlags = {
  supportsVision?: boolean
  supportsReasoning?: boolean
  supportsToolCalling?: boolean
  npuSupport?: boolean
}

export type CapabilityDescriptor = {
  key: CapabilityKey
  /** Corresponding boolean flag on a model. */
  flag: keyof CapabilityFlags
  label: string
  tooltip: string
  /** Lucide icon; omitted for capabilities rendered as a text badge (NPU). */
  icon?: LucideIcon
  /** Text badge shown when there is no icon. */
  badge?: string
  /** NPU hardware only exists on Intel builds, never in the NVIDIA product mode. */
  intelOnly?: boolean
}

export const CAPABILITIES: CapabilityDescriptor[] = [
  {
    key: 'vision',
    flag: 'supportsVision',
    label: 'Vision',
    tooltip: 'Can understand images you attach.',
    icon: Eye,
  },
  {
    key: 'reasoning',
    flag: 'supportsReasoning',
    label: 'Reasoning',
    tooltip: 'Thinks step-by-step before answering.',
    icon: Brain,
  },
  {
    key: 'tools',
    flag: 'supportsToolCalling',
    label: 'Tool calling',
    tooltip: 'Can call built-in and MCP tools / functions.',
    icon: Wrench,
  },
  {
    key: 'npu',
    flag: 'npuSupport',
    label: 'NPU',
    tooltip: 'Runs on the NPU. Only used when the OpenVINO backend is selected with an NPU device.',
    badge: 'NPU',
    intelOnly: true,
  },
]

export function modelHasCapability(
  model: CapabilityFlags | null | undefined,
  key: CapabilityKey,
): boolean {
  if (!model) return false
  const descriptor = CAPABILITIES.find((c) => c.key === key)
  return !!descriptor && model[descriptor.flag] === true
}
