<template>
  <div class="flex flex-col gap-3 pt-4">
    <SettingsHeading>{{ languages.SETTINGS_DEVELOPER }}</SettingsHeading>
    <div class="pl-2 pt-2">
      <div class="flex justify-between pr-4 items-center gap-4 mb-4">
        <Label class="whitespace-nowrap">{{
          languages.SETTINGS_DEVELOPER_OPEN_DEV_CONSOLE_ON_STARTUP
        }}</Label>
        <div class="flex items-center gap-3">
          <Button variant="outline" size="sm" @click="openDevTools">
            {{ languages.SETTINGS_DEVELOPER_OPEN_DEV_CONSOLE }}
          </Button>
          <Checkbox id="open-dev-console" v-model="developerSettings.openDevConsoleOnStartup" />
        </div>
      </div>
      <div class="flex justify-between pr-4 items-center gap-4 mb-4">
        <div class="flex items-center gap-2">
          <Label class="whitespace-nowrap">{{
            languages.SETTINGS_DEVELOPER_KEEP_MODELS_LOADED
          }}</Label>
          <TooltipProvider :delay-duration="200">
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="svg-icon i-info w-4 h-4 opacity-50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="bottom" class="max-w-[300px]">
                {{ languages.SETTINGS_DEVELOPER_KEEP_MODELS_LOADED_INFO }}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <Checkbox id="keep-models-loaded" v-model="developerSettings.keepModelsLoaded" />
      </div>
      <template v-if="showDebugSettings">
        <div class="flex justify-between pr-4 items-center gap-4 mb-4">
          <div class="flex items-center gap-2">
            <Label class="whitespace-nowrap">Verbose agent logging</Label>
            <TooltipProvider :delay-duration="200">
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="svg-icon i-info w-4 h-4 opacity-50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="bottom" class="max-w-[300px]">
                  Write the agent turn lifecycle and every tool call into the app log. Useful when
                  an agent run misbehaves; noisy otherwise.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Checkbox id="verbose-agent-logging" v-model="developerSettings.verboseAgentLogging" />
        </div>
        <div class="flex justify-between pr-4 items-center gap-4 mb-4">
          <div class="flex items-center gap-2">
            <Label class="whitespace-nowrap">Use dummy media workflows</Label>
            <TooltipProvider :delay-duration="200">
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="svg-icon i-info w-4 h-4 opacity-50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="bottom" class="max-w-[300px]">
                  Offer the assistant nothing but the dummy workflows, which return placeholder
                  images, videos and 3D models instantly. Use it to verify media generation,
                  chaining and rendering without waiting for a real model.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Checkbox
            id="force-dummy-media-workflows"
            v-model="developerSettings.forceDummyMediaWorkflows"
          />
        </div>
        <div class="flex justify-between pr-4 items-center gap-4 mb-4">
          <div class="flex items-center gap-2">
            <Label class="whitespace-nowrap">Simulate aiDAPTIV Cache Memory</Label>
            <TooltipProvider :delay-duration="200">
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="svg-icon i-info w-4 h-4 opacity-50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="bottom" class="max-w-[300px]">
                  Skip the hardware probe and report aiDAPTIV Cache Memory as present, so the
                  SSD-offload option can be exercised on any machine.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Checkbox
            id="pretend-phison-ssd"
            :model-value="debugSettings.phisonSsdDetected"
            @update:model-value="(v) => debugSettings.setPhisonSsdDetected(v === true)"
          />
        </div>
        <div class="flex flex-col gap-2 pr-4 mb-4">
          <Label>OEM vendor override</Label>
          <drop-down-new
            :items="oemVendorItems"
            :value="debugSettings.oemVendorOverride ?? NO_OEM_OVERRIDE"
            @change="
              (value) =>
                debugSettings.setOemVendorOverride(value === NO_OEM_OVERRIDE ? null : value)
            "
          />
        </div>
        <div class="flex flex-col gap-2 pr-4 mb-4">
          <Label>Remote repository</Label>
          <Input
            v-model="debugSettings.remoteRepository"
            placeholder="intel/ai-playground"
            class="h-[30px] leading-[30px] rounded-md bg-card border-border text-foreground px-[3px]"
            @change="debugSettings.saveRemoteRepository()"
          />
        </div>
        <div class="flex flex-col gap-2 pr-4 mb-4">
          <Label>OpenVINO image-gen devices</Label>
          <Input
            v-model="debugSettings.openvinoImageGenDevices"
            placeholder="CPU, GPU"
            class="h-[30px] leading-[30px] rounded-md bg-card border-border text-foreground px-[3px]"
            @change="debugSettings.saveOpenvinoImageGenDevices()"
          />
        </div>
        <p class="text-xs text-muted-foreground pr-4 mb-4">
          The OEM, Phison and OpenVINO-device settings are read at startup — restart the app to see
          them take effect.
        </p>
      </template>
      <div v-if="!demoMode.enabled" class="flex pr-4 gap-2 mb-4">
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
        <div class="flex pr-4 gap-2 items-center">
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
        class="bg-primary hover:bg-primary/80 px-3 py-1.5 rounded-lg text-sm disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed"
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
import DropDownNew from '@/components/DropDownNew.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
