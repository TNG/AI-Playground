<template>
  <div></div>
</template>

<script setup lang="ts">
import { driver } from 'driver.js'
import 'driver.js/dist/driver.css'

type Step = {
  id: string
  title: string
  descr: string
}

type StepList = Step[]

const steps: StepList = [
  {
    id: '#demo-start-button',
    title: 'Welcome to Intel AI-Playground!',
    descr:
      'Intel AI-Playground is a generative AI app that provides local-powered chat, image, and video capabilities. You can start the tour anytime with the "Need Help?" button in the upper left. Click "Next" or press "Right" to start the tour.',
  },
  {
    id: '#chat-input',
    title: 'Add Images or Documents',
    descr:
      'Drag and drop, or use the small plus button in lower left, to add images or documents to the current conversation. You can ask questions about them, use them as context for generating new content. Or just chat.',
  },
  {
    id: '#mode-buttons',
    title: 'Pick your Mode',
    descr:
      'Chat works like a typical AI chat. The image buttons allow you to generate or edit existing images. And with video it is even possible to work on videos or 3D models.',
  },
  {
    id: '#advanced-settings-button',
    title: 'Settings',
    descr:
      'Modes have advanced settings, like presets, models, and other configurations. You can access them through this button.',
  },
  {
    id: '#send-button',
    title: 'Ready to start?',
    descr: 'Enter a message and click here to get your first response.',
  },
]

const driverObj = driver({
  showProgress: true,
  showButtons: ['next', 'previous'],
  steps: steps.map((step) => ({
    element: step.id,
    popover: {
      title: step.title,
      description: step.descr,
      side: 'top',
    },
  })),
})

function startTour() {
  driverObj.drive()
}

onMounted(() => {
  startTour()
})

defineExpose({
  startTour,
})
</script>

<style>
/* Driver.js popover styling inspired by demo-mode.css */

/* DIALOG */

.driver-popover {
  background: #0a0622;
  color: white;
  border: 1.5px solid #00c4fa;
  box-shadow: 0px 0.75px 4.95px #00c4fa;
  border-radius: 12px;
  padding: 16px 20px;
  min-width: 340px;
  max-width: 420px;
  font-family: 'Segoe UI', 'IntelOne', sans-serif;
}
.driver-popover-title {
  font-size: 1.25rem;
  font-weight: bold;
  margin-bottom: 0.5em;
  color: #00bfff;
}
.driver-popover-description {
  font-size: 1rem;
  margin-bottom: 1em;
}
.driver-popover-footer {
  background: transparent;
  border-top: 1px solid #00c4fa;
  padding-top: 1em;
}

/* BUTTON */

.driver-popover-next-btn,
.driver-popover-prev-btn {
  background: #01aef2;
  color: #fff;
  border-radius: 6px;
  font-weight: 400;
  padding: 6px 12px;
  font-size: 12px;
  width: 90px;
  height: 30px;
  border: none;
  margin: 0 0.25em;
  cursor: pointer;
  box-shadow: 0px 0.75px 4.95px #00c4fa;
  transition: background 0.2s;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.driver-popover-next-btn:hover,
.driver-popover-prev-btn:hover {
  background: #00c4fa;
}
.driver-popover-close-btn {
  color: #fff;
  background: transparent;
  border: none;
  font-size: 1.5em;
  cursor: pointer;
  position: absolute;
  top: 12px;
  right: 16px;
}

.driver-active-element {
  box-shadow: 0 0 0 5px #00bfff;
}

/* ARROW */

/* Driver.js popover arrow styling to match tooltip border color */
.driver-popover::before {
  content: '';
  position: absolute;
  width: 0;
  height: 0;
  border-left: 11px solid transparent;
  border-right: 11px solid transparent;
  border-top: 14px solid #00c4fa;
  left: 40px;
  bottom: -14px;
  z-index: 1;
}
.driver-popover::after {
  content: '';
  position: absolute;
  width: 0;
  height: 0;
  border-left: 10px solid transparent;
  border-right: 10px solid transparent;
  border-top: 12px solid #0a0622;
  left: 41px;
  bottom: -11px;
  z-index: 2;
}

/* Driver.js popover arrow styling to match tooltip border color */
.driver-popover-arrow {
  /* border-top-color: #00c4fa !important;
  border-bottom-color: #00c4fa !important;
  border-left-color: #00c4fa !important;
  border-right-color: #00c4fa !important; */
  border-left: 10px solid transparent;
  border-right: 10px solid transparent;
}

.driver-popover.driverjs-theme .driver-popover-arrow-side-left.driver-popover-arrow {
  border-left-color: #fde047;
}

.driver-popover.driverjs-theme .driver-popover-arrow-side-right.driver-popover-arrow {
  border-right-color: #fde047;
}

.driver-popover.driverjs-theme .driver-popover-arrow-side-top.driver-popover-arrow {
  border-top-color: #fde047;
}

.driver-popover.driverjs-theme .driver-popover-arrow-side-bottom.driver-popover-arrow {
  border-bottom-color: #fde047;
}
</style>
