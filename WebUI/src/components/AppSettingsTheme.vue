<template>
  <section
    v-if="!demoMode.enabled"
    ref="themeSection"
    :aria-label="languages.COM_THEME"
    class="border-t border-border pt-6 mt-6"
  >
    <SettingsTheme />
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { useI18N } from '@/assets/js/store/i18n'
import SettingsTheme from '@/components/SettingsTheme.vue'

const demoMode = useDemoMode()
const languages = useI18N().state
const themeSection = ref<HTMLElement>()

defineExpose({
  scrollIntoView: () => themeSection.value?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
})
</script>
