import { ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { agentToolSpecsFor } from '@/assets/js/tools/agentBridge'
import { mediaAgentHasTools } from '@/assets/js/agents/mediaAgent'
import type { MediaToolSettings } from '@/lib/mediaToolSettings'

export type CapabilityCatalogQuery = {
  workspaceDir: string
  embeddingModel?: string | null
  mediaTools: MediaToolSettings
}

/** The capability catalog main builds Pi sessions from, for a given folder and tool settings. */
export function useCapabilityCatalog(query: MaybeRefOrGetter<CapabilityCatalogQuery>) {
  const catalog = ref<AgentCapabilityInfo[]>([])

  async function refresh(): Promise<void> {
    const { workspaceDir, embeddingModel, mediaTools } = toValue(query)
    catalog.value = await window.electronAPI.agentMode.listCapabilities({
      workspaceDir,
      toolSpecs: agentToolSpecsFor(mediaTools),
      embeddingModel: embeddingModel ?? undefined,
    })
  }

  // Whether media has anything to offer is decided in main from the tool specs, so
  // turning its last workflow or speech tool off (or back on) needs a re-ask.
  watch(
    () => {
      const { workspaceDir, embeddingModel, mediaTools } = toValue(query)
      return [
        workspaceDir,
        embeddingModel,
        mediaAgentHasTools(mediaTools),
        mediaTools.delegationEnabled(),
        mediaTools.isToolEnabled('synthesizeTextToSpeech'),
        mediaTools.isToolEnabled('transcribeAudio'),
      ]
    },
    () => void refresh(),
  )

  return { catalog, refresh }
}
