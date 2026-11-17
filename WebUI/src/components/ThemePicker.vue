<template>
  <DropDownNew
    :items="themeItems"
    :value="theme.selectedId"
    @change="(value: string) => theme.guardUnsaved(() => theme.selectTheme(value))"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useTheme } from '@/assets/js/store/theme'
import DropDownNew from '@/components/DropDownNew.vue'

const theme = useTheme()

const themeItems = computed(() =>
  [...theme.builtInThemes, ...theme.validCustomThemes].map((t) => ({
    label: t.name,
    value: t.id,
    active: true,
  })),
)
</script>
