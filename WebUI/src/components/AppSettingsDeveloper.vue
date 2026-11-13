<template>
  <div class="flex flex-col gap-3 pt-4">
    <SettingsHeading>{{ languages.SETTINGS_DEVELOPER }}</SettingsHeading>
    <div class="flex flex-col">
      <AppSettingsRow
        v-slot="{ id }"
        :label="languages.SETTINGS_DEVELOPER_OPEN_DEV_CONSOLE_ON_STARTUP"
      >
        <Button variant="outline" size="sm" @click="openDevTools">
          {{ languages.SETTINGS_DEVELOPER_OPEN_DEV_CONSOLE }}
        </Button>
        <Switch :id="id" v-model="developerSettings.openDevConsoleOnStartup" />
      </AppSettingsRow>
      <AppSettingsRow
        v-slot="{ id, describedBy }"
        :label="languages.SETTINGS_DEVELOPER_KEEP_MODELS_LOADED"
        :description="languages.SETTINGS_DEVELOPER_KEEP_MODELS_LOADED_INFO"
      >
        <Switch
          :id="id"
          v-model="developerSettings.keepModelsLoaded"
          :aria-describedby="describedBy"
        />
      </AppSettingsRow>
      <template v-if="showDebugSettings">
        <AppSettingsRow
          v-slot="{ id, describedBy }"
          label="Verbose agent logging"
          description="Write the agent turn lifecycle and every tool call into the app log. Useful when an agent run misbehaves; noisy otherwise."
        >
          <Switch
            :id="id"
            v-model="developerSettings.verboseAgentLogging"
            :aria-describedby="describedBy"
          />
        </AppSettingsRow>
        <AppSettingsRow
          v-slot="{ id, describedBy }"
          label="Use dummy media workflows"
          description="Offer the assistant nothing but the dummy workflows, which return placeholder images, videos and 3D models instantly. Use it to verify media generation, chaining and rendering without waiting for a real model."
        >
          <Switch
            :id="id"
            v-model="developerSettings.forceDummyMediaWorkflows"
            :aria-describedby="describedBy"
          />
        </AppSettingsRow>
        <AppSettingsRow
          v-slot="{ id, describedBy }"
          label="Simulate aiDAPTIV Cache Memory"
          description="Skip the hardware probe and report aiDAPTIV Cache Memory as present, so the SSD-offload option can be exercised on any machine."
        >
          <Switch
            :id="id"
            :aria-describedby="describedBy"
            :model-value="debugSettings.phisonSsdDetected"
            @update:model-value="(v) => debugSettings.setPhisonSsdDetected(v === true)"
          />
        </AppSettingsRow>
        <AppSettingsRow label="OEM vendor override">
          <drop-down-new
            :items="oemVendorItems"
            :value="debugSettings.oemVendorOverride ?? NO_OEM_OVERRIDE"
            @change="
              (value) =>
                debugSettings.setOemVendorOverride(value === NO_OEM_OVERRIDE ? null : value)
            "
          />
        </AppSettingsRow>
        <AppSettingsRow v-slot="{ id }" label="Remote repository" wide>
          <Input
            :id="id"
            v-model="debugSettings.remoteRepository"
            placeholder="intel/ai-playground"
            class="h-[30px] leading-[30px] rounded-md bg-card border-border text-foreground px-[3px]"
            @change="debugSettings.saveRemoteRepository()"
          />
        </AppSettingsRow>
        <AppSettingsRow v-slot="{ id }" label="OpenVINO image-gen devices" wide>
          <Input
            :id="id"
            v-model="debugSettings.openvinoImageGenDevices"
            placeholder="CPU, GPU"
            class="h-[30px] leading-[30px] rounded-md bg-card border-border text-foreground px-[3px]"
            @change="debugSettings.saveOpenvinoImageGenDevices()"
          />
        </AppSettingsRow>
        <p class="text-xs text-muted-foreground py-2">
          The OEM, Phison and OpenVINO-device settings are read at startup — restart the app to see
          them take effect.
        </p>
      </template>
      <div v-if="!demoMode.enabled" class="flex gap-2 py-2">
        <Button variant="outline" size="sm" @click="openSettingsFile">
          {{ languages.SETTINGS_EDIT_SETTINGS_JSON }}
        </Button>
        <Button variant="outline" size="sm" @click="restartApp">
          {{ languages.SETTINGS_RESTART }}
        </Button>
      </div>
    </div>
    <div class="flex justify-between items-center">
      <SettingsHeading>{{ languages.SETTINGS_PRESETS_MANAGEMENT }}</SettingsHeading>
      <TooltipProvider :delay-duration="200">
        <div class="flex gap-2 items-center">
          <Tooltip>
            <TooltipTrigger as-child>
              <button
                class="svg-icon i-refresh w-5 h-5"
                :aria-label="languages.SETTINGS_PRESETS_RELOAD"
                @click="presetsStore.loadPresetsFromFiles"
              ></button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{{ languages.SETTINGS_PRESETS_RELOAD }}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <button
                class="svg-icon i-download-cloud w-5 h-5"
                :aria-label="languages.SETTINGS_PRESETS_DOWNLOAD"
                @click="loadPresetsFromIntel"
              ></button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{{ languages.SETTINGS_PRESETS_DOWNLOAD }}</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </div>
    <div class="flex flex-col pt-5">
      <button
        :disabled="demoMode.enabled"
        @click="openSetupWizard"
        class="bg-primary text-primary-foreground hover:bg-primary/80 px-3 py-1.5 rounded-lg text-sm disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed"
      >
        {{ languages.SETTINGS_SETUP_WIZARD }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { usePresets } from '@/assets/js/store/presets'
import { useDeveloperSettings } from '@/assets/js/store/developerSettings'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import { useDebugSettings, debugSettingsVisible } from '@/assets/js/store/debugSettings'
import { useI18N } from '@/assets/js/store/i18n'
import { useErrors } from '@/assets/js/store/errors'
import AppSettingsRow from '@/components/AppSettingsRow.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import * as toast from '@/assets/js/toast'
import { createAppError } from '@/assets/js/errors/appError'

const debugSettings = useDebugSettings()
const showDebugSettings = debugSettingsVisible()

// Vendors the OEM probe can report; `detectOem` treats anything else as unknown.
const NO_OEM_OVERRIDE = '__none__'
const oemVendorItems = [
  { label: 'No override (probe the firmware)', value: NO_OEM_OVERRIDE, active: true },
  { label: 'Acer', value: 'acer', active: true },
  { label: 'Unknown', value: 'unknown', active: true },
]
const demoMode = useDemoMode()
const setupWizardStore = useSetupWizard()
const presetsStore = usePresets()
const languages = useI18N().state
const developerSettings = useDeveloperSettings()
const errors = useErrors()

async function loadPresetsFromIntel() {
  const syncStatus = await presetsStore.loadPresetsFromIntel()
  if (syncStatus.result === 'success') {
    toast.success(`Backed up presets at ${syncStatus.backupDir}`)
  } else if (syncStatus.result === 'noUpdate') {
    toast.warning('No updated presets available')
  } else {
    errors.report(
      createAppError({
        category: 'setup',
        code: 'settings/presets-sync-failed',
        surface: 'toast',
        userMessage: 'Synchronisation failed',
      }),
    )
  }
}

function openSetupWizard() {
  if (demoMode.enabled) return
  setupWizardStore.openWizard()
}

function openDevTools() {
  window.electronAPI.openDevTools()
}

async function openSettingsFile() {
  const result = await window.electronAPI.lifecycle.openSettingsFile()
  if (result.success) return
  errors.report(
    createAppError({
      category: 'setup',
      code: 'settings/open-file-failed',
      surface: 'toast',
      userMessage: languages.SETTINGS_EDIT_SETTINGS_JSON_FAILED,
      technicalMessage: result.error,
    }),
  )
}

function restartApp() {
  void window.electronAPI.lifecycle.restart()
}
</script>
