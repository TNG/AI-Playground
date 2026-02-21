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
      <div class="tooltip-wrapper" :style="getTooltipStyle()">
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
import { useDemoMode } from '@/assets/js/store/demoMode.ts'
import { useI18N } from '@/assets/js/store/i18n'

const demoMode = useDemoMode()
const i18n = useI18N().state

/** Positions the tooltip-wrapper above the #mode-buttons element.
 *  Reading the live bounding rect keeps positioning window-size-independent. */
function getTooltipStyle(): Record<string, string> {
  const el = document.getElementById('mode-buttons')
  if (!el) return {}
  const rect = el.getBoundingClientRect()
  return {
    left: `${rect.left}px`,
    bottom: `${window.innerHeight - rect.top + 12}px`,
  }
}

function dismissDemoOverlay() {
  demoMode.chat.show = false
  demoMode.imageGen.show = false
  demoMode.imageEdit.show = false
  demoMode.video.show = false
}
</script>
