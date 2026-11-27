import { createAppError, extractMessage } from '@/assets/js/errors/appError'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { fillTemplate } from '@/lib/fillTemplate'
import type { ArtifactAction } from '@/lib/turnArtifacts'

const LABEL_KEYS = {
  info: 'COM_OPEN_PARAMS',
  zoom: 'COM_ZOOM_IN',
  copy: 'COM_COPY',
  download: 'COM_DOWNLOAD',
  openFolder: 'COM_OPEN_LOCATION',
  sendToEdit: 'COM_POST_TO_IMAGE_EDIT',
  sendToVideo: 'COM_POST_TO_VIDEO',
  delete: 'ARTIFACT_DELETE',
} as const satisfies Record<ArtifactAction, string>

export function useArtifactActions() {
  const languages = useI18N().state
  const errors = useErrors()

  function label(action: ArtifactAction): string {
    return languages[LABEL_KEYS[action]]
  }

  function reportFailure(action: ArtifactAction, error: unknown): void {
    errors.report(
      createAppError({
        category: 'generation',
        code: `artifact/${action}-failed`,
        userMessage: fillTemplate(languages.ARTIFACT_ACTION_FAILED, {
          action: label(action),
          error: extractMessage(error),
        }),
        technicalMessage: extractMessage(error),
        surface: 'toast',
        cause: error,
      }),
    )
  }

  return { label, reportFailure }
}
