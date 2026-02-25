import { describe, it, expect } from 'vitest'
import { isBase64ImageDataUri } from '@/lib/utils'

type MediaItem = {
  id: string
  state: string
  mode: string
  type: string
  imageUrl?: string
  sourceImageUrl?: string
  createdAt?: number
}

/**
 * Serializer logic extracted from imageGenerationPresets store for testing.
 */
function serializeGeneratedImages(images: MediaItem[]): MediaItem[] {
  return images
    .filter((img) => img && img.state === 'done')
    .map((img) => {
      const cleaned = { ...img }
      if ('imageUrl' in cleaned && isBase64ImageDataUri(cleaned.imageUrl as string)) {
        cleaned.imageUrl = ''
      }
      if ('sourceImageUrl' in cleaned && isBase64ImageDataUri(cleaned.sourceImageUrl as string)) {
        cleaned.sourceImageUrl = ''
      }
      return cleaned
    })
}

function serializeComfyInputs(
  comfyInputsPerPreset: Record<string, Record<string, unknown> | undefined>,
): Record<string, Record<string, unknown> | undefined> {
  const filteredInputs: typeof comfyInputsPerPreset = {}
  Object.entries(comfyInputsPerPreset)
    .filter(([_, inputs]) => inputs !== undefined)
    .forEach(([presetName, inputs]) => {
      filteredInputs[presetName] = Object.fromEntries(
        Object.entries(inputs as Record<string, unknown>).filter(
          ([_, value]) => typeof value !== 'string' || !isBase64ImageDataUri(value),
        ),
      )
    })
  return filteredInputs
}

describe('imageGenerationPresets serializer', () => {
  describe('generatedImages', () => {
    it('preserves aipg-media:// URLs in imageUrl', () => {
      const images: MediaItem[] = [
        {
          id: '1',
          state: 'done',
          mode: 'imageGen',
          type: 'image',
          imageUrl: 'aipg-media://output/img1.png',
          createdAt: 1000,
        },
      ]

      const result = serializeGeneratedImages(images)
      expect(result[0].imageUrl).toBe('aipg-media://output/img1.png')
    })

    it('strips base64 from imageUrl', () => {
      const images: MediaItem[] = [
        {
          id: '1',
          state: 'done',
          mode: 'imageEdit',
          type: 'image',
          imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
          createdAt: 1000,
        },
      ]

      const result = serializeGeneratedImages(images)
      expect(result[0].imageUrl).toBe('')
    })

    it('strips base64 from sourceImageUrl', () => {
      const images: MediaItem[] = [
        {
          id: '1',
          state: 'done',
          mode: 'imageEdit',
          type: 'image',
          imageUrl: 'aipg-media://output/result.png',
          sourceImageUrl: 'data:image/jpeg;base64,/9j/4AAQ',
          createdAt: 1000,
        },
      ]

      const result = serializeGeneratedImages(images)
      expect(result[0].imageUrl).toBe('aipg-media://output/result.png')
      expect(result[0].sourceImageUrl).toBe('')
    })

    it('filters out non-done images', () => {
      const images: MediaItem[] = [
        { id: '1', state: 'queued', mode: 'imageGen', type: 'image', imageUrl: '' },
        {
          id: '2',
          state: 'done',
          mode: 'imageGen',
          type: 'image',
          imageUrl: 'aipg-media://x.png',
        },
        { id: '3', state: 'generating', mode: 'imageGen', type: 'image', imageUrl: '' },
      ]

      const result = serializeGeneratedImages(images)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('2')
    })
  })

  describe('comfyInputsPerPreset', () => {
    it('strips base64 values from comfy inputs', () => {
      const inputs = {
        Preset1: {
          'Load Image.image': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
          'Sampler.steps': 20,
          'Prompt.text': 'a beautiful landscape',
        },
      }

      const result = serializeComfyInputs(inputs)
      expect(result['Preset1']).toBeDefined()
      expect(result['Preset1']!['Load Image.image']).toBeUndefined()
      expect(result['Preset1']!['Sampler.steps']).toBe(20)
      expect(result['Preset1']!['Prompt.text']).toBe('a beautiful landscape')
    })

    it('preserves aipg-media:// URLs in comfy inputs', () => {
      const inputs = {
        Preset1: {
          'Load Image.image': 'aipg-media://chat-uploads/test.png',
          'Sampler.steps': 20,
        },
      }

      const result = serializeComfyInputs(inputs)
      expect(result['Preset1']!['Load Image.image']).toBe('aipg-media://chat-uploads/test.png')
    })

    it('handles undefined preset entries', () => {
      const inputs: Record<string, Record<string, unknown> | undefined> = {
        Preset1: undefined,
        Preset2: { 'Sampler.steps': 10 },
      }

      const result = serializeComfyInputs(inputs)
      expect(result['Preset1']).toBeUndefined()
      expect(result['Preset2']!['Sampler.steps']).toBe(10)
    })
  })
})
