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
    id: '#demo-start-button',
    title: 'Welcome to Intel AI-Playground!',
    descr:
      'Intel AI-Playground is a generative AI app that provides local-powered chat, image, and video capabilities. You can start the tour anytime with the "Need Help?" button in the upper right. Click "Next" or press "Right" to start the tour.',
  },
  {
    id: '#prompt-input',
    title: 'Unified Prompt',
    descr:
      "This is your Prompt field. This is the core experience of AI Playground, across all features of the app. This is where you write a prompt, add images or documents to guide your content, and select modes for the type of content you want to generate. Click continue to explore what's here ",
  },
  {
    id: '#plus-icon',
    title: 'Add Images or Documents',
    descr:
      "The PLUS icon allows you to load content like documents or images to the prompt. Alternatively you can also drag and drop content here. When added this content is part of your generation. In Chat mode you can ask questions about a document or an image. For Image Edit you can add images you want to edit. Note: If you're not able to load a certain type of document, check Prompt Settings as you might need to select a preset like Vision to support images, or RAG to support text documents",
  },
  {
    id: '#mode-buttons',
    title: 'Pick your Mode',
    descr:
      "Here are multiple mode buttons, that define the type of content you are generating.  Select any one of these modes. Let's explore each",
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
    id: '#send-button',
    title: 'Ready to start?',
    descr:
      'This is the magic button that starts generation. Select a mode like Chat, enter a question and click this button to get your first response.',
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

onMounted(() => {
  //startTour()
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
  padding-top: 0.5rem;
}

/* BUTTON */

.driver-popover-footer button {
  background: transparent;
  border: none;
  color: #00c4fa;
  font-weight: bold;
  cursor: pointer;
  font-size: 18px;
  float: right;
  text-shadow: none;
}

.driver-popover-footer button:hover,
.driver-popover-footer button:hover {
  //background: #00c4fa;
  background-color: transparent;
  text-decoration: underline;
  //color: #3bc8ff;
}

.driver-popover-footer button:focus {
  background: transparent;
  //outline: 1px solid orange;
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

.driver-popover-close-btn:hover,
.driver-popover-close-btn:focus {
  color: #fff;
}

/* HIGHLIGHTED ELEMENT */

.driver-active-element {
  /* box-shadow: 0 0 0 5px #00bfff; */
  /* outline: 5px solid #00bfff; */
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
  border: 10px solid transparent;
}

.driver-popover-arrow-side-left.driver-popover-arrow {
  border-left-color: #00c4fa;
}

.driver-popover-arrow-side-right.driver-popover-arrow {
  border-right-color: #00c4fa;
}

.driver-popover-arrow-side-top.driver-popover-arrow {
  border-top-color: #00c4fa;
}

.driver-popover-arrow-side-bottom.driver-popover-arrow {
  border-bottom-color: #00c4fa;
}

.driver-popover::before,
.driver-popover::after {
  display: none !important;
}

/* downward-facing triangle */
.driver-popover-arrow.driver-popover-arrow-side-top {
  border-top: 14px solid #00c4fa;
  border-left: 11px solid transparent;
  border-right: 11px solid transparent;
  border-bottom: none;
  background: transparent;
}

.driver-popover-arrow.driver-popover-arrow-side-top::after {
  content: '';
  position: absolute;
  border-top: 12px solid #0a0622;
  border-left: 10px solid transparent;
  border-right: 10px solid transparent;
  border-bottom: none;
  bottom: 3px;
  transform: translateX(-50%);
}

/* rightward-facing triangle */
.driver-popover-arrow.driver-popover-arrow-side-left {
  border-left: 14px solid #00c4fa;
  border-top: 11px solid transparent;
  border-bottom: 11px solid transparent;
  border-right: none;
}

.driver-popover-arrow.driver-popover-arrow-side-left::after {
  content: '';
  position: absolute;
  border-left: 12px solid #0a0622;
  border-top: 10px solid transparent;
  border-bottom: 10px solid transparent;
  border-right: none;
  right: 3px;
  transform: translateY(-50%);
}

/* upward-facing triangle */
.driver-popover-arrow.driver-popover-arrow-side-bottom {
  border-bottom: 14px solid #00c4fa;
  border-left: 11px solid transparent;
  border-right: 11px solid transparent;
  border-top: none;
}

.driver-popover-arrow.driver-popover-arrow-side-bottom::after {
  content: '';
  position: absolute;
  border-bottom: 12px solid #0a0622;
  border-left: 10px solid transparent;
  border-right: 10px solid transparent;
  border-top: none;
  top: 3px;
  transform: translateX(-50%);
}

/* leftward-facing triangle */
.driver-popover-arrow.driver-popover-arrow-side-right {
  border-right: 14px solid #00c4fa;
  border-top: 11px solid transparent;
  border-bottom: 11px solid transparent;
  border-left: none;
}

.driver-popover-arrow.driver-popover-arrow-side-right::after {
  content: '';
  position: absolute;
  border-right: 12px solid #0a0622;
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
