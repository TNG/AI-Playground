<template>
  <!-- Non-modal and not portalled: the confirmation dialogs these settings open live in the
       app's own dialog layer, which a modal focus trap or a higher stacking layer would block. -->
  <DialogRoot :open="isVisible" :modal="false">
    <div
      v-if="isVisible"
      class="absolute inset-0 z-10 flex items-center justify-center bg-background/60"
    >
      <DialogContent
        id="app-settings-dialog"
        :aria-describedby="undefined"
        class="flex w-[min(960px,90%)] h-[min(680px,90%)] overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-lg outline-none"
        @escape-key-down.prevent
        @interact-outside.prevent
      >
        <DialogTitle as="span" class="sr-only">{{ languages.COM_APP_SETTINGS }}</DialogTitle>
        <TabsRoot
          :model-value="activeTab"
          orientation="vertical"
          activation-mode="manual"
          class="flex flex-1 min-w-0"
          @update:model-value="(tab) => (activeTab = tab as AppSettingsTab)"
        >
          <TabsList
            class="flex w-56 shrink-0 flex-col gap-1 border-r border-border bg-muted/30 p-3"
          >
            <TabsTrigger
              v-for="tab in tabs"
              :key="tab.id"
              :value="tab.id"
              class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground data-[state=active]:bg-primary/15 data-[state=active]:text-foreground data-[state=active]:font-medium"
            >
              <component :is="tab.icon" class="size-4 shrink-0" />
              {{ tab.label }}
            </TabsTrigger>
          </TabsList>

          <div class="flex flex-1 min-w-0 flex-col">
            <div class="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
              <h2 class="text-lg font-semibold">{{ activeLabel }}</h2>
              <Button
                variant="ghost"
                size="icon"
                class="h-8 w-8"
                :aria-label="languages.COM_CLOSE"
                @click="requestClose"
              >
                <XMarkIcon class="size-5" />
              </Button>
            </div>

            <TabsContent value="app" class="flex-1 min-h-0 overflow-y-auto px-6 outline-none">
              <div class="flex flex-col divide-y divide-border">
                <section
                  v-for="section in sections"
                  :key="section.id"
                  :aria-label="sectionLabels[section.id]"
                  class="py-6"
                >
                  <SettingsHeading v-if="section.heading">
                    {{ sectionLabels[section.id] }}
                  </SettingsHeading>
                  <template v-for="part in section.parts" :key="part.id">
                    <DemoModeBlocker v-if="part.blocked">
                      <component :is="partComponents[part.id]" />
                    </DemoModeBlocker>
                    <component
                      :is="partComponents[part.id]"
                      v-else
                      v-bind="part.id === 'demoMode' ? { disabled: part.disabled } : {}"
                    />
                  </template>
                </section>
              </div>
            </TabsContent>
            <TabsContent
              v-for="tab in placeholderTabs"
              :key="tab"
              :value="tab"
              class="flex-1 min-h-0 overflow-y-auto p-6 text-sm text-muted-foreground outline-none"
            >
              {{ languages.SETTINGS_WORK_IN_PROGRESS }}
            </TabsContent>
          </div>
        </TabsRoot>
      </DialogContent>
    </div>
  </DialogRoot>
</template>

<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue'
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from 'reka-ui'
import {
  CircleStackIcon,
  Cog6ToothIcon,
  PuzzlePieceIcon,
  XMarkIcon,
} from '@heroicons/vue/24/outline'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { developerMode } from '@/assets/js/store/debugSettings'
import { useI18N } from '@/assets/js/store/i18n'
import AppSettingsLanguage from '@/components/AppSettingsLanguage.vue'
import AppSettingsPromptBarStyle from '@/components/AppSettingsPromptBarStyle.vue'
import AppSettingsHuggingFace from '@/components/AppSettingsHuggingFace.vue'
import AppSettingsBackendStatus from '@/components/AppSettingsBackendStatus.vue'
import AppSettingsSpeech from '@/components/AppSettingsSpeech.vue'
import AppSettingsTheme from '@/components/AppSettingsTheme.vue'
import AppSettingsMediaModes from '@/components/AppSettingsMediaModes.vue'
import AppSettingsPermissions from '@/components/AppSettingsPermissions.vue'
import AppSettingsHide from '@/components/AppSettingsHide.vue'
import AppSettingsRemoteKernel from '@/components/AppSettingsRemoteKernel.vue'
import AppSettingsDeveloper from '@/components/AppSettingsDeveloper.vue'
import DemoModeBlocker from '@/components/DemoModeBlocker.vue'
import DemoModeSettings from '@/components/DemoModeSettings.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { Button } from '@/components/ui/button'
import {
  appSettingsSections,
  type AppSettingsPartId,
  type AppSettingsSectionId,
} from '@/lib/appSettingsSections'

type AppSettingsTab = 'app' | 'components' | 'models'

const partComponents: Record<AppSettingsPartId, Component> = {
  language: AppSettingsLanguage,
  theme: AppSettingsTheme,
  promptBarStyle: AppSettingsPromptBarStyle,
  huggingFace: AppSettingsHuggingFace,
  speech: AppSettingsSpeech,
  mediaModes: AppSettingsMediaModes,
  permissions: AppSettingsPermissions,
  hideMessages: AppSettingsHide,
  remoteKernel: AppSettingsRemoteKernel,
  backendStatus: AppSettingsBackendStatus,
  developer: AppSettingsDeveloper,
  demoMode: DemoModeSettings,
}

const props = defineProps<{
  isVisible: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const demoMode = useDemoMode()
const languages = useI18N().state

const activeTab = ref<AppSettingsTab>('app')

const sections = computed(() =>
  appSettingsSections({
    demoMode: demoMode.enabled,
    hasDemoPasscode: demoMode.hasPasscode,
    developerMode: developerMode(),
  }),
)
const sectionLabels = computed<Record<AppSettingsSectionId, string>>(() => ({
  language: languages.SETTINGS_BASIC_LANGUAGE,
  theme: languages.COM_THEME,
  promptBarStyle: languages.SETTINGS_PROMPT_BAR_STYLE,
  huggingFace: languages.SETTINGS_MODEL_HUGGINGFACE_SETTINGS,
  speech: languages.SETTINGS_SPEECH,
  mediaModes: languages.SETTINGS_MEDIA_MODES,
  permissions: languages.SETTINGS_PERMISSIONS,
  hide: languages.SETTINGS_HIDE_MESSAGES,
  remoteKernel: languages.SETTINGS_REMOTE_KERNEL,
  advanced: languages.SETTINGS_ADVANCED,
}))

const tabs = computed(() => [
  { id: 'app' as const, label: languages.COM_APP_SETTINGS, icon: Cog6ToothIcon },
  {
    id: 'components' as const,
    label: languages.SETTINGS_TAB_COMPONENT_MANAGER,
    icon: PuzzlePieceIcon,
  },
  { id: 'models' as const, label: languages.SETTINGS_TAB_MODEL_LIBRARY, icon: CircleStackIcon },
])
const placeholderTabs = computed(() => tabs.value.map((tab) => tab.id).filter((id) => id !== 'app'))
const activeLabel = computed(() => tabs.value.find((tab) => tab.id === activeTab.value)?.label)

function requestClose() {
  emit('close')
}

watch(
  () => props.isVisible,
  (visible) => {
    if (visible) activeTab.value = 'app'
  },
)
</script>
