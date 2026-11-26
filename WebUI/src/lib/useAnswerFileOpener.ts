import { createAppError } from '@/assets/js/errors/appError'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useErrors } from '@/assets/js/store/errors'

/**
 * Opens a file an answer's writing tools created, through the harness session
 * that produced the answer; a failure surfaces as a toast through the sink.
 */
export function useAnswerFileOpener(harnessSessionId: () => string | undefined) {
  const errors = useErrors()
  const agentMode = useAgentMode()

  return async (filePath: string): Promise<void> => {
    // The message's own harness session, which is not always the store's open one.
    const sessionId = harnessSessionId() || agentMode.openSessionId
    if (!sessionId) return
    const result = await window.electronAPI.agentMode.sessionFileAction(sessionId, filePath, 'open')
    if (result.success) return
    errors.report(
      createAppError({
        category: 'file',
        code: 'answer/file-open-failed',
        userMessage: result.error ?? '',
        technicalMessage: `sessionFileAction failed for ${filePath}`,
        surface: 'toast',
        context: { sessionId, filePath },
      }),
    )
  }
}
