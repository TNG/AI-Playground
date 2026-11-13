<template>
  <div class="flex flex-col gap-3 pt-6">
    <SettingsHeading>{{ languages.SETTINGS_BACKEND_STATUS }}</SettingsHeading>
    <table class="text-center w-full mx-2 table-fixed">
      <tbody>
        <tr v-for="item in displayComponents" :key="item.serviceName">
          <td style="text-align: left">{{ mapServiceNameToDisplayName(item.serviceName) }}</td>
          <td :style="{ color: mapStatusToColor(item.status) }">
            {{ mapToDisplayStatus(item.status) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { useI18N } from '@/assets/js/store/i18n'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { mapServiceNameToDisplayName, mapStatusToColor, mapToDisplayStatus } from '@/lib/utils.ts'

const backendServices = useBackendServices()
const cloudMode = useCloudMode()
const languages = useI18N().state

const displayComponents = computed(() => {
  const components = backendServices.info.map((item) => ({
    serviceName: item.serviceName as string,
    status: item.status as BackendStatus,
  }))
  // Cloud Mode has no backend service, so it is listed here: running when enabled.
  components.push({
    serviceName: 'cloud-mode',
    status: cloudMode.isFeatureEnabled ? 'running' : 'notInstalled',
  })
  return components
})
</script>
