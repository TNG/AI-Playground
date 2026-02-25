import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isBase64ImageDataUri, isBase64DataUri, replaceBase64WithMediaUrl } from '@/lib/utils'

describe('isBase64ImageDataUri', () => {
  it('returns true for valid PNG data URI', () => {
    expect(isBase64ImageDataUri('data:image/png;base64,iVBOR=')).toBe(true)
  })

  it('returns true for valid JPEG data URI', () => {
    expect(isBase64ImageDataUri('data:image/jpeg;base64,/9j/4AAQ=')).toBe(true)
  })

  it('returns true for valid WebP data URI', () => {
    expect(isBase64ImageDataUri('data:image/webp;base64,UklGR=')).toBe(true)
  })

  it('returns false for aipg-media:// URLs', () => {
    expect(isBase64ImageDataUri('aipg-media://chat-uploads/test.png')).toBe(false)
  })

  it('returns false for http URLs', () => {
    expect(isBase64ImageDataUri('http://example.com/image.png')).toBe(false)
  })

  it('returns false for null/undefined', () => {
    expect(isBase64ImageDataUri(null)).toBe(false)
    expect(isBase64ImageDataUri(undefined)).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isBase64ImageDataUri('')).toBe(false)
  })

  it('returns false for non-image data URIs', () => {
    expect(isBase64ImageDataUri('data:text/plain;base64,aGVsbG8=')).toBe(false)
  })
})

describe('isBase64DataUri', () => {
  it('returns true for image data URI', () => {
    expect(isBase64DataUri('data:image/png;base64,iVBOR=')).toBe(true)
  })

  it('returns true for text data URI', () => {
    expect(isBase64DataUri('data:text/plain;base64,aGVsbG8=')).toBe(true)
  })

  it('returns false for regular URLs', () => {
    expect(isBase64DataUri('aipg-media://test.png')).toBe(false)
    expect(isBase64DataUri('http://example.com')).toBe(false)
  })

  it('returns false for null/undefined/empty', () => {
    expect(isBase64DataUri(null)).toBe(false)
    expect(isBase64DataUri(undefined)).toBe(false)
    expect(isBase64DataUri('')).toBe(false)
  })
})

describe('replaceBase64WithMediaUrl', () => {
  const mockSaveBase64AsMedia = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('window', {
      electronAPI: {
        saveBase64AsMedia: mockSaveBase64AsMedia,
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns non-base64 URLs unchanged', async () => {
    const url = 'aipg-media://chat-uploads/test.png'
    const result = await replaceBase64WithMediaUrl(url)
    expect(result).toBe(url)
    expect(mockSaveBase64AsMedia).not.toHaveBeenCalled()
  })

  it('returns http URLs unchanged', async () => {
    const url = 'http://example.com/image.png'
    const result = await replaceBase64WithMediaUrl(url)
    expect(result).toBe(url)
    expect(mockSaveBase64AsMedia).not.toHaveBeenCalled()
  })

  it('saves base64 image data URI and returns media URL', async () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
    const expectedMediaUrl = 'aipg-media://chat-uploads/uuid.png'
    mockSaveBase64AsMedia.mockResolvedValue(expectedMediaUrl)

    const result = await replaceBase64WithMediaUrl(dataUri)
    expect(result).toBe(expectedMediaUrl)
    expect(mockSaveBase64AsMedia).toHaveBeenCalledWith(dataUri)
  })

  it('returns base64 unchanged when electronAPI is not available', async () => {
    vi.stubGlobal('window', {})
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
    const result = await replaceBase64WithMediaUrl(dataUri)
    expect(result).toBe(dataUri)
  })
})
