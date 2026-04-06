<template>
  <div class="z-10 text-foreground rounded-xl bg-background/70 border border-border shadow-lg">
    <div class="px-20 py-5 max-w-5xl">
      <h1 class="text-center py-1 px-4 rounded-sm text-4xl">AI Playground Installation Manager</h1>

      <div class="flex flex-col gap-4 pt-8">
        <label
          v-for="option in modeOptions"
          :key="option.mode"
          class="flex items-start gap-4 p-5 rounded-lg border cursor-pointer transition-colors"
          :class="
            selectedMode === option.mode
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-border/80'
          "
          @click="selectedMode = option.mode"
        >
          <div class="pt-1 shrink-0">
            <div
              class="w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors"
              :class="
                selectedMode === option.mode
                  ? 'border-primary bg-primary'
                  : 'border-muted-foreground'
              "
            >
              <svg
                v-if="selectedMode === option.mode"
                class="w-4 h-4 text-primary-foreground"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>

          <div class="flex-1 min-w-0">
            <div class="flex items-baseline gap-2 flex-wrap">
              <span class="text-lg font-bold">{{ option.title }}</span>
              <span v-if="option.subtitle" class="text-lg font-bold text-muted-foreground">{{
                option.subtitle
              }}</span>
              <span
                v-if="recommendedMode === option.mode"
                class="ml-1 text-sm font-semibold text-green-500"
              >
                RECOMMENDED
              </span>
              <span
                v-else-if="option.mode === 'studio' && recommendedMode === 'essentials'"
                class="ml-1 text-sm font-semibold text-amber-500"
              >
                Insufficient Hardware Detected
              </span>
            </div>

            <p class="text-sm text-muted-foreground pt-1">{{ option.description }}</p>

            <ul class="text-sm text-muted-foreground pt-2 pl-4 list-disc space-y-0.5">
              <li v-for="(feature, idx) in option.features" :key="idx">{{ feature }}</li>
            </ul>

            <p class="text-xs text-muted-foreground pt-2 italic">
              Supported Hardware: {{ option.supportedHardware }}
            </p>
          </div>
        </label>
      </div>

      <div class="flex justify-end pt-8">
        <button
          :disabled="!selectedMode"
          @click="confirmSelection"
          class="bg-primary py-2 px-8 rounded text-primary-foreground font-medium disabled:opacity-50"
        >
          Continue
        </button>
      </div>

      <div class="place-content-end flex gap-2 pt-4">
        <LanguageSelector class="max-w-40" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import LanguageSelector from '@/components/LanguageSelector.vue'

const props = defineProps<{
  recommendedMode: ProductMode | null
}>()

const emits = defineEmits<{
  (e: 'select', mode: ProductMode): void
}>()

const selectedMode = ref<ProductMode | null>(props.recommendedMode)

watch(
  () => props.recommendedMode,
  (newVal) => {
    if (newVal && !selectedMode.value) {
      selectedMode.value = newVal
    }
  },
)

const modeOptions = [
  {
    mode: 'essentials' as ProductMode,
    title: 'AI Playground',
    subtitle: 'essentials',
    description:
      'Focused feature set, purpose built for low power, lightweight, and power efficient AI PCs targeting the NPU.',
    features: [
      'Chat: Knowledge chat, document search and analysis',
      'Image Gen: Draft and HD image generation modes',
      'Image Edit: Upscale, Inpaint, Outpaint',
    ],
    supportedHardware: 'Intel Core with NPU, Intel Core Ultra Series 1U, 2U',
  },
  {
    mode: 'studio' as ProductMode,
    title: 'AI Playground',
    subtitle: 'studio',
    description:
      'Full feature set of demanding offline AI workloads across chat, vision, image and video, targeting the GPU.',
    features: [
      'Chat: Advanced chat with reasoning, vision, agentic and multi-modal chat.',
      'Image Gen: Advanced image gen with high realism and prompt adherence',
      'Image Edit: Semantic image editing, style control, and 3D model generation',
      'Video Generation Support',
    ],
    supportedHardware:
      'Intel Core Ultra Series 3, Intel Core Ultra Series 2V/2U, Intel Arc GPU Series A & B',
  },
]

function confirmSelection() {
  if (selectedMode.value) {
    emits('select', selectedMode.value)
  }
}
</script>
