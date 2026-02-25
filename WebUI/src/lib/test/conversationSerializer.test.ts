import { describe, it, expect } from 'vitest'

// Regex for base64 data URIs — matches the one used in conversations.ts serializer
const BASE64_DATA_URI_PATTERN = /^data:image\/[^;]+;base64,/

/**
 * Serialize function extracted from the conversations store for testing.
 * Strips base64 image data URIs from the state during serialization.
 */
function serializeConversations(state: unknown): string {
  return JSON.stringify(state, (_key, value) => {
    if (typeof value === 'string' && BASE64_DATA_URI_PATTERN.test(value)) {
      return ''
    }
    return value
  })
}

describe('conversations serializer', () => {
  it('preserves normal text messages', () => {
    const state = {
      conversationList: {
        '123': [
          {
            id: 'msg1',
            role: 'user',
            parts: [{ type: 'text', text: 'Hello!' }],
          },
        ],
      },
    }

    const result = JSON.parse(serializeConversations(state))
    expect(result.conversationList['123'][0].parts[0].text).toBe('Hello!')
  })

  it('strips base64 image data URIs from file parts', () => {
    const state = {
      conversationList: {
        '123': [
          {
            id: 'msg1',
            role: 'user',
            parts: [
              { type: 'text', text: 'Check this image' },
              {
                type: 'file',
                url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                mediaType: 'image/png',
              },
            ],
          },
        ],
      },
    }

    const result = JSON.parse(serializeConversations(state))
    const filePart = result.conversationList['123'][0].parts[1]
    expect(filePart.url).toBe('')
    expect(filePart.mediaType).toBe('image/png')
  })

  it('preserves aipg-media:// URLs in file parts', () => {
    const state = {
      conversationList: {
        '123': [
          {
            id: 'msg1',
            role: 'user',
            parts: [
              {
                type: 'file',
                url: 'aipg-media://chat-uploads/abc123.png',
                mediaType: 'image/png',
              },
            ],
          },
        ],
      },
    }

    const result = JSON.parse(serializeConversations(state))
    expect(result.conversationList['123'][0].parts[0].url).toBe(
      'aipg-media://chat-uploads/abc123.png',
    )
  })

  it('handles multiple conversations with mixed content', () => {
    const state = {
      conversationList: {
        '100': [
          {
            id: 'msg1',
            role: 'user',
            parts: [
              { type: 'text', text: 'First message' },
              {
                type: 'file',
                url: 'data:image/jpeg;base64,/9j/4AAQ',
                mediaType: 'image/jpeg',
              },
            ],
          },
        ],
        '200': [
          {
            id: 'msg2',
            role: 'user',
            parts: [
              {
                type: 'file',
                url: 'aipg-media://chat-uploads/saved.png',
                mediaType: 'image/png',
              },
            ],
          },
        ],
      },
    }

    const result = JSON.parse(serializeConversations(state))
    // Base64 should be stripped
    expect(result.conversationList['100'][0].parts[1].url).toBe('')
    // aipg-media:// should be preserved
    expect(result.conversationList['200'][0].parts[0].url).toBe(
      'aipg-media://chat-uploads/saved.png',
    )
  })

  it('strips base64 JPEG data URIs', () => {
    const state = {
      conversationList: {
        '123': [
          {
            id: 'msg1',
            role: 'user',
            parts: [
              {
                type: 'file',
                url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
                mediaType: 'image/jpeg',
              },
            ],
          },
        ],
      },
    }

    const result = JSON.parse(serializeConversations(state))
    expect(result.conversationList['123'][0].parts[0].url).toBe('')
  })
})
