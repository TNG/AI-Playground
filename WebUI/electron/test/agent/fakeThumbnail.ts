import type { ChatAnswerPayload } from '@/types/chatRequests'

/** How the fake window answers a 3D screenshot request: the JPEG it renders, or an error. */
export type FakeThumbnail = { base64: string } | { error: string }

export function thumbnailAnswer(requestId: string, thumbnail: FakeThumbnail): ChatAnswerPayload {
  return 'error' in thumbnail
    ? { requestId, error: thumbnail.error }
    : { requestId, result: { ...thumbnail, mime: 'image/jpeg' } }
}
