import { AGENT_PRESET } from '@/assets/js/store/agentModeSessions'
import type { SessionLastPreset } from '@/types/sessionIpc'

/**
 * The preset opening a Session switches to: its last turn's, or Agent Maker for a picked Agent
 * whose last turn ran under a preset that is gone (an Agent Preset folded into its Agent).
 */
export function sessionReopenPreset(
  last: SessionLastPreset | null,
  knownPresets: readonly string[],
  pickedAgentId: string | undefined,
): SessionLastPreset | null {
  if (!last) return null
  if (knownPresets.includes(last.preset)) return last
  return pickedAgentId && knownPresets.includes(AGENT_PRESET) ? { preset: AGENT_PRESET } : null
}
