import type { MediaRerun } from '@/lib/turnTypes'
import type { MediaTurnData } from '@/types/sessionTimeline'

const IMAGE_INPUT_TYPES = new Set(['image', 'inpaintMask', 'outpaintCanvas'])

/** Nothing to rerun when the run recorded no settings or lost an input image it needed. */
export function mediaRerun(media: MediaTurnData, promptText: string): MediaRerun | null {
  const item = media.items[0]
  if (!item?.settings) return null
  const settings = item.settings
  let fallbackSource = item.sourceImageUrl
  let inputImageUrl: string | undefined
  const inputs: Record<string, unknown> = {}
  for (const input of item.dynamicSettings ?? []) {
    let current: unknown = input.current
    if (IMAGE_INPUT_TYPES.has(input.type) && !current && input.optional !== true) {
      if (input.type !== 'image' || !fallbackSource) return null
      current = fallbackSource
      fallbackSource = undefined
    }
    if (input.type === 'image' && current && !inputImageUrl) inputImageUrl = String(current)
    inputs[`${input.nodeTitle}.${input.nodeInput}`] = current
  }
  const [resolutionWidth, resolutionHeight] =
    typeof settings.resolution === 'string' ? settings.resolution.split('x').map(Number) : []
  const params = Object.fromEntries(
    Object.entries({
      seed: -1,
      inferenceSteps: settings.inferenceSteps,
      width: settings.width ?? resolutionWidth,
      height: settings.height ?? resolutionHeight,
      batchSize: settings.batchSize,
    }).filter(([, value]) => typeof value === 'number' && !Number.isNaN(value)),
  ) as MediaRerun['params']
  return {
    mode: media.mode,
    workflow: media.preset,
    ...(media.variant ? { variant: media.variant } : {}),
    prompt: settings.prompt ?? promptText,
    ...(settings.negativePrompt !== undefined ? { negativePrompt: settings.negativePrompt } : {}),
    params,
    inputs,
    ...(media.mode !== 'imageGen' && inputImageUrl ? { inputImageUrl } : {}),
  }
}
