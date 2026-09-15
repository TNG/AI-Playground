import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { findSourceImage } from '@/lib/findSourceImage'

const DATA_URI = 'data:image/png;base64,aGk='
const MEDIA_URL = 'aipg-media://generated/castle.png'

function userFile(data: string): ModelMessage {
  return {
    role: 'user',
    content: [{ type: 'file', mediaType: 'image/png', data }],
  }
}

function toolResult(toolName: string, output: unknown): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolName, output }],
  } as ModelMessage
}

describe('findSourceImage', () => {
  it('prefers an image on the current prompt over earlier conversation images', () => {
    const messages: ModelMessage[] = [
      toolResult('comfyUI', { images: [{ type: 'image', imageUrl: MEDIA_URL }] }),
      userFile(DATA_URI),
    ]
    expect(findSourceImage(messages)).toBe(DATA_URI)
  })

  it('reads an aipg-media URL from a comfyUI tool result', () => {
    expect(
      findSourceImage([
        toolResult('comfyUI', { images: [{ type: 'image', imageUrl: MEDIA_URL }] }),
      ]),
    ).toBe(MEDIA_URL)
  })

  it('unwraps a json tool-output envelope', () => {
    expect(
      findSourceImage([
        toolResult('comfyUiImageEdit', {
          type: 'json',
          value: { images: [{ type: 'image', imageUrl: MEDIA_URL }] },
        }),
      ]),
    ).toBe(MEDIA_URL)
  })

  it('reads unwrapped { images } from a media tool result', () => {
    expect(
      findSourceImage([toolResult('media', { images: [{ type: 'image', imageUrl: MEDIA_URL }] })]),
    ).toBe(MEDIA_URL)
  })

  it('ignores non-image media and unknown tools', () => {
    expect(
      findSourceImage([
        toolResult('bash', { images: [{ type: 'image', imageUrl: MEDIA_URL }] }),
        toolResult('comfyUI', { images: [{ type: 'video', videoUrl: 'aipg-media://v.mp4' }] }),
      ]),
    ).toBeNull()
  })
})
