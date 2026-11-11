import { InferUITools, ToolSet } from 'ai'
import { visualizeObjectDetections } from './visualizeObjectDetections'
import { comfyUI } from './comfyUi'
import { comfyUiImageEdit } from './comfyUiImageEdit'
import { media } from './media'
import { captureScreenshot } from './captureScreenshot'
import { browseWeb, interactWithWebPage, screenshotWebPage, searchWeb } from './browseWeb'
import { synthesizeTextToSpeech } from './synthesizeTextToSpeech'
import { transcribeAudio } from './transcribeAudio'
import { sessionHistory } from './sessionHistory'

export const aipgTools = {
  comfyUI,
  comfyUiImageEdit,
  // Thin delegation tool replacing the two comfy tools when
  // textInference.toolDelegationEnabled — see resolveBuiltinTools().
  media,
  visualizeObjectDetections,
  captureScreenshot,
  searchWeb,
  browseWeb,
  interactWithWebPage,
  screenshotWebPage,
  synthesizeTextToSpeech,
  transcribeAudio,
} satisfies ToolSet

export type AipgTools = InferUITools<typeof aipgTools>

/** Offered to a tool-enabled chat turn in a Session; not a user-pickable tool. */
export const sessionTools = {
  session_history: sessionHistory,
} satisfies ToolSet
