import { useErrors } from '@/assets/js/store/errors'
import type { ErrorSurface } from '@/assets/js/errors/types'

/** `updateLocalSettings` with every failure reported to the error sink; resolves whether it applied. */
export async function updateLocalSettingsReported(
  updates: Partial<LocalSettings>,
  surface: ErrorSurface = 'toast',
): Promise<boolean> {
  const errors = useErrors()
  const defaults = { category: 'setup', code: 'settings/update-failed', surface } as const
  try {
    const result = await window.electronAPI.updateLocalSettings(updates)
    if (result.success) return true
    errors.report(new Error(result.error), defaults)
  } catch (e) {
    errors.report(e, defaults)
  }
  return false
}
