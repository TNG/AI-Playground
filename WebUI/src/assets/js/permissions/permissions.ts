import { useDialogStore } from '../store/dialogs'
import { useHomeAgent } from '../store/homeAgent'
import {
  REMOTE_DOWNLOAD_GRANT,
  usePermissionGrants,
  vramWarningGrantKey,
} from '../store/permissionGrants'

/**
 * Permissions — the consent layer (§4.7 of docs/architecture-target.md). Every
 * prompt an inference or download path needs goes through here as a
 * request/response, never by reaching for the dialog store directly:
 *
 * - `requestDownload` — model-download consent. The desktop adapter is the
 *   shared download modal (which also runs the download); on a remote Home
 *   Agent turn the approval + progress move to the channel, unless the user
 *   pre-granted remote-turn downloads in Settings → Permissions.
 * - `requestVramWarning` — the gated high-memory / video-VRAM preset warning.
 *   "Do not show again" becomes a `remember` grant, so it is reviewable and
 *   revocable instead of a hidden localStorage flag.
 * - `notify` — one-way guidance (an install-needed notice whose Confirm opens
 *   the setup wizard). No grant, nothing to remember.
 *
 * There is no silent auto-allow: a grant exists only because the user ticked
 * "do not show again" or pre-filled it in settings. The dialog store stays the
 * desktop adapter's presentation; this module owns the decision. It moves to
 * main with the kernel in later steps. Parked follow-ups (homeAgent coupling,
 * `request(action)`, desktop remember, skipMemoryAlert) are in
 * docs/architecture-target.md §8.2.
 */

export { REMOTE_DOWNLOAD_GRANT, vramWarningGrantKey }

/**
 * Ask consent for downloading the given models and run the download.
 * Resolves when the download completed; rejects when it was declined or
 * failed. On a remote Home Agent turn the request is answered in-channel
 * (mirrored on the desktop); the `download:remote-turns` pre-grant skips the
 * in-channel question — gated models are still declined, progress still
 * streams to the channel.
 */
export function requestDownload(models: DownloadModelParam[]): Promise<void> {
  const homeAgent = useHomeAgent()
  if (homeAgent.isRemoteTurnActive()) {
    const skipConfirmation = usePermissionGrants().has(REMOTE_DOWNLOAD_GRANT)
    return homeAgent.handleRemoteModelDownload(models, { skipConfirmation })
  }
  return new Promise<void>((resolve, reject) => {
    useDialogStore().showDownloadDialog(models, resolve, reject)
  })
}

/**
 * The gated-preset (high-memory / video-VRAM) warning. Resolves `true` when
 * the user confirms (or had remembered/pre-granted the warning away), `false`
 * when they cancel. A confirmed "do not show again" records a `remember`
 * grant under `vram-warning:<presetName>`.
 */
export async function requestVramWarning(req: {
  presetName: string
  message: string
}): Promise<boolean> {
  const grants = usePermissionGrants()
  const key = vramWarningGrantKey(req.presetName)
  if (grants.has(key)) return true

  const dialogs = useDialogStore()
  return new Promise<boolean>((resolve) => {
    dialogs.showWarningDialog(
      req.message,
      (dontShowAgain) => {
        if (dontShowAgain) grants.grant(key, 'remember')
        resolve(true)
      },
      { dontShowAgainKey: req.presetName, onCancel: () => resolve(false) },
    )
  })
}

/** One-way guidance notice; `onConfirm` runs when the user clicks Confirm
 *  (e.g. opening the setup wizard to install what is missing). */
export function notify(message: string, onConfirm?: () => void): void {
  useDialogStore().showWarningDialog(message, () => onConfirm?.())
}
