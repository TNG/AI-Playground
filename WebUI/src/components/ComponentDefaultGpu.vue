<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type {
  ComponentPanelApplyMode,
  ComponentPanelDeviceOption,
} from '@/components/ComponentPanel.vue'

const props = defineProps<{
  applyMode: ComponentPanelApplyMode
  deviceOptions: ComponentPanelDeviceOption[]
  selectedDeviceKey: string | null
  overrideDeviceSelection: boolean
}>()

const emit = defineEmits<{
  selectDevice: [key: string]
  overrideDevice: [value: boolean]
  saveDevice: [intent: { key: string; override: boolean }]
}>()

const languages = useI18N().state

const deviceDialogOpen = ref(false)
const draftDeviceKey = ref<string | null>(null)
const draftDeviceOverride = ref(false)

const selectedDeviceOption = computed(
  () => props.deviceOptions.find((option) => option.key === props.selectedDeviceKey) ?? null,
)
// Save is only meaningful once something changed: the dialog opens on the current value.
const deviceSelectionDirty = computed(
  () =>
    draftDeviceKey.value !== props.selectedDeviceKey ||
    draftDeviceOverride.value !== props.overrideDeviceSelection,
)

function deviceCategoryLabel(category: DeviceCategory): string {
  if (category === 'dgpu') return languages.SETUP_WIZARD_DEVICE_DEDICATED || 'Dedicated GPU'
  if (category === 'igpu') return languages.SETUP_WIZARD_DEVICE_INTEGRATED || 'Integrated GPU'
  return ''
}

function openDeviceDialog() {
  draftDeviceKey.value = props.selectedDeviceKey
  draftDeviceOverride.value = false
  deviceDialogOpen.value = true
}

function saveDeviceSelection() {
  if (!draftDeviceKey.value) return
  emit('saveDevice', { key: draftDeviceKey.value, override: draftDeviceOverride.value })
  deviceDialogOpen.value = false
}

function onSelectDevice(key: unknown) {
  if (typeof key === 'string') emit('selectDevice', key)
}
</script>

<template>
  <div v-if="deviceOptions.length > 0" class="pt-6">
    <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
      {{ languages.SETUP_WIZARD_DEVICE_SECTION || 'Default GPU' }}
    </h2>
    <template v-if="applyMode === 'draft'">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="w-full flex items-center justify-between gap-2 p-3 rounded-lg border border-border transition-colors text-left hover:border-muted/50"
          >
            <span class="min-w-0">
              <span class="block text-xs font-medium truncate">{{
                selectedDeviceOption?.label
              }}</span>
              <span
                v-if="selectedDeviceOption && deviceCategoryLabel(selectedDeviceOption.category)"
                class="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {{ deviceCategoryLabel(selectedDeviceOption.category) }}
              </span>
            </span>
            <svg
              class="w-4 h-4 shrink-0 text-muted-foreground"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          class="w-[var(--reka-dropdown-menu-trigger-width)] min-w-0"
        >
          <DropdownMenuItem
            v-for="option in deviceOptions"
            :key="option.key"
            @select="onSelectDevice(option.key)"
          >
            <span class="min-w-0">
              <span class="block text-xs font-medium truncate">{{ option.label }}</span>
              <span
                v-if="deviceCategoryLabel(option.category)"
                class="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {{ deviceCategoryLabel(option.category) }}
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <label class="flex items-center gap-2.5 pt-3 cursor-pointer">
        <Switch
          :model-value="overrideDeviceSelection"
          @update:model-value="(v: boolean) => emit('overrideDevice', v)"
        />
        <span class="text-xs text-muted-foreground">
          {{
            languages.SETUP_WIZARD_DEVICE_OVERRIDE || 'Override existing preset device selections'
          }}
        </span>
      </label>
    </template>

    <template v-else>
      <div
        role="group"
        :aria-label="languages.SETUP_WIZARD_DEVICE_SECTION || 'Default GPU'"
        class="flex items-center justify-between gap-2 p-3 rounded-lg border border-border"
      >
        <span class="min-w-0">
          <span class="block text-xs font-medium truncate">{{ selectedDeviceOption?.label }}</span>
          <span
            v-if="selectedDeviceOption && deviceCategoryLabel(selectedDeviceOption.category)"
            class="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {{ deviceCategoryLabel(selectedDeviceOption.category) }}
          </span>
        </span>
        <Button variant="outline" size="sm" @click="openDeviceDialog">
          {{ languages.COMPONENT_MANAGER_DEFAULT_GPU_CHANGE || 'Change' }}
        </Button>
      </div>

      <Dialog v-model:open="deviceDialogOpen">
        <DialogContent class="max-w-md">
          <DialogHeader>
            <DialogTitle>{{ languages.SETUP_WIZARD_DEVICE_SECTION || 'Default GPU' }}</DialogTitle>
            <DialogDescription>
              {{
                languages.COMPONENT_MANAGER_DEFAULT_GPU_DESCRIPTION ||
                'New presets use this GPU. Existing Sessions keep the device they were set up with.'
              }}
            </DialogDescription>
          </DialogHeader>

          <RadioGroup
            v-model="draftDeviceKey"
            :aria-label="languages.COMPONENT_MANAGER_DEFAULT_GPU_OPTIONS || 'Detected GPUs'"
            class="flex flex-col gap-2"
          >
            <div
              v-for="(option, index) in deviceOptions"
              :key="option.key"
              class="flex items-start gap-2"
            >
              <RadioGroupItem
                :id="`default-gpu-option-${index}`"
                :value="option.key"
                class="mt-0.5"
              />
              <label :for="`default-gpu-option-${index}`" class="flex flex-col cursor-pointer">
                <span class="text-xs font-medium">{{ option.label }}</span>
                <span
                  v-if="deviceCategoryLabel(option.category)"
                  class="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {{ deviceCategoryLabel(option.category) }}
                </span>
              </label>
            </div>
          </RadioGroup>

          <label class="flex items-center gap-2.5 cursor-pointer">
            <Switch v-model="draftDeviceOverride" />
            <span class="text-xs text-muted-foreground">
              {{
                languages.SETUP_WIZARD_DEVICE_OVERRIDE ||
                'Override existing preset device selections'
              }}
            </span>
          </label>

          <p class="text-xs text-muted-foreground">
            {{
              languages.COMPONENT_MANAGER_DEFAULT_GPU_SESSION_HINT ||
              "To change one Session's device, open its Inferencing settings and set the Inference Device."
            }}
          </p>

          <DialogFooter>
            <Button variant="ghost" @click="deviceDialogOpen = false">{{
              languages.COM_CANCEL || 'Cancel'
            }}</Button>
            <Button
              :disabled="!draftDeviceKey || !deviceSelectionDirty"
              @click="saveDeviceSelection"
            >
              {{ languages.COMPONENT_MANAGER_DEFAULT_GPU_SAVE || 'Save' }}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </template>
  </div>
</template>
