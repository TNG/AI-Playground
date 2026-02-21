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

/** Which mode's overlay is currently active. */
const activeMode = computed(() => {
  if (demoMode.chat.show) return 'chat'
  if (demoMode.imageGen.show) return 'imageGen'
  if (demoMode.imageEdit.show) return 'imageEdit'
  if (demoMode.video.show) return 'video'
  return null
})

const buttonRect = ref<DOMRect | null>(null)

function updateRect() {
  const mode = activeMode.value
  if (!mode) {
    buttonRect.value = null
    return
  }
  const el = document.getElementById(`mode-button-${mode}`)
  buttonRect.value = el ? el.getBoundingClientRect() : null
}

watch(activeMode, updateRect)

onMounted(() => {
  updateRect()
  window.addEventListener('resize', updateRect)
})

onUnmounted(() => {
  window.removeEventListener('resize', updateRect)
})

const TOOLTIP_WIDTH = 400
const ARROW_HALF_WIDTH = 11 // matches border-left/right in CSS ::before/::after

/**
 * Position the tooltip above the active mode button and align the arrow tip to
 * the horizontal centre of that button. The tooltip is left-clamped so it never
 * overflows the viewport.
 *
 * --arrow-left is a CSS custom property consumed by .tooltip-box::before/::after
 * to override their default left offset.
 */
const tooltipStyle = computed(() => {
  const rect = buttonRect.value
  if (!rect) return {}
  const tooltipLeft = Math.min(Math.max(rect.left, 8), window.innerWidth - TOOLTIP_WIDTH - 8)
  const arrowLeft = rect.left + rect.width / 2 - tooltipLeft - ARROW_HALF_WIDTH
  return {
    left: `${tooltipLeft}px`,
    bottom: `${window.innerHeight - rect.top + 12}px`,
    '--arrow-left': `${Math.max(arrowLeft, 8)}px`,
  }
})

function dismissDemoOverlay() {
  demoMode.chat.show = false
  demoMode.imageGen.show = false
  demoMode.imageEdit.show = false
  demoMode.video.show = false
}
</script>
