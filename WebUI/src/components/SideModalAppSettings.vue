<template>
  <SideModalBase
    id="app-settings-sidebar"
    :is-visible="isVisible"
    title="App Settings"
    side="left"
    @close="$emit('close')"
  >
    <SettingsBasic />
    <section
      v-if="!demoMode.enabled"
      ref="themeSection"
      :aria-label="languages.COM_THEME"
      class="border-t border-border pt-6 mt-6"
    >
      <SettingsTheme />
    </section>
  </SideModalBase>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { useI18N } from '@/assets/js/store/i18n'
import SideModalBase from '@/components/SideModalBase.vue'
import SettingsBasic from '@/components/SettingsBasic.vue'
import SettingsTheme from '@/components/SettingsTheme.vue'

export type AppSettingsSection = 'theme'

const props = defineProps<{
  isVisible: boolean
  section?: { name: AppSettingsSection }
}>()

defineEmits<{
  close: []
}>()

const demoMode = useDemoMode()
const languages = useI18N().state
const themeSection = ref<HTMLElement>()

watch(
  () => [props.isVisible, props.section] as const,
  async ([visible, section]) => {
    if (!visible || section?.name !== 'theme') return
    await nextTick()
    themeSection.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  },
)
</script>
