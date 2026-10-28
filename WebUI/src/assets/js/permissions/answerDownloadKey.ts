// Rides as the download's conversationKey, so main's permissions path needs no field of its own.
const ANSWER_DOWNLOAD_PREFIX = 'voice-answer:'

/** The download a voice Answer to an agent session needs: asked as that session's, from afar. */
export function answerDownloadKey(sessionId: string): string {
  return ANSWER_DOWNLOAD_PREFIX + sessionId
}

export function answerDownloadSession(conversationKey: string | undefined): string | null {
  return conversationKey?.startsWith(ANSWER_DOWNLOAD_PREFIX)
    ? conversationKey.slice(ANSWER_DOWNLOAD_PREFIX.length)
    : null
}
