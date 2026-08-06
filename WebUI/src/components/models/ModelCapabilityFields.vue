<script setup lang="ts">
// The capability form, shared by the Add Model dialog and the Model Management
// capability editor so the two can't drift apart.
import { computed } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/aipgInput'
import { Label } from '@/components/ui/label'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { ovmsToolParsers } from '@/types/shared'
import type { ModelCapabilityValues } from '@/assets/js/models/types'
import DropDownNew from '@/components/DropDownNew.vue'

const props = defineProps<{
  modelValue: ModelCapabilityValues
  /** Backend of the model being edited; gates the OpenVINO-only fields. */
  serviceBackend: 'llama_cpp' | 'openvino' | 'comfyui'
  /** Show the fields that only make sense once a model exists (tool parser). */
  showAdvanced?: boolean
  idPrefix?: string
}>()

const emit = defineEmits<{ (e: 'update:modelValue', value: ModelCapabilityValues): void }>()

const backendServices = useBackendServices()

const prefix = computed(() => props.idPrefix ?? 'capability')

function set<K extends keyof ModelCapabilityValues>(key: K, value: ModelCapabilityValues[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

/** Checkboxes emit `false` for "off"; store `undefined` so it stays un-overridden. */
function setFlag(key: keyof ModelCapabilityValues, value: boolean) {
  set(key, (value ? true : undefined) as ModelCapabilityValues[typeof key])
}

const isOpenVino = computed(() => props.serviceBackend === 'openvino')

const contextSize = computed({
  get: () => (props.modelValue.maxContextSize ?? '').toString(),
  set: (value: string) => {
    const parsed = Number.parseInt(value, 10)
    set('maxContextSize', Number.isFinite(parsed) && parsed > 0 ? parsed : undefined)
  },
})

const toolParserItems = computed(() =>
  ovmsToolParsers.map((parser) => ({ label: parser, value: parser, active: true })),
)
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="grid grid-cols-2 gap-3">
      <div class="flex items-center gap-2">
        <Checkbox
          :id="`${prefix}-vision`"
          :model-value="modelValue.supportsVision === true"
          @update:model-value="(v) => setFlag('supportsVision', v === true)"
        />
        <Label :for="`${prefix}-vision`">{{ languages.MODEL_MANAGER_CAP_VISION }}</Label>
      </div>
      <div class="flex items-center gap-2">
        <Checkbox
          :id="`${prefix}-tools`"
          :model-value="modelValue.supportsToolCalling === true"
          @update:model-value="(v) => setFlag('supportsToolCalling', v === true)"
        />
        <Label :for="`${prefix}-tools`">{{ languages.MODEL_MANAGER_CAP_TOOLS }}</Label>
      </div>
      <div class="flex items-center gap-2">
        <Checkbox
          :id="`${prefix}-reasoning`"
          :model-value="modelValue.supportsReasoning === true"
          @update:model-value="(v) => setFlag('supportsReasoning', v === true)"
        />
        <Label :for="`${prefix}-reasoning`">{{ languages.MODEL_MANAGER_CAP_REASONING }}</Label>
      </div>
      <div class="flex items-center gap-2">
        <Checkbox
          :id="`${prefix}-thinking`"
          :model-value="modelValue.supportsThinkingToggle === true"
          @update:model-value="(v) => setFlag('supportsThinkingToggle', v === true)"
        />
        <Label :for="`${prefix}-thinking`">{{ languages.MODEL_MANAGER_CAP_THINKING }}</Label>
      </div>
      <div v-if="isOpenVino" class="flex items-center gap-2">
        <Checkbox
          :id="`${prefix}-npu`"
          :model-value="modelValue.npuSupport === true"
          @update:model-value="(v) => setFlag('npuSupport', v === true)"
        />
        <Label :for="`${prefix}-npu`">{{ languages.MODEL_MANAGER_CAP_NPU }}</Label>
      </div>
      <!-- Not a plain capability: large-MoE models only load via Phison
           aiDAPTIV+ SSD offload, so ticking this on a machine without it makes
           the model disappear from the pickers. The hint spells that out along
           with whether this machine has the hardware. -->
      <div v-if="showAdvanced" class="flex items-center gap-2">
        <Checkbox
          :id="`${prefix}-large-moe`"
          :model-value="modelValue.largeMoe === true"
          @update:model-value="(v) => setFlag('largeMoe', v === true)"
        />
        <Label :for="`${prefix}-large-moe`" class="flex items-center gap-1">
          {{ languages.MODEL_MANAGER_CAP_LARGE_MOE }}
        </Label>
      </div>
    </div>

    <p v-if="showAdvanced && modelValue.largeMoe" class="text-xs text-muted-foreground">
      {{ languages.MODEL_MANAGER_CAP_LARGE_MOE_HINT }}
      <span :class="backendServices.phisonSsdDetected ? 'text-foreground' : 'text-amber-500'">
        {{
          backendServices.phisonSsdDetected
            ? languages.MODEL_MANAGER_PHISON_DETECTED
            : languages.MODEL_MANAGER_PHISON_NOT_DETECTED
        }}
      </span>
    </p>

    <div class="flex flex-col gap-2">
      <Label :for="`${prefix}-context`" class="text-sm font-medium">
        {{ languages.MODEL_MANAGER_CAP_MAX_CONTEXT }}
      </Label>
      <Input :id="`${prefix}-context`" type="number" min="1" v-model="contextSize" />
    </div>

    <!-- OVMS picks 'hermes3' when unset. A wrong parser silently breaks tool
         calling, and until now it could only be fixed by editing models.json. -->
    <div v-if="showAdvanced && isOpenVino" class="flex flex-col gap-2">
      <Label class="text-sm font-medium">{{ languages.MODEL_MANAGER_CAP_TOOL_PARSER }}</Label>
      <DropDownNew
        :items="toolParserItems"
        :value="modelValue.toolParser ?? ''"
        @change="(value: string) => set('toolParser', value)"
      />
      <p class="text-xs text-muted-foreground">
        {{ languages.MODEL_MANAGER_CAP_TOOL_PARSER_HINT }}
      </p>
    </div>
  </div>
</template>
