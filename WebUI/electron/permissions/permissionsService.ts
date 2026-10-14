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
import { awaitUser, userWaitOwner } from '../kernel/userWait'

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
  /** The turn the download is for; it pauses while the user is asked. */
  conversationKey?: string
}

/**
 * A prompt names the turn it holds up so that turn gives up its Turn Queue place
 * while the user decides, and so the window can keep it out of sight until that
 * turn's session is open.
 */
export async function requestDownloadConsent(
  models: unknown[],
  options: RequestDownloadOptions = {},
): Promise<void> {
  const owner = options.conversationKey ?? userWaitOwner()
  const remote = await isRemoteTurnActive()
  const skipConfirmation = remote && (await hasPermissionGrant(REMOTE_DOWNLOAD_GRANT))
  const prompt = () =>
    requestPermissionsPrompt<void>(
      { kind: 'download', models, skipConfirmation },
      { onProgress: options.onProgress, conversationKey: owner },
    )
  await (skipConfirmation ? prompt() : awaitUser(owner, prompt))
}

export async function requestVramWarningConsent(req: {
  presetName: string
  message: string
}): Promise<boolean> {
  const key = vramWarningGrantKey(req.presetName)
  if (await hasPermissionGrant(key)) return true
  const owner = userWaitOwner()
  const answer = await awaitUser(owner, () =>
    requestPermissionsPrompt<{ confirmed: boolean; remember: boolean }>(
      { kind: 'vram-warning', presetName: req.presetName, message: req.message },
      { conversationKey: owner },
    ),
  )
  if (answer.confirmed && answer.remember) {
    await grantPermission(key, 'remember')
  }
  return answer.confirmed === true
}

async function isRemoteTurnActive(): Promise<boolean> {
  try {
    return (await requestPermissionsPrompt<boolean>({ kind: 'is-remote' })) === true
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
