import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { useProductMode } from '@/assets/js/store/productMode'
import {
  backendToService,
  type LlmBackend,
  textInferenceBackendDisplayName,
} from '@/assets/js/store/textInference'
import { agentBackendChoices } from '@/lib/llmBackendChoices'

/** The Agent backend dropdown's choices, each marked active while it can serve right now. */
export function useAgentBackendItems(
  presetBackends: MaybeRefOrGetter<readonly LlmBackend[] | undefined>,
) {
  const backendServices = useBackendServices()
  const cloudMode = useCloudMode()
  const productMode = useProductMode()

  const available = computed(() =>
    agentBackendChoices({
      presetBackends: toValue(presetBackends),
      productMode: productMode.productMode,
      cloudEnabled: cloudMode.isFeatureEnabled,
    }),
  )

  function isRunning(backend: LlmBackend): boolean {
    // Cloud Mode has no local service: it is ready once a provider base URL is configured.
    if (backend === 'cloud') return !!cloudMode.activeProviderBaseUrl
    const serviceName = backendToService[backend]
    return backendServices.info.find((s) => s.serviceName === serviceName)?.status === 'running'
  }

  const items = computed(() =>
    available.value.map((backend) => ({
      label: textInferenceBackendDisplayName[backend] ?? backend,
      value: backend,
      active: isRunning(backend),
    })),
  )

  return { available, items }
}
