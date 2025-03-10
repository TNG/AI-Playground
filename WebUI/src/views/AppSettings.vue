<template>
  <div
    id="app-settings-panel"
    class="settings-panel absolute right-0 top-0 h-full bg-color-bg-main text-sm text-white py-4"
  >
    <div class="flex justify-between px-3">
      <div class="flex items-stretch gap-2">
        <button
          v-show="tabs.activeTabIdx == 0 || tabs.activeTabIdx == 1"
          class="panel-tab"
          :class="{ active: tabIndex == 0 }"
          @click="tabIndex = 0"
        >
          {{ languages.SETTINGS_TAB_IMAGE }}
        </button>
        <button
          v-show="tabs.activeTabIdx == 2"
          class="panel-tab"
          :class="{ active: tabIndex == 0 }"
          @click="tabIndex = 0"
        >
          {{ languages.SETTINGS_TAB_LLM }}
        </button>
        <button class="panel-tab" :class="{ active: tabIndex == 1 }" @click="tabIndex = 1">
          {{ languages.SETTINGS_TAB_BASIC }}
        </button>
        <button class="panel-tab" :class="{ active: tabIndex == 2 }" @click="tabIndex = 2">
          {{ languages.SETTINGS_TAB_MODEL }}
        </button>
      </div>
      <button class="w-6 h-6" @click="emits('close')">
        <span class="svg-icon i-right-arrow h-4 w-4"></span>
      </button>
    </div>
    <!--ImageSettingsTab-->
    <div
      v-show="tabIndex == 0 && (tabs.activeTabIdx == 0 || tabs.activeTabIdx == 1)"
      class="flex-auto h-0 flex flex-col gap-5 pt-3 border-t border-color-spilter overflow-y-auto"
    >
      <div class="px-3 flex-none flex flex-col gap-3">
        <SettingsImageGeneration></SettingsImageGeneration>
      </div>
    </div>
    <!-- LLMSettingsTab -->
    <div
      v-show="tabIndex == 0 && tabs.activeTabIdx == 2"
      class="flex-auto h-0 flex flex-col gap-5 pt-3 border-t border-color-spilter overflow-y-auto"
    >
      <div class="px-3 flex-none flex flex-col gap-3">
        <SettingsLLM></SettingsLLM>
      </div>
    </div>
    <!--BasicSettingsTab-->
    <div
      v-show="tabIndex == 1"
      class="flex-auto h-0 flex flex-col gap-5 pt-3 border-t border-color-spilter overflow-y-auto"
    >
      <div class="px-3 flex-none flex flex-col gap-3">
        <SettingsBasic></SettingsBasic>
      </div>
    </div>
    <!--ModelSettingsTab-->
    <div
      v-show="tabIndex == 2"
      class="flex-auto h-0 flex flex-col gap-5 pt-3 border-t border-color-spilter overflow-y-auto"
    >
      <div class="px-3 flex-none flex flex-col gap-3">
        <SettingsModel @show-download-model-confirm="showDownloadModelConfirm"></SettingsModel>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import SettingsImageGeneration from '@/components/SettingsImageGeneration.vue'
import SettingsLLM from '../components/SettingsLLM.vue'
import SettingsBasic from '@/components/SettingsBasic.vue'
import SettingsModel from '@/components/SettingsModel.vue'
import { defineProps } from 'vue'

const tabs = defineProps<{
  activeTabIdx: number
}>()

const tabIndex = ref(0)

const emits = defineEmits<{
  (
    e: 'showDownloadModelConfirm',
    downloadList: DownloadModelParam[],
    success?: () => void,
    fail?: () => void,
  ): void
  (e: 'close'): void
}>()

function showDownloadModelConfirm(
  downList: DownloadModelParam[],
  _success?: () => void,
  _fail?: () => void,
) {
  emits('showDownloadModelConfirm', downList)
}
</script>
