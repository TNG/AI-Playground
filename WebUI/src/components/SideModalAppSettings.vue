<template>
  <SideModalBase
    id="app-settings-sidebar"
    :is-visible="isVisible"
    title="App Settings"
    side="left"
    @close="$emit('close')"
  >
    <div class="border-b border-border flex flex-col gap-5 py-4">
      <AppSettingsLanguage />
      <AppSettingsPromptBarStyle />
      <AppSettingsHuggingFace />
    </div>
    <AppSettingsBackendStatus />
    <AppSettingsSpeech />
    <AppSettingsPermissions />
    <AppSettingsDeveloper />
    <DemoModeSettings v-if="demoMode.showDemoToggle" />
    <AppSettingsTheme ref="themeSection" />
  </SideModalBase>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useDemoMode } from '@/assets/js/store/demoMode'
import SideModalBase from '@/components/SideModalBase.vue'
import AppSettingsLanguage from '@/components/AppSettingsLanguage.vue'
import AppSettingsPromptBarStyle from '@/components/AppSettingsPromptBarStyle.vue'
import AppSettingsHuggingFace from '@/components/AppSettingsHuggingFace.vue'
import AppSettingsBackendStatus from '@/components/AppSettingsBackendStatus.vue'
import AppSettingsSpeech from '@/components/AppSettingsSpeech.vue'
import AppSettingsPermissions from '@/components/AppSettingsPermissions.vue'
import AppSettingsDeveloper from '@/components/AppSettingsDeveloper.vue'
import AppSettingsTheme from '@/components/AppSettingsTheme.vue'
import DemoModeSettings from '@/components/DemoModeSettings.vue'

export type AppSettingsSection = 'theme'

const props = defineProps<{
  isVisible: boolean
  section?: { name: AppSettingsSection }
}>()

defineEmits<{
  close: []
}>()

const demoMode = useDemoMode()
const themeSection = ref<InstanceType<typeof AppSettingsTheme>>()

watch(
  () => [props.isVisible, props.section] as const,
  async ([visible, section]) => {
    if (!visible || section?.name !== 'theme') return
    await nextTick()
    themeSection.value?.scrollIntoView()
  },
)
</script>
