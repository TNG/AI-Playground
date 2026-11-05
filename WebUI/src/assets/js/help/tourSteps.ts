import type { HelpTopicId } from '@/assets/js/help/helpTopics'
import type { PromptBarStyle } from '@/assets/js/store/promptBarStyle'

/**
 * Anchors the demo tour uses that are deliberately not click-to-learn targets.
 * The help toggle is one: help mode refuses to explain its own chrome. Everything
 * else must be a `HelpTopicId`, so renaming an id in one surface fails type-check
 * in the other instead of silently orphaning a step.
 */
export const TOUR_ONLY_ANCHORS = ['#contextual-help-toggle'] as const

type TourOnlyAnchor = (typeof TOUR_ONLY_ANCHORS)[number]

export type TourStep = {
  id: `#${HelpTopicId}` | TourOnlyAnchor
  title: string
  descr: string
  align?: 'start' | 'center' | 'end'
  /** Skipped when its anchor is not on screen. */
  optional?: boolean
}

const WELCOME_STEP: TourStep = {
  id: '#contextual-help-toggle',
  title: 'Welcome to Intel AI-Playground!',
  descr:
    'Intel AI-Playground is a generative AI app that provides local-powered chat, image, and video capabilities. Whenever you want to know what something does, click this "?" button and then click the control — help mode explains it without changing anything. Click "Next" or press "Right" to start the tour.',
}

const CLASSIC_MODE_STEPS: TourStep[] = [
  {
    id: '#mode-buttons',
    title: 'Pick your Mode',
    descr:
      'Here are multiple mode buttons, that define the type of content you are generating. Select any one of these modes later to explore each. Little dots generally indicate additional help is available when clicking the first time.',
  },
]

const MODERN_MODE_STEPS: TourStep[] = [
  {
    id: '#mode-dropdown',
    title: 'Pick your Mode',
    descr:
      'Open this menu to choose the type of work you are doing: Chat, Agent, Audio, Image Gen, Image Edit or Video. Picking a mode activates the preset you last used in it.',
  },
  {
    id: '#preset-dropdown',
    title: 'Pick a Preset',
    descr:
      'This shows the preset that will run, after the backend, device and model it runs on. Click it to pick another; each one is tuned for a task, from a chat model to an image workflow.',
    optional: true,
  },
]

const PROMPT_STEPS: TourStep[] = [
  {
    id: '#prompt-input',
    title: 'Unified Prompt',
    descr:
      'This is your Prompt field. This is the core experience of AI Playground, across all features of the app. This is where you write a prompt, add images or documents to guide your content, and select modes for the type of content you want to generate.',
  },
  {
    id: '#send-button',
    title: 'Ready to start?',
    descr:
      'This is the magic button that will start a generation. Select a mode like Chat, enter a question and click this button to get your first response.',
    align: 'end',
  },
]

/** Guided-narration copy for the demo-mode walkthrough, auto-started in demo mode. */
export function tourSteps(style: PromptBarStyle): TourStep[] {
  const modeSteps = style === 'modern' ? MODERN_MODE_STEPS : CLASSIC_MODE_STEPS
  return [WELCOME_STEP, ...modeSteps, ...PROMPT_STEPS]
}

/** Per-control copy used by the mini tours triggered from individual buttons. */
export const TOUR_STEPS_ALTERNATIVE: TourStep[] = [
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
      'Chat works like a typical AI chat. You can type questions to get information on almost any topic you can imagine. In the settings you can select from a variety of chat options where you can do document search, work with Reasoning or Vision models, and more. Click the prompt input to see a sample prompt!',
  },
  {
    id: '#mode-button-imageGen',
    title: 'Image Mode',
    descr:
      "The Image Gen mode allows you to generate images from text you enter. Describe a scene or character and style (photographic, watercolor, etc), you wish to generate, and have watching your ideas come to life. When in this mode, you'll find ready to go presets in the Inferencing tab that allow you to create images using generative models to achieve different levels of realism and generation times. Click the prompt input to see a sample prompt!",
  },
  {
    id: '#mode-button-imageEdit',
    title: 'Image Edit Mode',
    descr:
      'The Image Edit mode allows you to edit existing images or photos, often by describing what to change. Simply drag in a photo, select an editing Preset in the Inferencing tab where you can upscale images, edit images with precision, generate 3D models from images, and more. An input image is already pre-selected for you. Click the prompt input to see a sample prompt!',
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
    id: '#camera-button',
    title: 'Camera Button',
    descr:
      'Click this button to capture an image from your camera. The captured image will be added to your prompt for vision-capable models to analyze.',
  },
  {
    id: '#session-tab-inferencing',
    title: 'Inferencing and Attributes',
    descr:
      "Each Session's settings live in the Inferencing and Attributes tabs above the prompt. Inferencing is where you pick a ready to go preset and choose how it runs, from the model to Max Tokens in Chat. Attributes holds what the preset works with, from the system prompt to Aspect Ratio settings for Image Gen. Each preset is already dialed in to go, and the tabs are where you make it your own.",
    align: 'end',
  },
  {
    id: '#app-settings-button',
    title: 'Application Settings',
    descr:
      'Select this gear icon to see a list of application-level settings, from language and prompt bar style to backend status, permissions and developer options.',
  },
  {
    id: '#sessions-panel',
    title: 'Sessions',
    descr:
      'Everything you do happens in a Session, whichever presets you use. Press + to start a new Session, click one to pick up where you left off, and rename or delete it from its menu.',
  },
]
