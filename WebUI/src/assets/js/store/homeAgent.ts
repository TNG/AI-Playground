import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import * as toast from '../toast'

export const useHomeAgent = defineStore(
  'homeAgent',
  () => {
    const backendServices = useBackendServices()

    const isHomeAgentActive = ref(false)

    const isAvailable = computed(
      () =>
        backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.isSetUp ?? false,
    )

    const homeAgentBaseUrl = computed(
      () => backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.baseUrl,
    )

    function activate() {
      if (!isAvailable.value) {
        toast.error(
          'Home Agent is not installed. Please install it from App Settings → Installation Management.',
        )
        return
      }
      isHomeAgentActive.value = true
    }

    function deactivate() {
      isHomeAgentActive.value = false
    }

    function toggle() {
      if (isHomeAgentActive.value) {
        deactivate()
      } else {
        activate()
      }
    }

    return {
      isHomeAgentActive,
      isAvailable,
      homeAgentBaseUrl,
      activate,
      deactivate,
      toggle,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: ['isHomeAgentActive'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useHomeAgent, import.meta.hot))
}

