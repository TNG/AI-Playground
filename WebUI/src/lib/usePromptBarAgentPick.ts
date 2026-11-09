import { computed } from 'vue'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { AGENT_PRESET } from '@/assets/js/store/agentModeSessions'
import { usePresets } from '@/assets/js/store/presets'
import { useSessions } from '@/assets/js/store/sessions'
import { presetToMode } from '@/lib/presetModes'
import type { PromptBarAgent } from '@/lib/promptBarModel'
import { usePromptBarPresetSwitch } from '@/lib/usePromptBarPresetSwitch'

/** Picking an Agent or an Agent Preset in the prompt bar; an Agent runs on Agent Maker. */
export function usePromptBarAgentPick() {
  const agentTasks = useAgentTasks()
  const presetsStore = usePresets()
  const sessions = useSessions()
  const { switchTo } = usePromptBarPresetSwitch()

  /** The Agent Library with each Agent's saved name, description and image, not its Draft's. */
  const agents = computed((): PromptBarAgent[] =>
    agentTasks.libraryAgents.map((agent) => {
      const saved = agentTasks.tasks.find((task) => task.id === agent.id)
      const { name, description, image } = saved ?? agent
      return { id: agent.id, name, description, image, saved: !!saved }
    }),
  )

  const pickedAgentId = computed(() => sessions.openSession?.pickedAgentId)

  async function pickAgent(agentId: string): Promise<void> {
    if (await switchTo(AGENT_PRESET, { announce: false })) await agentTasks.pickAgent(agentId)
  }

  /** Picking an Agent Preset puts it in place of the Session's picked Agent. */
  async function pickPreset(name: string): Promise<void> {
    if (!(await switchTo(name))) return
    const preset = presetsStore.presets.find((entry) => entry.name === name)
    if (preset && presetToMode(preset) === 'agent' && pickedAgentId.value) {
      await agentTasks.pickAgent(null)
    }
  }

  return { agents, pickedAgentId, pickAgent, pickPreset }
}
