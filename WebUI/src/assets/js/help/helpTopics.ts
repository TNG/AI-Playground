export type HelpTopicId =
  | 'prompt-input'
  | 'plus-icon'
  | 'mode-buttons'
  | 'mode-button-chat'
  | 'mode-button-imageGen'
  | 'mode-button-imageEdit'
  | 'mode-button-video'
  | 'send-button'
  | 'camera-button'
  | 'microphone-button'
  | 'advanced-settings-button'
  | 'advanced-settings-sidebar'
  | 'app-settings-button'
  | 'app-settings-sidebar'
  | 'show-history-button'

export type HelpTopic = {
  title: string
  body: string
}

/** POC copy — aligned with demo tour text; move to i18n when productizing. */
export const HELP_TOPICS: Record<HelpTopicId, HelpTopic> = {
  'prompt-input': {
    title: 'Unified Prompt',
    body: 'Write prompts here for every mode. Attach images or documents (plus icon or drag-and-drop) to guide chat, image edit, or other workflows.',
  },
  'plus-icon': {
    title: 'Add images or documents',
    body: 'Load files into the prompt or drag and drop onto the field. In Chat, ask about documents or images. For Image Edit, add images to edit. Use Prompt Settings presets (Vision, RAG, etc.) if a file type is not supported.',
  },
  'mode-buttons': {
    title: 'Pick your mode',
    body: 'These buttons switch what you generate: Chat, Image Gen, Image Edit, or Video. Each mode has its own presets and settings.',
  },
  'mode-button-chat': {
    title: 'Chat mode',
    body: 'Ask questions like a typical AI chat. In Prompt Settings, choose models and options such as RAG, reasoning, or vision.',
  },
  'mode-button-imageGen': {
    title: 'Image Gen mode',
    body: 'Describe a scene, character, or style to generate images. Presets in Prompt Settings control quality, speed, and look.',
  },
  'mode-button-imageEdit': {
    title: 'Image Edit mode',
    body: 'Edit photos by describing changes. Use presets to upscale, inpaint, outpaint, create 3D from images, and more.',
  },
  'mode-button-video': {
    title: 'Video mode',
    body: 'Create short video clips from text prompts, optionally guided by reference images or video.',
  },
  'send-button': {
    title: 'Send',
    body: 'Starts generation for the current mode. While a run is in progress this becomes Stop.',
  },
  'camera-button': {
    title: 'Camera',
    body: 'Capture a photo from your camera and attach it to the prompt for vision-capable chat models.',
  },
  'microphone-button': {
    title: 'Microphone',
    body: 'Record speech into the prompt after Speech to Text is enabled in App Settings.',
  },
  'advanced-settings-button': {
    title: 'Prompt settings',
    body: 'Mode-specific presets and options: model, tokens, aspect ratio, seeds, and more. This is where you tune each workflow.',
  },
  'advanced-settings-sidebar': {
    title: 'Prompt settings panel',
    body: 'Browse presets and adjust parameters for the active mode. Changes apply to the next generation.',
  },
  'app-settings-button': {
    title: 'App settings',
    body: 'Language, theme, backend installation, speech mode, and other application-wide options.',
  },
  'app-settings-sidebar': {
    title: 'App settings panel',
    body: 'Configure backends, appearance, and global features from this sidebar.',
  },
  'show-history-button': {
    title: 'History',
    body: 'Reopen past chat and generation history across modes.',
  },
}

export function getHelpTopic(id: string): HelpTopic | undefined {
  return HELP_TOPICS[id as HelpTopicId]
}

const MODE_BUTTON_PREFIX = 'mode-button-'

export function resolveHelpTarget(from: EventTarget | null): {
  topicId: HelpTopicId
  element: HTMLElement
} | null {
  let el = from instanceof HTMLElement ? from : null
  while (el && el !== document.body) {
    if (el.id === 'contextual-help-toggle' || el.closest('#contextual-help-panel')) {
      return null
    }
    const attr = el.getAttribute('data-aipg-help')
    if (attr && getHelpTopic(attr)) {
      return { topicId: attr as HelpTopicId, element: el }
    }
    if (el.id && getHelpTopic(el.id)) {
      return { topicId: el.id as HelpTopicId, element: el }
    }
    if (el.id === 'mode-buttons') {
      return { topicId: 'mode-buttons', element: el }
    }
    if (el.id.startsWith(MODE_BUTTON_PREFIX) && getHelpTopic(el.id)) {
      return { topicId: el.id as HelpTopicId, element: el }
    }
    el = el.parentElement
  }
  return null
}

export function isHelpAnnotatedElement(el: HTMLElement): boolean {
  return resolveHelpTarget(el) !== null
}
