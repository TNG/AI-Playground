// ── The built-in tool catalog, shared by the settings UI and the model-facing
// tool-availability prompt ─────────────────────────────────────────────────────
//
// One place describes what every built-in tool is and does, so the settings
// checkboxes (SettingsBuiltinTools.vue) and the system-prompt availability
// block (toolAvailabilityPrompt.ts) can never drift apart.

export type BuiltinToolInfo = {
  /** Tool name as registered in `aipgTools`. */
  name: string
  /** User-facing label: the settings checkbox, and how the prompt names it. */
  label: string
  /** One sentence about what the tool does; the settings tooltip shows it. */
  description: string
}

/**
 * Tools that share browseWeb's single "Browse the web" enablement toggle: they
 * all act on the same background browser browseWeb drives.
 */
export const WEB_COMPANION_TOOLS: ReadonlySet<string> = new Set([
  'searchWeb',
  'interactWithWebPage',
  'screenshotWebPage',
])

/** The enablement key that governs a tool: browseWeb's, or its own name. */
export function enablementKeyOf(toolName: string): string {
  return WEB_COMPANION_TOOLS.has(toolName) ? 'browseWeb' : toolName
}

// User-facing descriptors for the built-in (internal) tools. Keys must match
// the tool names registered in `aipgTools`.
export const builtinToolsCatalog: readonly BuiltinToolInfo[] = [
  {
    name: 'comfyUI',
    label: 'Generate media',
    description: 'Create images, videos, or 3D models from text prompts.',
  },
  {
    name: 'comfyUiImageEdit',
    label: 'Transform image',
    description:
      'Edit, upscale, colorize, or convert an existing image into a new image, video, or 3D model.',
  },
  {
    name: 'visualizeObjectDetections',
    label: 'Visualize detections',
    description: 'Draw bounding boxes and labels on a detected image.',
  },
  {
    name: 'captureScreenshot',
    label: 'Capture screenshot',
    description:
      'Let the assistant capture a single user-selected window to visually debug other apps.',
  },
  {
    name: 'browseWeb',
    label: 'Browse the web',
    description:
      'Let the assistant search the web, open pages in a background browser to read their ' +
      'content, and (on vision models) capture a screenshot of a page.',
  },
]

// Speech is presented as a single "Speech" group (like "Generate media") whose
// children are the two independent speech tools.
export const speechToolsCatalog: readonly BuiltinToolInfo[] = [
  {
    name: 'synthesizeTextToSpeech',
    label: 'Text To Speech',
    description:
      'Let the assistant turn text into spoken audio with a choice of voices and languages.',
  },
  {
    name: 'transcribeAudio',
    label: 'Speech To Text',
    description:
      'Let the assistant transcribe an attached voice message or audio file into text with Whisper.',
  },
]

/** Every user-pickable built-in tool, settings order. */
export const allBuiltinToolsCatalog: readonly BuiltinToolInfo[] = [
  ...builtinToolsCatalog,
  ...speechToolsCatalog,
]
