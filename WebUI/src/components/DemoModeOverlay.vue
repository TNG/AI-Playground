<template>
  <transition name="fade">
    <div
      class="demo-mode-overlay"
      v-if="
        demoMode.chat.show ||
        demoMode.imageGen.show ||
        demoMode.imageEdit.show ||
        demoMode.video.show
      "
    >
      <!-- Center Heading -->
      <div class="center-popup">
        <p v-if="demoMode.chat.show">{{ i18n.DEMO_CHAT_HEADING }}</p>
        <p v-else-if="demoMode.imageGen.show">{{ i18n.DEMO_IMAGE_GEN_HEADING }}</p>
        <p v-else-if="demoMode.imageEdit.show">{{ i18n.DEMO_IMAGE_EDIT_HEADING }}</p>
        <p v-else-if="demoMode.video.show">{{ i18n.DEMO_VIDEO_HEADING }}</p>
      </div>

      <!-- tooltips -->
      <div class="tooltip-wrapper" :style="tooltipStyle">
        <div class="tooltip-box">
          <!-- chat tooltip -->
          <template v-if="demoMode.chat.show">
            <div class="tooltip-row">
              <div class="tooltip-circle">1</div>
              <div>
                <p>{{ i18n.DEMO_CHAT_GENERATE_TEXT }}</p>
                <p class="content-tooltip">
                  <em>{{ i18n.DEMO_YOU_COULD_TYPE }}</em>
                  <span>"{{ i18n.DEMO_CHAT_GENERATE_HELP_TEXT }}"</span>
                </p>
              </div>
            </div>
          </template>

          <!-- image gen tooltip -->
          <template v-else-if="demoMode.imageGen.show">
            <div class="tooltip-row">
              <div class="tooltip-circle">1</div>
              <p>{{ i18n.DEMO_IMAGE_GEN_POPUP_CONTENT_1 }}</p>
            </div>
            <p class="content-tooltip">
              <em>{{ i18n.DEMO_YOU_COULD_TYPE }}</em>
              <em>"{{ i18n.DEMO_IMAGE_GEN_POPUP_CONTENT_3 }}"</em>.
            </p>
          </template>

          <!-- image edit tooltip -->
          <template v-else-if="demoMode.imageEdit.show">
            <div class="tooltip-row">
              <div class="tooltip-circle">1</div>
              <p>{{ i18n.DEMO_IMAGE_EDIT_IMAGE_TEXT }}</p>
            </div>
            <div class="tooltip-row">
              <div class="tooltip-circle">2</div>
              <p>{{ i18n.DEMO_IMAGE_EDIT_IMAGE_TEXT_2 }}</p>
            </div>
          </template>

          <!-- video tooltip -->
          <template v-else-if="demoMode.video.show">
            <div class="tooltip-row">
              <div class="tooltip-circle">1</div>
              <p>{{ i18n.DEMO_VIDEO_TOOLTIP_TEXT }}</p>
            </div>
          </template>

          <!-- "Got it" button -->
          <div class="got-it-btn">
            <button class="tooltip-button" @click.stop="dismissDemoOverlay">
              {{ i18n.DEMO_OK_GOT_IT }} &#8594;
            </button>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useDemoMode } from '@/assets/js/store/demoMode.ts'
import { useI18N } from '@/assets/js/store/i18n'

const demoMode = useDemoMode()
const i18n = useI18N().state

const activeMode = computed(() => {
  if (demoMode.chat.show) return 'chat'
  if (demoMode.imageGen.show) return 'imageGen'
  if (demoMode.imageEdit.show) return 'imageEdit'
  if (demoMode.video.show) return 'video'
  return null
})

const tooltipStyle = ref<Record<string, string>>({})

watch(activeMode, updateTooltipPosition)

onMounted(() => {
  updateTooltipPosition()
  window.addEventListener('resize', updateTooltipPosition)
})

onUnmounted(() => {
  window.removeEventListener('resize', updateTooltipPosition)
})

const TOOLTIP_WIDTH = 400 // matches .tooltip-box width in demo-mode.css
const TOOLTIP_GAP = 8 // matches --demo-mode-tooltip-gap in demo-mode.css
const TOOLTIP_BORDER = 1.5 // matches .tooltip-box border: 1.5px in demo-mode.css
const ARROW_HEIGHT = 12 // matches .tooltip-box::after border-top: 12px in demo-mode.css
const ARROW_HALF_WIDTH = 10 // matches .tooltip-box::after border-left/right: 10px in demo-mode.css

/**
 * Position the tooltip above the active mode button
 */
function updateTooltipPosition() {
  const mode = activeMode.value
  if (!mode) {
    tooltipStyle.value = {}
    return
  }
  
  const targetElementId = `mode-button-${mode}`

  const rect = getButtonRect(targetElementId)
  if (!rect) {
    tooltipStyle.value = {}
    return
  }

  // position the tooltip
  const tooltipLeft = Math.min(Math.max(rect.left, 8), window.innerWidth - TOOLTIP_WIDTH - 8)
  const tooltipBottom = window.innerHeight - rect.top + ARROW_HEIGHT + TOOLTIP_GAP

  // position the arrow
  const tooltipCenter = rect.left + rect.width / 2
  const arrowLeft = tooltipCenter - tooltipLeft - ARROW_HALF_WIDTH + TOOLTIP_BORDER

  tooltipStyle.value = {
    bottom: `${tooltipBottom}px`,
    left: `${tooltipLeft}px`,
    '--arrow-left': `${arrowLeft}px`,
  }
}

function getButtonRect(targetElementId: string) {
  const el = document.getElementById(targetElementId)
  return el ? el.getBoundingClientRect() : null
}

function dismissDemoOverlay() {
  demoMode.chat.show = false
  demoMode.imageGen.show = false
  demoMode.imageEdit.show = false
  demoMode.video.show = false
}
</script>
