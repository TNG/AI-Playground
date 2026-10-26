import {
  REMOTE_DOWNLOAD_GRANT,
  vramWarningGrantKey,
  type PermissionGrant,
  type PermissionGrantOrigin,
} from '@/types/permissionsIpc'
import {
  grantPermission,
  hasPermissionGrant,
  listPermissionGrants,
  migratePermissionGrants,
  revokePermissionGrant,
} from '../persist/grantsStore'
import { requestPermissionsPrompt } from './promptAdapter'
import { awaitUser, pauseForUser, userWaitOwner } from '../kernel/userWait'
import { downloadPauseReason } from './pauseReason'

/**
 * Permissions policy in main (architecture-target §4.7, step 13). Named verbs
 * stay. The renderer is the dialog / channel adapter — this module decides
 * whether a grant already answers, then asks the adapter to prompt (and, for
 * downloads, to run the download). No silent auto-allow: a skip of the
 * in-channel question exists only because the user pre-granted
 * `download:remote-turns`. A hidden window still has Chromium; without a
 * window a download cannot run even with a pre-grant (weights still go through
 * the shared download path).
 */

export type RequestDownloadOptions = {
  onProgress?: () => void
  /**
   * The turn the download is for; it pauses while the user is asked. `null` says
   * it is for no turn at all (a panel run), so it is never attributed to one.
   */
  conversationKey?: string | null
  /** The turn ended: drop the question, or stop waiting on its Model Download. */
  signal?: AbortSignal
}

/**
 * A prompt names the turn it holds up so that turn gives up its Turn Queue place
 * while the user decides, and so the window can keep it out of sight until that
 * turn's session is open. The pause ends with the answer: a turn then waiting on
 * its Model Download is not waiting on the user (docs/adr/0005), though its place
 * stays given up until it reclaims it for its next model call.
 */
export async function requestDownloadConsent(
  models: unknown[],
  options: RequestDownloadOptions = {},
): Promise<void> {
  const owner =
    options.conversationKey === null ? undefined : (options.conversationKey ?? userWaitOwner())
  const remote = await isRemoteTurnActive(owner)
  const skipConfirmation = remote && (await hasPermissionGrant(REMOTE_DOWNLOAD_GRANT))
  const answered = skipConfirmation ? () => {} : pauseForUser(owner, downloadPauseReason(models))
  try {
    await requestPermissionsPrompt<void>(
      { kind: 'download', models, skipConfirmation },
      {
        onProgress: options.onProgress,
        onAnswered: answered,
        conversationKey: owner,
        signal: options.signal,
      },
    )
  } finally {
    answered()
  }
}

export async function requestVramWarningConsent(req: {
  presetName: string
  message: string
}): Promise<boolean> {
  const key = vramWarningGrantKey(req.presetName)
  if (await hasPermissionGrant(key)) return true
  const owner = userWaitOwner()
  const answer = await awaitUser(
    owner,
    () =>
      requestPermissionsPrompt<{ confirmed: boolean; remember: boolean }>(
        { kind: 'vram-warning', presetName: req.presetName, message: req.message },
        { conversationKey: owner },
      ),
    { kind: 'vram-warning', summary: req.presetName },
  )
  if (answer.confirmed && answer.remember) {
    await grantPermission(key, 'remember')
  }
  return answer.confirmed === true
}

/** Whether a Home Agent remote turn would take this prompt; never one for an Agent Mode turn. */
async function isRemoteTurnActive(conversationKey: string | undefined): Promise<boolean> {
  try {
    return (
      (await requestPermissionsPrompt<boolean>({ kind: 'is-remote' }, { conversationKey })) === true
    )
  } catch {
    return false
  }
}

export async function listGrants(): Promise<PermissionGrant[]> {
  return listPermissionGrants()
}

export async function grant(key: string, origin: PermissionGrantOrigin): Promise<PermissionGrant> {
  return grantPermission(key, origin)
}

export async function revoke(key: string): Promise<void> {
  return revokePermissionGrant(key)
}

export async function migrateGrants(incoming: Record<string, PermissionGrant>): Promise<number> {
  return migratePermissionGrants(incoming)
}
