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
  align?: 'start' | 'center' | 'end'
}

type StepList = Step[]

const steps: StepList = [
  {
    id: '#demo-buttons-group',
    title: 'Welcome to Intel AI-Playground!',
    descr:
      'Intel AI-Playground is a generative AI app that provides local-powered chat, image, and video capabilities. You can start the tour anytime with the "Start Tour" button in the upper right, and get context-specific help with the "Need Help" button. Click "Next" or press "Right" to start the tour.',
  },
  {
    id: '#mode-buttons',
    title: 'Pick your Mode',
    descr:
      'Here are multiple mode buttons, that define the type of content you are generating.  Select any one of these modes later to explore each.',
  },
  {
    id: '#prompt-input',
    title: 'Unified Prompt',
    descr:
      "This is your Prompt field. This is the core experience of AI Playground, across all features of the app. This is where you write a prompt, add images or documents to guide your content, and select modes for the type of content you want to generate. Click continue to explore what's here ",
  },
  {
    id: '#send-button',
    title: 'Ready to start?',
    descr:
      'This is the magic button that starts generation. Select a mode like Chat, enter a question and click this button to get your first response.',
    align: 'end',
  },
]

const stepsAlternative: StepList = [
  {
    id: '#plus-icon',
    title: 'Add Images or Documents',
    descr:
      "The PLUS icon allows you to load content like documents or images to the prompt. Alternatively you can also drag and drop content here. When added this content is part of your generation. In Chat mode you can ask questions about a document or an image. For Image Edit you can add images you want to edit. Note: If you're not able to load a certain type of document, check Prompt Settings as you might need to select a preset like Vision to support images, or RAG to support text documents",
  },
  {
    id: '#mode-button-chat',
    title: 'Chat Mode',
    descr:
      'Chat works like a typical AI chat. You can type questions to get information on almost any topic you can imagine. In the settings you can select from a variety of chat options where you can do document search, work with Reasoning or Vision models, and more.',
  },
  {
    id: '#mode-button-imageGen',
    title: 'Image Mode',
    descr:
      "The Image Gen mode allows you to generate images from text you enter. Describe a scene or character and style (photographic, watercolor, etc), you wish to generate, and have watching your ideas come to life. When in this mode, you'll find ready to go presets in the Prompt Settings that allow you to create images using generative models to achieve different levels of realism and generation times.",
  },
  {
    id: '#mode-button-imageEdit',
    title: 'Image Edit Mode',
    descr:
      'The Image Edit mode allows you to edit existing images or photos, often by describing what to change.  Simply drag in a photo, select an editing Preset in Prompt Settings where you can upscale images, edit images with precision, generate 3 Models from images, and more.',
  },
  {
    id: '#mode-button-video',
    title: 'Video Mode',
    descr:
      'Video generation allows you to create short video clips from your imagination either from prompt or guided by images and video.',
  },
  {
    id: '#microphone-button',
    title: 'Mic Button',
    descr:
      "The Mic button is only active after you've selected and turned on Speech Mode in app settings.When done you simply click this icon, start talking in a language you're comfortable speaking, then click again. You'll see your speech written out as text in the prompt field.",
  },
  {
    id: '#advanced-settings-button',
    title: 'Prompt Settings',
    descr:
      'Each mode has prompt settings specific to the mode of content you are generating. Here you will find ready to go preset to do targeted tasks. Each preset is already dialed in to go, but you choose to adjust options and own values from Max Tokens in Chat, to Aspect Ratio settings for Image Gen. Prompt settings is at the heart of getting AI Playground to do what you want it to do. Select a Mode and explore what our Prompt Settings have to offer.',
    align: 'end',
  },
  {
    id: '#app-settings-button',
    title: 'Application Settings',
    descr:
      "Select this gear icon to see a list of application-level settings, from to language options, installation manager, and speech mode. You'll find important application settings here. Click here and select the Theme menu to give AI Playground different looks.",
  },
  {
    id: '#show-history-button',
    title: 'History Panel',
    descr:
      "The History Panel keeps track of all that you've generated. History will show you the latest content from each mode you used. Use this to scroll back through and revisit previous discussion and content generated from AI Playground.",
  },
]

const driverObj = driver({
  showProgress: true,
  showButtons: ['next', 'previous', 'close'],
  doneBtnText: 'Got it!',
  popoverOffset: 20,
  steps: steps.map((step) => ({
    element: step.id,
    popover: {
      title: step.title,
      description: step.descr,
      side: 'top',
      align: step.align,
    },
  })),
})

function startTour() {
  driverObj.drive()
}

function startMiniTour(stepId: string, highlightElement?: string) {
  const step = stepsAlternative.find((s) => s.id === stepId)
  if (!step) {
    console.warn(`startMiniTour: No step found for stepId "${stepId}"`)
    return
  }

  const elementToHighlight = highlightElement || stepId
  const domElement = document.querySelector(elementToHighlight)
  if (!domElement) {
    console.warn(`startMiniTour: DOM element "${elementToHighlight}" not found`)
  }

  const miniDriver = driver({
    showProgress: false,
    showButtons: ['close'],
    doneBtnText: 'Got it!',
    popoverOffset: 20,
    steps: [
      {
        element: elementToHighlight,
        popover: {
          title: step.title,
          description: step.descr,
          side: 'top' as const,
          align: step.align,
        },
      },
      // second step: sample prompt (if needed)
    ],
  })
  miniDriver.drive()
}

type ContextHelpTarget = ModeType | 'app-settings' | 'advanced-settings'

function triggerContextHelp(target: ContextHelpTarget) {
  const targetConfig: Record<ContextHelpTarget, { stepId: string; highlightElement: string }> = {
    chat: { stepId: '#mode-button-chat', highlightElement: '#prompt-input' },
    imageGen: { stepId: '#mode-button-imageGen', highlightElement: '#prompt-input' },
    imageEdit: { stepId: '#mode-button-imageEdit', highlightElement: '#prompt-input' },
    video: { stepId: '#mode-button-video', highlightElement: '#prompt-input' },
    'app-settings': { stepId: '#app-settings-button', highlightElement: '#app-settings-button' },
    'advanced-settings': {
      stepId: '#advanced-settings-button',
      highlightElement: '#advanced-settings-button',
    },
  }
  const config = targetConfig[target]
  if (config) {
    startMiniTour(config.stepId, config.highlightElement)
  }
}

defineExpose({
  startTour,
  triggerContextHelp,
})
</script>

<style>
/* Driver.js popover styling inspired by demo-mode.css */

/* DIALOG */

.driver-popover * {
  font-family: 'IntelOne';
}

.driver-popover {
  background: var(--demo-popover-bg);
  color: var(--demo-text-color);
  border: 1.5px solid var(--demo-popover-border);
  box-shadow: 0px 0.75px 4.95px var(--demo-popover-shadow);
  border-radius: 12px;
  padding: 16px 20px;
  min-width: 340px;
  max-width: 420px;
  font-family: unset;
}

.driver-popover-title {
  font-size: 1.25rem;
  font-weight: bold;
  margin-bottom: 0.5em;
  color: var(--demo-title-color);
  font-family: unset;
}

.driver-popover-description {
  font-size: 1rem;
  margin-bottom: 1em;
  font-family: unset;
}

.driver-popover-footer {
  background: transparent;
  border-top: 1px solid var(--demo-popover-border);
  padding-top: 0.5rem;
  font-family: unset;
}

.driver-popover-progress-text {
  font-family: unset;
}

/* BUTTON */

.driver-popover-footer button {
  background: transparent;
  border: none;
  color: var(--demo-button-color);
  font-weight: bold;
  cursor: pointer;
  font-size: 18px;
  float: right;
  text-shadow: none;
  font-family: unset;
}

.driver-popover-footer button:hover,
.driver-popover-footer button:hover {
  background-color: transparent;
  text-decoration: underline;
}

.driver-popover-footer button:focus {
  background: transparent;
}

.driver-popover-close-btn {
  color: var(--demo-text-color);
  background: transparent;
  border: none;
  font-size: 1.5em;
  cursor: pointer;
  position: absolute;
  top: 12px;
  right: 16px;
}

.driver-popover-close-btn:hover,
.driver-popover-close-btn:focus {
  color: var(--demo-text-color);
}

/* HIGHLIGHTED ELEMENT */

.driver-active-element {
  /* Styling handled by driver.js */
}

/* ARROW */

.driver-popover-arrow {
  border: 10px solid transparent;
}

.driver-popover-arrow-side-left.driver-popover-arrow {
  border-left-color: var(--demo-popover-border);
}

.driver-popover-arrow-side-right.driver-popover-arrow {
  border-right-color: var(--demo-popover-border);
}

.driver-popover-arrow-side-top.driver-popover-arrow {
  border-top-color: var(--demo-popover-border);
}

.driver-popover-arrow-side-bottom.driver-popover-arrow {
  border-bottom-color: var(--demo-popover-border);
}

.driver-popover::before,
.driver-popover::after {
  display: none !important;
}

/* downward-facing triangle */
.driver-popover-arrow.driver-popover-arrow-side-top {
  border-top: 14px solid var(--demo-popover-border);
  border-left: 11px solid transparent;
  border-right: 11px solid transparent;
  border-bottom: none;
  background: transparent;
}

.driver-popover-arrow.driver-popover-arrow-side-top::after {
  content: '';
  position: absolute;
  border-top: 12px solid var(--demo-popover-bg);
  border-left: 10px solid transparent;
  border-right: 10px solid transparent;
  border-bottom: none;
  bottom: 3px;
  transform: translateX(-50%);
}

/* rightward-facing triangle */
.driver-popover-arrow.driver-popover-arrow-side-left {
  border-left: 14px solid var(--demo-popover-border);
  border-top: 11px solid transparent;
  border-bottom: 11px solid transparent;
  border-right: none;
}

.driver-popover-arrow.driver-popover-arrow-side-left::after {
  content: '';
  position: absolute;
  border-left: 12px solid var(--demo-popover-bg);
  border-top: 10px solid transparent;
  border-bottom: 10px solid transparent;
  border-right: none;
  right: 3px;
  transform: translateY(-50%);
}

/* upward-facing triangle */
.driver-popover-arrow.driver-popover-arrow-side-bottom {
  border-bottom: 14px solid var(--demo-popover-border);
  border-left: 11px solid transparent;
  border-right: 11px solid transparent;
  border-top: none;
}

.driver-popover-arrow.driver-popover-arrow-side-bottom::after {
  content: '';
  position: absolute;
  border-bottom: 12px solid var(--demo-popover-bg);
  border-left: 10px solid transparent;
  border-right: 10px solid transparent;
  border-top: none;
  top: 3px;
  transform: translateX(-50%);
}

/* leftward-facing triangle */
.driver-popover-arrow.driver-popover-arrow-side-right {
  border-right: 14px solid var(--demo-popover-border);
  border-top: 11px solid transparent;
  border-bottom: 11px solid transparent;
  border-left: none;
}

.driver-popover-arrow.driver-popover-arrow-side-right::after {
  content: '';
  position: absolute;
  border-right: 12px solid var(--demo-popover-bg);
  border-top: 10px solid transparent;
  border-bottom: 10px solid transparent;
  border-left: none;
  left: 3px;
  transform: translateY(-50%);
}

/* arrow position within the popup */
.driver-popover-arrow-side-top.driver-popover-arrow-align-start,
.driver-popover-arrow-side-bottom.driver-popover-arrow-align-start {
  left: 30px;
}

.driver-popover-arrow-side-top.driver-popover-arrow-align-end,
.driver-popover-arrow-side-bottom.driver-popover-arrow-align-end {
  right: 20px;
}
</style>
